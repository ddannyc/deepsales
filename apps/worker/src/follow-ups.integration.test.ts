import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  aiExternalPlugin,
  aiExternalTool,
  aiToolAction,
  listInternalNotes,
  listAiFollowUpRules,
  aiFollowUpEvent,
  aiFollowUpRule,
  aiResponseRun,
  aiProviderAttempt,
  aiOperation,
  autoAssignConversation,
  bootstrapWorkspace,
  connectFacebookPages,
  claimOutboundMessage,
  closeConversation,
  conversation,
  conversationAssignment,
  createAiMember,
  createDatabase,
  createKnowledgeBase,
  customerPropertyDefinition,
  facebookMessagingWindow,
  getAiBudget,
  getCustomerProfile,
  message,
  member,
  processFacebookInbound,
  publishAiMemberConfig,
  saveAiFollowUpRule,
  setCustomerProperty,
  setMemberChannelAccess,
  takeOverConversation,
  updateAiMemberConfig,
  user,
} from '@deepsales/db'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Pool } from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Bindings } from './bindings'
import { handleAiResponseBatch, handleMaintenanceBatch, handleScheduled } from './index'
const connectionString = process.env.DATABASE_URL
const migrationsFolder = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../packages/db/drizzle',
)

describe.skipIf(!connectionString)('Proactive follow-up Worker flow', () => {
  const pool = new Pool({ connectionString })
  const db = createDatabase(pool)
  beforeAll(() => migrate(db, { migrationsFolder }))
  afterAll(() => pool.end())
  const rulesCreated: string[] = []
  afterEach(async () => {
    vi.unstubAllGlobals()
    if (rulesCreated.length)
      await db
        .update(aiFollowUpRule)
        .set({ enabled: false })
        .where(inArray(aiFollowUpRule.id, rulesCreated.splice(0)))
  })

  async function ready(timer: 'LAST_AI_REPLY' | 'AI_ASSIGNMENT', instructions = '') {
    const f = await createFixture(db)
    const identity = { workspaceId: f.workspaceId, memberId: f.aiMemberId, actingUserId: f.ownerId }
    await updateAiMemberConfig(db, { ...identity, replyWaitEnabled: false })
    await publishAiMemberConfig(db, { ...identity, providerConfigured: true })
    const rule = await saveAiFollowUpRule(db, {
      ...identity,
      id: crypto.randomUUID(),
      name: 'Helpful follow-up',
      enabled: true,
      timer,
      delaySeconds: 1,
      instructions,
      groups: [],
    })
    rulesCreated.push(rule.id)
    const received = await receiveContextInput(db, f, 'Hello, I need assistance.')
    await db
      .update(message)
      .set({ createdAt: new Date(Date.now() - 10000) })
      .where(eq(message.id, received.messageId))
    const assigned = await autoAssignConversation(db, {
      workspaceId: f.workspaceId,
      conversationId: received.conversationId,
    })
    if (!assigned.aiResponseRunId) throw new Error('Missing initial AI run')
    await db
      .update(aiResponseRun)
      .set({ state: 'CANCELLED' })
      .where(eq(aiResponseRun.id, assigned.aiResponseRunId))
    await db
      .update(aiFollowUpRule)
      .set({ effectiveAt: new Date(Date.now() - 20000) })
      .where(eq(aiFollowUpRule.id, rule.id))
    await db
      .update(conversationAssignment)
      .set({ createdAt: new Date(Date.now() - 7000) })
      .where(eq(conversationAssignment.conversationId, received.conversationId))
    const [reply] = await db
      .insert(message)
      .values({
        conversationId: received.conversationId,
        channelId: f.channelId,
        direction: 'OUTBOUND',
        senderType: 'MEMBER',
        senderMemberId: f.aiMemberId,
        messageType: 'TEXT',
        text: 'Here is the earlier answer.',
        deliveryState: 'SENT',
        createdAt: new Date(Date.now() - 6000),
        deliveryCompletedAt: new Date(Date.now() - 5000),
      })
      .returning()
    const outbound = vi.fn(),
      ai = vi.fn(),
      maintenance = vi.fn()
    const env = {
      ...environment(
        { send: outbound } as unknown as Queue,
        { send: maintenance } as unknown as Queue,
      ),
      AI_QUEUE: { send: ai } as unknown as Queue,
    }
    return {
      ...f,
      identity,
      rule,
      conversationId: received.conversationId,
      reply,
      outbound,
      ai,
      maintenance,
      env,
    }
  }
  async function trigger(f: Awaited<ReturnType<typeof ready>>) {
    const before = f.ai.mock.calls.length
    await handleMaintenanceBatch(
      batch(
        'maintenance',
        queueMessage({ v: 1, type: 'ai.follow-up', conversationId: f.conversationId }),
      ),
      f.env,
    )
    return (f.ai.mock.calls.length > before ? f.ai.mock.calls.at(-1)?.[0] : undefined) as
      | { v: 1; type: 'ai.response'; runId: string }
      | undefined
  }
  const answer = () =>
    Response.json({
      choices: [
        {
          message: {
            content: JSON.stringify({
              decision: 'ANSWER',
              response: 'Would you like any further assistance?',
              handoffReason: null,
              containsBusinessFacts: false,
              usedChunkIds: [],
            }),
          },
        },
      ],
    })

  it.each(['recover', 'exhaust', 'takeover', 'unknown'] as const)(
    'bounds safe read recovery and preserves successful receipts (%s)',
    async (mode) => {
      const f = await ready('LAST_AI_REPLY')
      const pluginId = crypto.randomUUID(),
        toolId = crypto.randomUUID()
      await db.insert(aiExternalPlugin).values({
        id: pluginId,
        workspaceId: f.workspaceId,
        memberId: f.aiMemberId,
        channelId: f.channelId,
        name: 'Status API',
        origin: 'https://tools.example.com',
        enabled: true,
        auth: 'NONE',
      })
      await db.insert(aiExternalTool).values({
        id: toolId,
        pluginId,
        name: 'Status',
        description: 'Read status',
        enabled: true,
        method: mode === 'unknown' ? 'POST' : 'GET',
        path: '/status',
        effect: mode === 'unknown' ? 'WRITE' : 'READ',
        fixed:
          mode === 'unknown'
            ? [{ name: 'recordId', location: 'body', value: 'configured-record' }]
            : [],
        output: [{ name: 'status', path: ['status'], type: 'string' }],
        objectScope:
          mode === 'unknown'
            ? JSON.stringify({
                policy: 'FIXED_CONFIG',
                description: 'Fixed configured support record.',
                targets: [{ name: 'recordId', location: 'body' }],
              })
            : '',
      })
      await db
        .update(aiFollowUpRule)
        .set({ instructions: `[[tool:record]] [[tool:external:${toolId}]]` })
        .where(eq(aiFollowUpRule.id, f.rule.id))
      const job = await trigger(f)
      if (!job) throw new Error('Missing follow-up')
      const external = vi.fn(async () => {
        if (mode === 'unknown') throw new Error('Response lost after dispatch')
        if (external.mock.calls.length === 1 || mode === 'exhaust')
          return Response.json({}, { status: 503 })
        if (mode === 'takeover')
          await takeOverConversation(db, {
            workspaceId: f.workspaceId,
            conversationId: f.conversationId,
            actingUserId: f.ownerId,
          })
        return Response.json({ status: 'ready' })
      })
      vi.stubGlobal('fetch', async (url: unknown, init?: RequestInit) => {
        if (String(url).startsWith('https://tools.example.com')) return external()
        if (String(url).endsWith('/embeddings'))
          return Response.json({ data: [{ index: 0, embedding: vector() }] })
        const prompt = JSON.parse(String(init?.body))
          .messages.map((item: { content: string }) => item.content)
          .join('\n') as string
        const results = JSON.parse(
          prompt.match(/EXTERNAL_RESULT_VALUES: ([^\n]+)/)?.[1] ?? '[]',
        ) as {
          actionId: string
        }[]
        return Response.json({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  decision: 'ANSWER',
                  response: results.length ? 'Status: ready.' : 'Checking status.',
                  handoffReason: null,
                  containsBusinessFacts: results.length > 0,
                  usedChunkIds: [],
                  ...(results.length
                    ? { usedToolActionIds: results.map((item) => item.actionId) }
                    : {
                        toolCalls: [
                          {
                            tool: 'record',
                            arguments: { text: 'Follow-up requested a status check.' },
                          },
                          { tool: 'external', arguments: { definitionId: toolId, values: {} } },
                        ],
                      }),
                }),
              },
            },
          ],
        })
      })
      const env = { ...f.env, AI_TOOL_ALLOWED_ORIGINS: '["https://tools.example.com"]' }
      const queued = queueMessage(job)
      await handleAiResponseBatch(batch('ai', queued), env)
      if (mode === 'unknown') {
        await handleAiResponseBatch(batch('ai', queueMessage(job)), env)
        expect(queued.retry).not.toHaveBeenCalled()
        expect(f.outbound).not.toHaveBeenCalled()
        expect(external).toHaveBeenCalledOnce()
        expect(
          await db.select().from(aiToolAction).where(eq(aiToolAction.runId, job.runId)),
        ).toMatchObject(
          expect.arrayContaining([
            expect.objectContaining({ ordinal: 0, state: 'SUCCEEDED', attemptCount: 1 }),
            expect.objectContaining({ ordinal: 1, state: 'UNKNOWN', attemptCount: 1 }),
          ]),
        )
        const [operation] = await db.select().from(aiOperation).where(eq(aiOperation.id, job.runId))
        expect(operation).toMatchObject({ state: 'UNKNOWN', charged: true })
        expect(
          (
            await listInternalNotes(db, {
              workspaceId: f.workspaceId,
              userId: f.ownerId,
              conversationId: f.conversationId,
            })
          ).notes,
        ).toHaveLength(1)
        const history = await listAiFollowUpRules(db, f.identity)
        expect(history.events.find((event) => event.id === job.runId)).toMatchObject({
          partialCompletion: true,
          operationState: 'UNKNOWN',
        })
        return
      }
      expect(queued.retry).toHaveBeenCalledOnce()
      expect(f.outbound).not.toHaveBeenCalled()
      const before = await db.select().from(aiToolAction).where(eq(aiToolAction.runId, job.runId))
      expect(before.map((action) => [action.ordinal, action.state])).toEqual(
        expect.arrayContaining([
          [0, 'SUCCEEDED'],
          [1, 'FAILED'],
        ]),
      )
      // Test clock advances only the durable backoff; action/once/charge identities stay fixed.
      await db.execute(
        sql`update ai_tool_action set retry_at = ${new Date(0)} where run_id = ${job.runId} and retry_at is not null`,
      )
      await handleAiResponseBatch(batch('ai', queueMessage(job)), env)
      await handleAiResponseBatch(batch('ai', queueMessage(job)), env)
      const after = await db.select().from(aiToolAction).where(eq(aiToolAction.runId, job.runId))
      expect(after.map((action) => action.id).sort()).toEqual(
        before.map((action) => action.id).sort(),
      )
      expect(after.reduce((count, action) => count + action.attemptCount, 0)).toBe(3)
      expect(after.every((action) => action.state === 'SUCCEEDED')).toBe(mode !== 'exhaust')
      expect(external).toHaveBeenCalledTimes(2)
      expect(
        (
          await listInternalNotes(db, {
            workspaceId: f.workspaceId,
            userId: f.ownerId,
            conversationId: f.conversationId,
          })
        ).notes,
      ).toHaveLength(1)
      expect(f.outbound).toHaveBeenCalledTimes(mode === 'recover' ? 1 : 0)
      const [run] = await db.select().from(aiResponseRun).where(eq(aiResponseRun.id, job.runId))
      expect(run.state).toBe(
        mode === 'recover' ? 'COMPLETED' : mode === 'exhaust' ? 'FAILED' : 'CANCELLED',
      )
      if (mode === 'takeover') {
        const history = await listAiFollowUpRules(db, f.identity)
        expect(history.events.find((event) => event.id === job.runId)).toMatchObject({
          partialCompletion: true,
          actions: expect.arrayContaining([
            {
              id: expect.any(String),
              tool: 'record',
              state: 'SUCCEEDED',
              failureCode: null,
              retryAt: null,
              attemptCount: 1,
            },
          ]),
        })
        expect(JSON.stringify(history.events)).not.toContain('Follow-up requested a status check.')
      }
      expect(
        (await getAiBudget(db, { workspaceId: f.workspaceId, actingUserId: f.ownerId })).used,
      ).toBe(1)
      expect(
        await db
          .select()
          .from(aiFollowUpEvent)
          .where(eq(aiFollowUpEvent.conversationId, f.conversationId)),
      ).toHaveLength(1)
    },
  )
  it('rejects unknown variable and unavailable tool references when saving an immediate rule', async () => {
    const f = await ready('LAST_AI_REPLY')
    for (const instructions of [
      '{{customer.unknown}}',
      '[[tool:unknown]]',
      `[[tool:external:${crypto.randomUUID()}]]`,
    ]) {
      await expect(
        saveAiFollowUpRule(db, {
          ...f.identity,
          id: crypto.randomUUID(),
          name: 'Invalid references',
          enabled: false,
          timer: 'LAST_AI_REPLY',
          delaySeconds: 1,
          instructions,
          groups: [],
        }),
      ).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' })
    }
  })
  it('resolves rule-only variables and executes its authorized action once before a follow-up message', async () => {
    const f = await ready(
      'LAST_AI_REPLY',
      'Use {{system.timeZone}} and {{customer.email}}. [[tool:record]]',
    )
    const job = await trigger(f)
    if (!job) throw new Error('Follow-up was not scheduled')
    const provider = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (String(url).endsWith('/embeddings'))
        return Response.json({ data: [{ index: 0, embedding: vector() }] })
      const prompt = JSON.parse(String(init?.body)).messages[1].content as string
      const values = JSON.parse(
        /<variable_values>([\s\S]*?)<\/variable_values>/.exec(prompt)?.[1] ?? '{}',
      )
      expect(values).toMatchObject({ 'system.timeZone': 'UTC', 'customer.email': null })
      return Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                decision: 'ANSWER',
                response: 'Would you like further assistance?',
                handoffReason: null,
                containsBusinessFacts: false,
                usedChunkIds: [],
                toolCalls: [{ tool: 'record', arguments: { text: 'Follow-up observation.' } }],
              }),
            },
          },
        ],
      })
    })
    vi.stubGlobal('fetch', provider)
    await handleAiResponseBatch(batch('ai', queueMessage(job)), f.env)
    await handleAiResponseBatch(batch('ai', queueMessage(job)), f.env)
    const [run] = await db.select().from(aiResponseRun).where(eq(aiResponseRun.id, job.runId))
    expect(run).toMatchObject({
      state: 'COMPLETED',
      variableInput: { values: { 'system.timeZone': 'UTC', 'customer.email': null } },
    })
    expect(
      (
        await listInternalNotes(db, {
          workspaceId: f.workspaceId,
          userId: f.ownerId,
          conversationId: f.conversationId,
        })
      ).notes,
    ).toHaveLength(1)
    expect(
      await db.select().from(aiToolAction).where(eq(aiToolAction.operationId, job.runId)),
    ).toMatchObject([{ ordinal: 0, state: 'SUCCEEDED', tool: 'record' }])
    expect(f.outbound).toHaveBeenCalledOnce()
    expect(
      (await getAiBudget(db, { workspaceId: f.workspaceId, actingUserId: f.ownerId })).used,
    ).toBe(1)
  })
  it('withholds changed rule-only variable sources without creating an ordinary recovery reply', async () => {
    const f = await ready('LAST_AI_REPLY', 'Use {{customer.properties}}. [[tool:record]]')
    const [definition] = await db
      .insert(customerPropertyDefinition)
      .values({
        workspaceId: f.workspaceId,
        name: 'Context preference',
        level: 'CUSTOMER',
        type: 'TEXT',
      })
      .returning()
    const profile = await getCustomerProfile(db, {
      workspaceId: f.workspaceId,
      conversationId: f.conversationId,
      userId: f.ownerId,
    })
    const property = {
      workspaceId: f.workspaceId,
      conversationId: f.conversationId,
      userId: f.ownerId,
      expectedCustomerId: profile.customer.id,
      definitionId: definition.id,
      allowAutomaticUpdate: false,
    }
    await setCustomerProperty(db, { ...property, expectedRevision: 0, value: 'email' })
    const job = await trigger(f)
    if (!job) throw new Error('Missing follow-up')
    const before = await db
      .select({ id: aiResponseRun.id })
      .from(aiResponseRun)
      .where(eq(aiResponseRun.conversationId, f.conversationId))
    vi.stubGlobal('fetch', async (url: unknown, init?: RequestInit) => {
      if (String(url).endsWith('/embeddings'))
        return Response.json({ data: [{ index: 0, embedding: vector() }] })
      expect(String(init?.body)).toContain('email')
      await setCustomerProperty(db, { ...property, expectedRevision: 1, value: 'phone' })
      return Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                decision: 'ANSWER',
                response: 'A tailored follow-up.',
                handoffReason: null,
                containsBusinessFacts: false,
                usedChunkIds: [],
                toolCalls: [{ tool: 'record', arguments: { text: 'Stale source' } }],
              }),
            },
          },
        ],
      })
    })
    await handleAiResponseBatch(batch('ai', queueMessage(job)), f.env)
    expect(f.outbound).not.toHaveBeenCalled()
    expect(
      await db
        .select({ id: aiResponseRun.id })
        .from(aiResponseRun)
        .where(eq(aiResponseRun.conversationId, f.conversationId)),
    ).toEqual(before)
    const [run] = await db.select().from(aiResponseRun).where(eq(aiResponseRun.id, job.runId))
    expect(run).toMatchObject({
      state: 'CANCELLED',
      cancellationReason: 'PROPERTY_COLLECTION_CHANGED',
    })
    expect(await db.select().from(aiToolAction).where(eq(aiToolAction.runId, job.runId))).toEqual(
      [],
    )
    expect(
      (
        await listInternalNotes(db, {
          workspaceId: f.workspaceId,
          userId: f.ownerId,
          conversationId: f.conversationId,
        })
      ).notes,
    ).toHaveLength(0)
  })
  it.each(['LAST_AI_REPLY', 'AI_ASSIGNMENT'] as const)(
    'authorizes one independent %s event and deduplicates scheduling and delivery',
    async (timer) => {
      const f = await ready(timer)
      await handleScheduled(f.env)
      expect(
        f.maintenance.mock.calls.some(
          ([job]) => job.type === 'ai.follow-up' && job.conversationId === f.conversationId,
        ),
      ).toBe(true)
      f.ai.mockClear()
      f.outbound.mockClear()
      await Promise.all([trigger(f), trigger(f)])
      expect(f.ai).toHaveBeenCalledOnce()
      const job = f.ai.mock.calls[0][0]
      const provider = vi.fn(async (url: unknown, init?: RequestInit) => {
        if (String(url).endsWith('/embeddings'))
          return Response.json({ data: [{ index: 0, embedding: vector() }] })
        expect(String(init?.body)).toContain('independently authorized proactive follow-up event')
        expect(String(init?.body)).toContain('Here is the earlier answer.')
        return answer()
      })
      vi.stubGlobal('fetch', provider)
      await handleAiResponseBatch(batch('ai', queueMessage(job)), f.env)
      await handleAiResponseBatch(batch('ai', queueMessage(job)), f.env)
      const rows = await db
        .select()
        .from(aiFollowUpEvent)
        .where(eq(aiFollowUpEvent.conversationId, f.conversationId))
      expect(rows).toHaveLength(1)
      expect(
        await db
          .select({ state: aiResponseRun.state })
          .from(aiResponseRun)
          .where(eq(aiResponseRun.id, rows[0].id)),
      ).toEqual([{ state: 'COMPLETED' }])
      expect(f.outbound).toHaveBeenCalledOnce()
      expect(
        await db
          .select()
          .from(message)
          .where(
            and(eq(message.conversationId, f.conversationId), eq(message.direction, 'INBOUND')),
          ),
      ).toHaveLength(1)
      expect(
        (await getAiBudget(db, { workspaceId: f.workspaceId, actingUserId: f.ownerId })).used,
      ).toBe(1)
      expect(
        await db
          .select({ kind: aiOperation.kind })
          .from(aiOperation)
          .where(eq(aiOperation.id, rows[0].id)),
      ).toEqual([{ kind: 'FOLLOW_UP' }])
    },
  )
  it.each(['input', 'takeover', 'rule', 'stop', 'property', 'revoke', 'window'] as const)(
    'cancels uncommitted follow-up after %s changes during generation',
    async (change) => {
      const f = await ready('LAST_AI_REPLY')
      const [definition] = await db
        .insert(customerPropertyDefinition)
        .values({
          workspaceId: f.workspaceId,
          name: 'Follow-up eligibility',
          level: 'CONVERSATION',
          type: 'TEXT',
        })
        .returning()
      const profile = await getCustomerProfile(db, {
        workspaceId: f.workspaceId,
        conversationId: f.conversationId,
        userId: f.ownerId,
      })
      const property = {
        workspaceId: f.workspaceId,
        conversationId: f.conversationId,
        userId: f.ownerId,
        expectedCustomerId: profile.customer.id,
        definitionId: definition.id,
        allowAutomaticUpdate: false,
      }
      await setCustomerProperty(db, { ...property, expectedRevision: 0, value: 'yes' })
      await db
        .update(aiFollowUpRule)
        .set({ groups: [[{ kind: 'PROPERTY', definitionId: definition.id, value: 'yes' }]] })
        .where(eq(aiFollowUpRule.id, f.rule.id))
      const job = await trigger(f)
      if (!job) throw new Error('Follow-up was not scheduled')
      const provider = vi.fn(async (url: unknown) => {
        if (String(url).endsWith('/embeddings'))
          return Response.json({ data: [{ index: 0, embedding: vector() }] })
        if (change === 'input') await receiveContextInput(db, f, 'A new question.')
        if (change === 'takeover')
          await takeOverConversation(db, {
            workspaceId: f.workspaceId,
            conversationId: f.conversationId,
            actingUserId: f.ownerId,
          })
        if (change === 'rule')
          await saveAiFollowUpRule(db, {
            ...f.identity,
            ...f.rule,
            revision: f.rule.revision,
            instructions: 'Changed requirement.',
          })
        if (change === 'stop')
          await db
            .update(conversation)
            .set({ aiStopState: { reason: 'CONDITION', stoppedAt: new Date().toISOString() } })
            .where(eq(conversation.id, f.conversationId))
        if (change === 'property')
          await setCustomerProperty(db, { ...property, expectedRevision: 1, value: 'no' })
        if (change === 'revoke') await setMemberChannelAccess(db, { ...f.identity, channelIds: [] })
        if (change === 'window')
          await db
            .update(facebookMessagingWindow)
            .set({ eligibleUntil: new Date(0) })
            .where(eq(facebookMessagingWindow.channelIdentityId, profile.currentIdentityId))
        return answer()
      })
      vi.stubGlobal('fetch', provider)
      await handleAiResponseBatch(batch('ai', queueMessage(job)), f.env)
      expect(
        await db
          .select({ state: aiResponseRun.state, outputMessageId: aiResponseRun.outputMessageId })
          .from(aiResponseRun)
          .where(eq(aiResponseRun.id, job.runId)),
      ).toEqual([{ state: 'CANCELLED', outputMessageId: null }])
      expect(f.outbound).not.toHaveBeenCalled()
      expect(
        await db
          .select()
          .from(aiFollowUpEvent)
          .where(eq(aiFollowUpEvent.conversationId, f.conversationId)),
      ).toHaveLength(1)
    },
  )

  it('does not use old anchors after enable, edit or human reassignment', async () => {
    const f = await ready('LAST_AI_REPLY')
    await db
      .update(aiFollowUpRule)
      .set({ effectiveAt: new Date() })
      .where(eq(aiFollowUpRule.id, f.rule.id))
    expect(await trigger(f)).toBeUndefined()
    await db
      .update(aiFollowUpRule)
      .set({ effectiveAt: new Date(Date.now() - 20000) })
      .where(eq(aiFollowUpRule.id, f.rule.id))
    await db.update(message).set({ deliveryState: 'PENDING' }).where(eq(message.id, f.reply.id))
    expect(await trigger(f)).toBeUndefined()
    await db.update(message).set({ deliveryState: 'SENT' }).where(eq(message.id, f.reply.id))
    await db
      .update(conversationAssignment)
      .set({ createdAt: new Date() })
      .where(eq(conversationAssignment.conversationId, f.conversationId))
    expect(await trigger(f)).toBeUndefined()
    expect(
      await db
        .select()
        .from(aiFollowUpEvent)
        .where(eq(aiFollowUpEvent.conversationId, f.conversationId)),
    ).toHaveLength(0)
  })

  it.each(['retry', 'unknown', 'invalid'] as const)(
    'retains the same one-shot event after %s generation results',
    async (mode) => {
      const f = await ready('LAST_AI_REPLY')
      const job = await trigger(f)
      if (!job) throw new Error('Missing follow-up')
      let calls = 0
      vi.stubGlobal('fetch', async (url: unknown) => {
        if (String(url).endsWith('/embeddings'))
          return Response.json({ data: [{ index: 0, embedding: vector() }] })
        calls++
        if (mode === 'unknown') throw new Error('Network result unknown')
        if (mode === 'invalid')
          return Response.json({ choices: [{ message: { content: '{broken' } }] })
        return calls === 1 ? Response.json({}, { status: 503 }) : answer()
      })
      const queued = queueMessage(job)
      await handleAiResponseBatch(batch('ai', queued), f.env)
      if (mode === 'retry') {
        expect(queued.retry).toHaveBeenCalledOnce()
        await db
          .update(aiProviderAttempt)
          .set({ retryAt: new Date(0) })
          .where(eq(aiProviderAttempt.operationId, job.runId))
        await handleAiResponseBatch(batch('ai', queueMessage(job)), f.env)
        expect(
          await db
            .select({ state: aiResponseRun.state })
            .from(aiResponseRun)
            .where(eq(aiResponseRun.id, job.runId)),
        ).toEqual([{ state: 'COMPLETED' }])
        expect(f.outbound).toHaveBeenCalledOnce()
        expect(calls).toBe(2)
      } else {
        const [run] = await db.select().from(aiResponseRun).where(eq(aiResponseRun.id, job.runId))
        expect(run.state).toBe(mode === 'invalid' ? 'FAILED' : 'HANDOFF')
        if (mode === 'unknown')
          expect(
            await db
              .select({ state: aiOperation.state })
              .from(aiOperation)
              .where(eq(aiOperation.id, job.runId)),
          ).toEqual([{ state: 'UNKNOWN' }])
      }
      await trigger(f)
      expect(
        await db
          .select()
          .from(aiFollowUpEvent)
          .where(eq(aiFollowUpEvent.conversationId, f.conversationId)),
      ).toHaveLength(1)
      expect(
        (await getAiBudget(db, { workspaceId: f.workspaceId, actingUserId: f.ownerId })).used,
      ).toBe(1)
    },
  )

  it('serializes simultaneous rules and resets the later reply timer only after confirmed sending', async () => {
    const f = await ready('LAST_AI_REPLY')
    const second = await saveAiFollowUpRule(db, {
      ...f.identity,
      id: crypto.randomUUID(),
      name: 'Second check-in',
      enabled: true,
      timer: 'LAST_AI_REPLY',
      delaySeconds: 1,
      instructions: '',
      groups: [],
    })
    rulesCreated.push(second.id)
    await db
      .update(aiFollowUpRule)
      .set({ effectiveAt: new Date(Date.now() - 20000) })
      .where(eq(aiFollowUpRule.id, second.id))
    const job = await trigger(f)
    if (!job) throw new Error('Missing first event')
    vi.stubGlobal('fetch', async (url: unknown) =>
      String(url).endsWith('/embeddings')
        ? Response.json({ data: [{ index: 0, embedding: vector() }] })
        : answer(),
    )
    await handleAiResponseBatch(batch('ai', queueMessage(job)), f.env)
    await trigger(f)
    expect(
      await db
        .select()
        .from(aiFollowUpEvent)
        .where(eq(aiFollowUpEvent.conversationId, f.conversationId)),
    ).toHaveLength(1)
    const [run] = await db.select().from(aiResponseRun).where(eq(aiResponseRun.id, job.runId))
    if (!run.outputMessageId) throw new Error('Missing committed reply')
    await db
      .update(message)
      .set({ deliveryState: 'SENT', deliveryCompletedAt: new Date() })
      .where(eq(message.id, run.outputMessageId))
    await trigger(f)
    expect(
      await db
        .select()
        .from(aiFollowUpEvent)
        .where(eq(aiFollowUpEvent.conversationId, f.conversationId)),
    ).toHaveLength(1)
    await new Promise((resolve) => setTimeout(resolve, 1100))
    await trigger(f)
    const events = await db
      .select()
      .from(aiFollowUpEvent)
      .where(eq(aiFollowUpEvent.conversationId, f.conversationId))
    expect(events.map((event) => event.ruleId)).toEqual([f.rule.id, second.id])
  })
  it('keeps a committed follow-up deliverable after takeover and gives a new Conversation a fresh chance', async () => {
    const f = await ready('LAST_AI_REPLY')
    const job = await trigger(f)
    if (!job) throw new Error('Missing follow-up')
    vi.stubGlobal('fetch', async (url: unknown) =>
      String(url).endsWith('/embeddings')
        ? Response.json({ data: [{ index: 0, embedding: vector() }] })
        : answer(),
    )
    await handleAiResponseBatch(batch('ai', queueMessage(job)), f.env)
    const [run] = await db.select().from(aiResponseRun).where(eq(aiResponseRun.id, job.runId))
    if (!run.outputMessageId) throw new Error('Missing outbound')
    await takeOverConversation(db, {
      workspaceId: f.workspaceId,
      conversationId: f.conversationId,
      actingUserId: f.ownerId,
    })
    expect(await claimOutboundMessage(db, { messageId: run.outputMessageId })).toMatchObject({
      id: run.outputMessageId,
    })
    await saveAiFollowUpRule(db, { ...f.identity, ...f.rule, enabled: false, revision: 1 })
    const enabled = await saveAiFollowUpRule(db, {
      ...f.identity,
      ...f.rule,
      enabled: true,
      revision: 2,
    })
    expect(enabled.revision).toBe(3)
    expect(
      await db.select().from(aiFollowUpEvent).where(eq(aiFollowUpEvent.ruleId, f.rule.id)),
    ).toHaveLength(1)
    await closeConversation(db, {
      workspaceId: f.workspaceId,
      conversationId: f.conversationId,
      actingUserId: f.ownerId,
    })
    const received = await receiveContextInput(db, f, 'New conversation.')
    await db
      .update(message)
      .set({ createdAt: new Date(Date.now() - 10000) })
      .where(eq(message.id, received.messageId))
    const assigned = await autoAssignConversation(db, {
      workspaceId: f.workspaceId,
      conversationId: received.conversationId,
    })
    if (!assigned.aiResponseRunId) throw new Error('Missing new run')
    await db
      .update(aiResponseRun)
      .set({ state: 'CANCELLED' })
      .where(eq(aiResponseRun.id, assigned.aiResponseRunId))
    await db
      .update(aiFollowUpRule)
      .set({ effectiveAt: new Date(Date.now() - 20000) })
      .where(eq(aiFollowUpRule.id, f.rule.id))
    await db
      .update(conversationAssignment)
      .set({ createdAt: new Date(Date.now() - 7000) })
      .where(eq(conversationAssignment.conversationId, received.conversationId))
    await db.insert(message).values({
      conversationId: received.conversationId,
      channelId: f.channelId,
      direction: 'OUTBOUND',
      senderType: 'MEMBER',
      senderMemberId: f.aiMemberId,
      messageType: 'TEXT',
      text: 'A new answer.',
      deliveryState: 'SENT',
      createdAt: new Date(Date.now() - 6000),
      deliveryCompletedAt: new Date(Date.now() - 5000),
    })
    const next = await trigger({ ...f, conversationId: received.conversationId })
    expect(next?.runId).toBeTruthy()
    expect(next?.runId).not.toBe(job.runId)
    expect(
      await db.select().from(aiFollowUpEvent).where(eq(aiFollowUpEvent.ruleId, f.rule.id)),
    ).toHaveLength(2)
  })
  it('continues beyond 100 nonmatching candidates and deduplicates repeated scan cursors', async () => {
    const f = await ready('AI_ASSIGNMENT')
    await db.update(member).set({ maxActiveConversations: 200 }).where(eq(member.id, f.aiMemberId))
    const ids = [f.conversationId]
    for (let index = 0; index < 100; index++) {
      const received = await receiveContextInput(
        db,
        { ...f, ownerId: `${f.ownerId}-${index}` },
        'Hello.',
      )
      await db
        .update(message)
        .set({ createdAt: new Date(Date.now() - 10000) })
        .where(eq(message.id, received.messageId))
      const assigned = await autoAssignConversation(db, {
        workspaceId: f.workspaceId,
        conversationId: received.conversationId,
      })
      if (!assigned.aiResponseRunId) throw new Error('Missing fixture assignment')
      ids.push(received.conversationId)
    }
    await db
      .update(aiResponseRun)
      .set({ state: 'CANCELLED' })
      .where(inArray(aiResponseRun.conversationId, ids))
    await db
      .update(conversationAssignment)
      .set({ createdAt: new Date(Date.now() - 7000) })
      .where(inArray(conversationAssignment.conversationId, ids))
    const last = ids.sort().at(-1)
    if (!last) throw new Error('Missing candidate fixture')
    const [definition] = await db
      .insert(customerPropertyDefinition)
      .values({
        workspaceId: f.workspaceId,
        level: 'CONVERSATION',
        name: 'Follow-up match',
        type: 'TEXT',
      })
      .returning()
    const profile = await getCustomerProfile(db, {
      workspaceId: f.workspaceId,
      conversationId: last,
      userId: f.ownerId,
    })
    await setCustomerProperty(db, {
      workspaceId: f.workspaceId,
      conversationId: last,
      userId: f.ownerId,
      expectedCustomerId: profile.customer.id,
      definitionId: definition.id,
      allowAutomaticUpdate: false,
      expectedRevision: 0,
      value: 'yes',
    })
    await db
      .update(aiFollowUpRule)
      .set({ groups: [[{ kind: 'PROPERTY', definitionId: definition.id, value: 'yes' }]] })
      .where(eq(aiFollowUpRule.id, f.rule.id))
    await handleScheduled(f.env)
    const continuation = f.maintenance.mock.calls
      .map(([job]) => job)
      .find((job) => job.type === 'ai.follow-up.scan')
    expect(continuation).toBeTruthy()
    f.ai.mockClear()
    f.maintenance.mockClear()
    for (let repeat = 0; repeat < 2; repeat++)
      await handleMaintenanceBatch(batch('maintenance', queueMessage(continuation)), f.env)
    const jobs = f.maintenance.mock.calls
      .map(([job]) => job)
      .filter((job) => job.type === 'ai.follow-up')
    expect(jobs.some((job) => job.conversationId === last)).toBe(true)
    for (const job of jobs)
      await handleMaintenanceBatch(batch('maintenance', queueMessage(job)), f.env)
    expect(f.ai).toHaveBeenCalledOnce()
    expect(
      await db.select().from(aiFollowUpEvent).where(eq(aiFollowUpEvent.ruleId, f.rule.id)),
    ).toHaveLength(1)
  }, 90_000)
})

async function createFixture(db: ReturnType<typeof createDatabase>) {
  const ownerId = crypto.randomUUID()
  const pageId = crypto.randomUUID()
  await db.insert(user).values({ id: ownerId, name: 'Owner', email: `${ownerId}@example.com` })
  const workspace = await bootstrapWorkspace(db, {
    userId: ownerId,
    userName: 'Owner',
    name: `AI response worker ${ownerId}`,
  })
  const [channel] = await connectFacebookPages(db, {
    workspaceId: workspace.id,
    actingUserId: ownerId,
    pages: [
      {
        pageId,
        displayName: 'Support',
        encryptedPageAccessToken: 'cipher',
        tokenIv: 'iv',
        tokenKeyVersion: 'v1',
      },
    ],
  })
  if (!channel) throw new Error('Channel was not created')
  const base = await createKnowledgeBase(db, {
    workspaceId: workspace.id,
    createdByUserId: ownerId,
    name: 'Support facts',
  })
  const ai = await createAiMember(db, {
    workspaceId: workspace.id,
    createdByUserId: ownerId,
    displayName: 'Support AI',
    channelIds: [channel.id],
  })
  await updateAiMemberConfig(db, {
    workspaceId: workspace.id,
    memberId: ai.id,
    actingUserId: ownerId,
    instructions: 'Answer from support facts.',
    responseLanguage: 'English',
    knowledgeBaseId: base.id,
  })
  await publishAiMemberConfig(db, {
    workspaceId: workspace.id,
    memberId: ai.id,
    actingUserId: ownerId,
    providerConfigured: true,
  })
  return {
    ownerId,
    workspaceId: workspace.id,
    pageId,
    knowledgeBaseId: base.id,
    aiMemberId: ai.id,
    channelId: channel.id,
  }
}

async function receiveContextInput(
  db: ReturnType<typeof createDatabase>,
  fixture: Awaited<ReturnType<typeof createFixture>>,
  text: string,
) {
  const receivedAt = new Date(Date.now() - 10_000)
  const result = await processFacebookInbound(db, {
    ingressId: crypto.randomUUID(),
    pageId: fixture.pageId,
    externalUserId: `customer-${fixture.ownerId}`,
    externalMessageId: crypto.randomUUID(),
    text,
    providerSentAt: receivedAt,
    receivedAt,
    payloadSha256: 'a'.repeat(64),
    eventFragment: {},
  })
  if (result.kind !== 'created') throw new Error('Inbound was not created')
  return result
}

function environment(outboundQueue?: Queue, maintenanceQueue?: Queue): Bindings {
  return {
    APP_URL: 'http://localhost:8787',
    AUTH_RATE_LIMITER: {} as RateLimit,
    BETTER_AUTH_SECRET: 'test-only-secret-that-is-at-least-32-characters',
    HYPERDRIVE: { connectionString } as Hyperdrive,
    META_APP_ID: 'app-1',
    META_APP_SECRET: 'app-secret',
    META_VERIFY_TOKEN: 'verify-token',
    META_GRAPH_API_VERSION: 'v26.0',
    TOKEN_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    AI_API_KEY: 'test-key',
    AI_BASE_URL: 'http://ai.test/v1',
    EMBEDDING_PROVIDER: 'alibaba',
    EMBEDDING_MODEL: 'qwen3.7-text-embedding',
    EMBEDDING_DIMENSIONS: '1536',
    LLM_PROVIDER: 'alibaba',
    LLM_MODEL: 'qwen3.8-flash',
    OUTBOUND_QUEUE: outboundQueue,
    MAINTENANCE_QUEUE: maintenanceQueue,
  }
}

function batch(queue: string, message: ReturnType<typeof queueMessage>) {
  return { queue, messages: [message] } as unknown as MessageBatch<unknown>
}

function queueMessage(body: unknown) {
  return {
    body,
    ack: vi.fn(),
    retry: vi.fn(),
  }
}

function vector() {
  return Array.from({ length: 1_536 }, (_value, index) => (index === 0 ? 1 : 0))
}
