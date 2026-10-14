import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  bootstrapWorkspace,
  connectFacebookPages,
  processFacebookInbound,
  autoAssignConversation,
  aiResponseRun,
  aiToolAction,
  message,
  createKnowledgeBase,
  updateAiMemberConfig,
  publishAiMemberConfig,
  takeOverConversation,
  aiOperation,
  createAiMember,
  createDatabase,
  member,
  setMemberChannelAccess,
  workspaceUserAccess,
} from '@deepsales/db'
import { and, eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Pool } from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createAuth } from './auth'
import type { Bindings } from './bindings'
import { app, handleAiResponseBatch } from './index'

const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const db = createDatabase(pool)
const origin = 'https://tools.example.com'
const env = {
  APP_URL: 'http://localhost:8787',
  AUTH_RATE_LIMITER: { limit: async () => ({ success: true }) },
  BETTER_AUTH_SECRET: 'test-only-secret-that-is-at-least-32-characters',
  HYPERDRIVE: { connectionString: process.env.DATABASE_URL },
  TOKEN_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  AI_TOOL_ALLOWED_ORIGINS: JSON.stringify([origin]),
  AI_API_KEY: 'test-key',
  AI_BASE_URL: 'https://ai.example.com',
  EMBEDDING_PROVIDER: 'alibaba',
  EMBEDDING_MODEL: 'qwen3.7-text-embedding',
  EMBEDDING_DIMENSIONS: '1536',
  LLM_PROVIDER: 'alibaba',
  LLM_MODEL: 'qwen3.8-flash',
} as unknown as Bindings

describe.skipIf(!process.env.DATABASE_URL)('External API tool configuration', () => {
  beforeAll(() =>
    migrate(db, {
      migrationsFolder: resolve(
        dirname(fileURLToPath(import.meta.url)),
        '../../../packages/db/drizzle',
      ),
    }),
  )
  afterAll(() => pool.end())
  afterEach(() => vi.unstubAllGlobals())
  it('never authorizes a tool from another matching but unselected skill', async () => {
    const f = await readyExternalWrite()
    const first = crypto.randomUUID(),
      second = crypto.randomUUID()
    await updateAiMemberConfig(db, {
      workspaceId: f.workspaceId,
      memberId: f.memberId,
      actingUserId: f.userId,
      instructions: 'Provide grounded support.',
      skills: [
        {
          id: first,
          name: 'First',
          condition: 'Customer needs help.',
          instructions: 'Give a general reply.',
        },
        {
          id: second,
          name: 'Second',
          condition: 'Customer needs help.',
          instructions: `Use [[tool:external:${f.toolId}]].`,
        },
      ],
    })
    await publishAiMemberConfig(db, {
      workspaceId: f.workspaceId,
      memberId: f.memberId,
      actingUserId: f.userId,
      providerConfigured: true,
    })
    const external = vi.fn(async () => Response.json({ status: 'recorded' }))
    const normal = toolFetch(f.toolId, external)
    let firstGeneration = true
    vi.stubGlobal('fetch', async (url: unknown, init?: RequestInit) => {
      if (String(url).endsWith('/chat/completions') && firstGeneration) {
        firstGeneration = false
        return Response.json({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  decision: 'ANSWER',
                  response: 'Classification.',
                  handoffReason: null,
                  containsBusinessFacts: false,
                  usedChunkIds: [],
                  matchedSkillIds: [first, second],
                }),
              },
            },
          ],
        })
      }
      return normal(url, init)
    })
    await handleAiResponseBatch(f.batch, f.liveEnv)
    expect(external).not.toHaveBeenCalled()
    const [operation] = await db.select().from(aiOperation).where(eq(aiOperation.id, f.runId))
    expect(operation.output).toMatchObject({ skillSelection: { id: first } })
    expect(
      await db.select().from(aiToolAction).where(eq(aiToolAction.operationId, f.runId)),
    ).toHaveLength(0)
  })
  it.each(['TEST', 'BATCH'] as const)(
    'simulates external writes in %s without dispatching production credentials or requests',
    async (mode) => {
      const f = await readyExternalWrite()
      const external = vi.fn(async () => {
        throw new Error('Production request forbidden in sandbox')
      })
      vi.stubGlobal('fetch', toolFetch(f.toolId, external))
      let operationId: string
      if (mode === 'TEST') {
        operationId = crypto.randomUUID()
        const response = await f.call('test', 'POST', {
          id: operationId,
          source: 'PUBLISHED',
          text: 'Try the configured tool.',
        })
        expect(response.status).toBe(200)
        expect(await response.json()).toMatchObject({
          actions: [{ tool: `external:${f.toolId}`, simulated: true, state: 'SUCCEEDED' }],
        })
      } else {
        const setId = crypto.randomUUID(),
          batchId = crypto.randomUUID()
        await f.call('question-sets', 'POST', {
          id: setId,
          name: 'Tool checks',
          questions: ['Try the configured tool.'],
        })
        await f.call('batches', 'POST', { id: batchId, questionSetId: setId, source: 'PUBLISHED' })
        const batch = (await (await f.call(`batches/${batchId}`)).json()) as {
          items: { id: string }[]
        }
        operationId = batch.items[0].id
        const response = await f.call(`batches/${batchId}/execute`, 'POST', {
          itemId: operationId,
          attempt: 0,
        })
        expect(response.status).toBe(200)
      }
      const [action] = await db
        .select()
        .from(aiToolAction)
        .where(eq(aiToolAction.operationId, operationId))
      expect(action).toMatchObject({
        simulated: true,
        state: 'SUCCEEDED',
        result: { status: '沙箱示例' },
      })
      expect(external).not.toHaveBeenCalled()
      expect(f.outbound).not.toHaveBeenCalled()
    },
  )
  it('retains the same three mixed tool slots across final generation and replay', async () => {
    const f = await readyExternalWrite()
    await updateAiMemberConfig(db, {
      workspaceId: f.workspaceId,
      memberId: f.memberId,
      actingUserId: f.userId,
      instructions: `Use [[tool:record]] and [[tool:external:${f.toolId}]].`,
    })
    await publishAiMemberConfig(db, {
      workspaceId: f.workspaceId,
      memberId: f.memberId,
      actingUserId: f.userId,
      providerConfigured: true,
    })
    const external = vi.fn(async () => Response.json({ status: 'recorded' }))
    const normal = toolFetch(f.toolId, external)
    vi.stubGlobal('fetch', async (url: unknown, init?: RequestInit) => {
      const result = await normal(url, init)
      if (!String(url).endsWith('/chat/completions')) return result
      const payload = (await result.json()) as { choices: { message: { content: string } }[] }
      const decision = JSON.parse(payload.choices[0].message.content)
      if (decision.toolCalls)
        decision.toolCalls = [
          { tool: 'record', arguments: { text: 'Internal support context.' } },
          { tool: 'external', arguments: { definitionId: f.toolId, values: {} } },
          { tool: 'external', arguments: { definitionId: f.toolId, values: {} } },
        ]
      return Response.json({ choices: [{ message: { content: JSON.stringify(decision) } }] })
    })
    await handleAiResponseBatch(f.batch, f.liveEnv)
    await handleAiResponseBatch(f.batch, f.liveEnv)
    const actions = await db
      .select()
      .from(aiToolAction)
      .where(eq(aiToolAction.operationId, f.runId))
    expect(actions).toHaveLength(3)
    expect(new Set(actions.map((action) => action.ordinal))).toEqual(new Set([0, 1, 2]))
    expect(external).toHaveBeenCalledTimes(2)
    expect(f.outbound).toHaveBeenCalledOnce()
  })
  it('pauses an uncertain write and never blindly repeats it on queue replay', async () => {
    const f = await readyExternalWrite()
    const external = vi.fn(async () => {
      throw new Error('connection lost after dispatch')
    })
    vi.stubGlobal('fetch', toolFetch(f.toolId, external))
    await handleAiResponseBatch(f.batch, f.liveEnv)
    await handleAiResponseBatch(f.batch, f.liveEnv)
    expect(external).toHaveBeenCalledOnce()
    const [action] = await db.select().from(aiToolAction).where(eq(aiToolAction.runId, f.runId))
    expect(action).toMatchObject({ state: 'UNKNOWN', failureCode: 'EXTERNAL_REQUEST_FAILED' })
    const [operation] = await db.select().from(aiOperation).where(eq(aiOperation.id, f.runId))
    expect(operation.state).toBe('UNKNOWN')
    expect(f.outbound).not.toHaveBeenCalled()
    await f.receive('Please try again.')
    const [next] = await db
      .select()
      .from(aiResponseRun)
      .where(
        and(eq(aiResponseRun.conversationId, f.conversationId), eq(aiResponseRun.state, 'QUEUED')),
      )
    if (!next) throw new Error('Missing fresh customer run')
    await db
      .update(aiResponseRun)
      .set({ scheduledFor: new Date(Date.now() - 1000) })
      .where(eq(aiResponseRun.id, next.id))
    await handleAiResponseBatch(
      {
        queue: 'ai',
        messages: [
          { body: { v: 1, type: 'ai.response', runId: next.id }, ack: vi.fn(), retry: vi.fn() },
        ],
      } as unknown as MessageBatch<unknown>,
      f.liveEnv,
    )
    expect(external).toHaveBeenCalledOnce()
    const [blocked] = await db.select().from(aiOperation).where(eq(aiOperation.id, next.id))
    expect(blocked).toMatchObject({ state: 'UNKNOWN', failureCode: 'EXTERNAL_PREVIOUS_UNKNOWN' })
  })
  it.each(['owner', 'input', 'definition'] as const)(
    'retains a successful write receipt but withholds stale answers after %s changes',
    async (change) => {
      const f = await readyExternalWrite()
      const external = vi.fn(async () => {
        if (change === 'owner')
          await takeOverConversation(db, {
            workspaceId: f.workspaceId,
            conversationId: f.conversationId,
            actingUserId: f.userId,
          })
        if (change === 'input') await f.receive('A new question.')
        return Response.json({ status: 'recorded' })
      })
      const beforeFinal =
        change === 'definition'
          ? async () => {
              expect(
                (await f.call('external-tools', 'POST', { ...f.tool, revision: 1, enabled: false }))
                  .status,
              ).toBe(201)
            }
          : undefined
      vi.stubGlobal('fetch', toolFetch(f.toolId, external, beforeFinal))
      await handleAiResponseBatch(f.batch, f.liveEnv)
      await handleAiResponseBatch(f.batch, f.liveEnv)
      expect(external).toHaveBeenCalledOnce()
      const [action] = await db.select().from(aiToolAction).where(eq(aiToolAction.runId, f.runId))
      expect(action).toMatchObject({ state: 'SUCCEEDED', result: { status: 'recorded' } })
      expect(f.outbound).not.toHaveBeenCalled()
      const [run] = await db.select().from(aiResponseRun).where(eq(aiResponseRun.id, f.runId))
      expect(run.state).toBe('CANCELLED')
    },
  )
  it('executes one authorized external call, grounds its mapped result and replays without another dispatch', async () => {
    const f = await fixture()
    const pluginId = crypto.randomUUID(),
      toolId = crypto.randomUUID()
    await f.call('plugins', 'POST', {
      id: pluginId,
      name: 'Support API',
      channelId: f.channelId,
      origin,
      enabled: true,
      auth: 'BEARER',
      credential: 'fixture-private-credential',
    })
    expect(
      (
        await f.call('external-tools', 'POST', {
          id: toolId,
          pluginId,
          name: 'Status',
          description: 'Status for the configured account.',
          enabled: true,
          method: 'GET',
          path: '/status',
          effect: 'READ',
          inputs: [],
          fixed: [],
          output: [{ name: 'status', path: ['status'], type: 'string' }],
          objectScope: '',
        })
      ).status,
    ).toBe(201)
    const base = await createKnowledgeBase(db, {
      workspaceId: f.workspaceId,
      createdByUserId: f.userId,
      name: 'Support knowledge',
    })
    await updateAiMemberConfig(db, {
      workspaceId: f.workspaceId,
      memberId: f.memberId,
      actingUserId: f.userId,
      instructions: `Use [[tool:external:${toolId}]] to check status.`,
      responseLanguage: 'English',
      knowledgeBaseId: base.id,
      replyWaitEnabled: false,
    })
    await publishAiMemberConfig(db, {
      workspaceId: f.workspaceId,
      memberId: f.memberId,
      actingUserId: f.userId,
      providerConfigured: true,
    })
    const inbound = await processFacebookInbound(db, {
      ingressId: crypto.randomUUID(),
      pageId: f.pageId,
      externalUserId: crypto.randomUUID(),
      externalMessageId: crypto.randomUUID(),
      text: 'Please check status.',
      providerSentAt: new Date(),
      receivedAt: new Date(),
      payloadSha256: 'a'.repeat(64),
      eventFragment: {},
    })
    if (inbound.kind !== 'created') throw new Error('Missing input')
    const assigned = await autoAssignConversation(db, {
      workspaceId: f.workspaceId,
      conversationId: inbound.conversationId,
    })
    if (!assigned.aiResponseRunId) throw new Error('Missing AI run')
    await db
      .update(aiResponseRun)
      .set({ scheduledFor: new Date(Date.now() - 1000) })
      .where(eq(aiResponseRun.id, assigned.aiResponseRunId))
    const external = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('Authorization')).toBe(
        'Bearer fixture-private-credential',
      )
      return Response.json({ status: 'ready', internalSecret: 'must-not-leak' })
    })
    let generated = 0
    vi.stubGlobal('fetch', async (url: unknown, init?: RequestInit) => {
      if (String(url).startsWith(origin)) return external(url, init)
      if (String(url).endsWith('/embeddings'))
        return Response.json({
          data: [
            { index: 0, embedding: Array.from({ length: 1536 }, (_, i) => (i === 0 ? 1 : 0)) },
          ],
        })
      generated++
      const prompt = String(init?.body)
      const text = (JSON.parse(prompt) as { messages: { content: string }[] }).messages
        .map((message) => message.content)
        .join('\n')
      const supplied = JSON.parse(text.match(/EXTERNAL_RESULT_VALUES: ([^\n]+)/)?.[1] ?? '[]') as {
        actionId: string
      }[]
      const result =
        generated === 1
          ? {
              decision: 'ANSWER',
              response: 'Checking status.',
              handoffReason: null,
              containsBusinessFacts: false,
              usedChunkIds: [],
              toolCalls: [{ tool: 'external', arguments: { definitionId: toolId, values: {} } }],
            }
          : {
              decision: 'ANSWER',
              response: 'Status: ready.',
              handoffReason: null,
              containsBusinessFacts: true,
              usedChunkIds: [],
              usedToolActionIds: [supplied[0]?.actionId],
            }
      expect(prompt).not.toContain('fixture-private-credential')
      expect(prompt).not.toContain('must-not-leak')
      return Response.json({ choices: [{ message: { content: JSON.stringify(result) } }] })
    })
    const outbound = vi.fn()
    const liveEnv = { ...env, OUTBOUND_QUEUE: { send: outbound } as unknown as Queue }
    const job = {
      body: { v: 1, type: 'ai.response', runId: assigned.aiResponseRunId },
      ack: vi.fn(),
      retry: vi.fn(),
    }
    const batch = { queue: 'ai', messages: [job] } as unknown as MessageBatch<unknown>
    await handleAiResponseBatch(batch, liveEnv)
    await handleAiResponseBatch(batch, liveEnv)
    expect(external).toHaveBeenCalledOnce()
    expect(generated).toBe(2)
    const [run] = await db
      .select()
      .from(aiResponseRun)
      .where(eq(aiResponseRun.id, assigned.aiResponseRunId))
    expect(run.state).toBe('COMPLETED')
    const [sent] = await db
      .select()
      .from(message)
      .where(eq(message.id, run.outputMessageId ?? crypto.randomUUID()))
    expect(sent.text).toBe('Status: ready.')
    const [action] = await db.select().from(aiToolAction).where(eq(aiToolAction.runId, run.id))
    expect(action).toMatchObject({ state: 'SUCCEEDED', result: { status: 'ready' } })
  })
  it('saves immediate scoped plugins and returns credential configuration state only', async () => {
    const f = await fixture()
    const id = crypto.randomUUID()
    const saved = await f.call('plugins', 'POST', {
      id,
      name: 'Support API',
      channelId: f.channelId,
      origin,
      enabled: true,
      auth: 'BEARER',
      credential: 'fixture-private-credential',
    })
    expect(saved.status).toBe(201)
    expect(await saved.json()).toMatchObject({ id, revision: 1, configured: true })
    const listed = await f.call('plugins')
    const body = await listed.text()
    expect(body).toContain('Support API')
    expect(body).not.toMatch(
      /fixture-private-credential|ciphertext|credentialIv|encryptedCredential|keyVersion/,
    )
    const tool = await f.call('external-tools', 'POST', {
      id: crypto.randomUUID(),
      pluginId: id,
      name: 'Read status',
      description: 'Read configured support status.',
      enabled: true,
      method: 'GET',
      path: '/status',
      effect: 'READ',
      inputs: [],
      fixed: [],
      output: [{ name: 'status', path: ['status'], type: 'string' }],
      objectScope: '',
    })
    expect(tool.status).toBe(201)
    const definition = (await tool.json()) as { id: string }
    const debug = await f.call(`external-tools/${definition.id}/debug`, 'POST', {
      id: crypto.randomUUID(),
      values: {},
    })
    expect(debug.status).toBe(200)
    expect(await debug.json()).toMatchObject({ simulated: true, state: 'SUCCEEDED' })
  })
  it('hides revoked plugin scopes and rejects mutable or missing declared write targets without production requests', async () => {
    const f = await fixture()
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    const id = crypto.randomUUID()
    expect(
      (
        await f.call('plugins', 'POST', {
          id,
          name: 'Write API',
          channelId: f.channelId,
          origin,
          enabled: true,
          auth: 'BEARER',
          credential: 'fixture-credential',
        })
      ).status,
    ).toBe(201)
    const tool = {
      id: crypto.randomUUID(),
      pluginId: id,
      name: 'Record note',
      description: 'Write only to the configured record.',
      enabled: true,
      method: 'POST',
      path: '/record',
      effect: 'WRITE',
      inputs: [{ name: 'note', location: 'body', type: 'string', required: true }],
      fixed: [{ name: 'recordId', location: 'body', value: 'configured-record' }],
      output: [{ name: 'status', path: ['status'], type: 'string' }],
      objectScope: JSON.stringify({
        policy: 'FIXED_CONFIG',
        targets: [{ name: 'recordId', location: 'body' }],
        description: 'Administrator-approved record on this channel.',
      }),
    }
    expect((await f.call('external-tools', 'POST', { ...tool, fixed: [] })).status).toBe(400)
    expect((await f.call('external-tools', 'POST', { ...tool, objectScope: '' })).status).toBe(400)
    expect((await f.call('external-tools', 'POST', tool)).status).toBe(201)
    const debugId = crypto.randomUUID()
    expect(
      (
        await f.call(`external-tools/${tool.id}/debug`, 'POST', {
          id: debugId,
          values: { note: 'hello', recordId: 'other-record' },
        })
      ).status,
    ).toBe(400)
    const first = await (
      await f.call(`external-tools/${tool.id}/debug`, 'POST', {
        id: debugId,
        values: { note: 'hello' },
      })
    ).json()
    expect(
      await (
        await f.call(`external-tools/${tool.id}/debug`, 'POST', {
          id: debugId,
          values: { note: 'hello' },
        })
      ).json(),
    ).toEqual(first)
    expect(fetcher).not.toHaveBeenCalled()
    await db
      .update(workspaceUserAccess)
      .set({ role: 'ADMIN' })
      .where(eq(workspaceUserAccess.workspaceId, f.workspaceId))
    await setMemberChannelAccess(db, {
      workspaceId: f.workspaceId,
      memberId: f.humanId,
      actingUserId: f.userId,
      channelIds: [],
    })
    expect(await (await f.call('plugins')).json()).toMatchObject({ plugins: [], tools: [] })
    expect(
      (
        await f.call(`external-tools/${tool.id}/debug`, 'POST', {
          id: crypto.randomUUID(),
          values: { note: 'hello' },
        })
      ).status,
    ).toBe(404)
    expect(
      (
        await f.call('plugins', 'POST', {
          id,
          revision: 1,
          name: 'Attempt edit',
          channelId: f.channelId,
          origin,
          enabled: true,
          auth: 'NONE',
        })
      ).status,
    ).toBe(403)
    expect(fetcher).not.toHaveBeenCalled()
  })
})

function toolFetch(
  toolId: string,
  external: () => Promise<Response>,
  beforeFinal?: () => Promise<void>,
) {
  return async (url: unknown, init?: RequestInit) => {
    if (String(url).startsWith(origin)) return external()
    if (String(url).endsWith('/embeddings'))
      return Response.json({
        data: [{ index: 0, embedding: Array.from({ length: 1536 }, (_, i) => (i === 0 ? 1 : 0)) }],
      })
    const messages = (
      JSON.parse(String(init?.body)) as { messages: { content: string }[] }
    ).messages
      .map((message) => message.content)
      .join('\n')
    const results = JSON.parse(messages.match(/EXTERNAL_RESULT_VALUES: ([^\n]+)/)?.[1] ?? '[]') as {
      actionId: string
    }[]
    if (results.length) await beforeFinal?.()
    const decision = {
      decision: 'ANSWER',
      response: results.length ? 'Status: recorded.' : 'Checking status.',
      handoffReason: null,
      containsBusinessFacts: results.length > 0,
      usedChunkIds: [],
      ...(results.length
        ? { usedToolActionIds: results.map((result) => result.actionId) }
        : { toolCalls: [{ tool: 'external', arguments: { definitionId: toolId, values: {} } }] }),
    }
    return Response.json({ choices: [{ message: { content: JSON.stringify(decision) } }] })
  }
}
async function readyExternalWrite() {
  const f = await fixture()
  const pluginId = crypto.randomUUID(),
    toolId = crypto.randomUUID()
  await f.call('plugins', 'POST', {
    id: pluginId,
    name: 'Write API',
    channelId: f.channelId,
    origin,
    enabled: true,
    auth: 'BEARER',
    credential: 'fixture-private-credential',
  })
  const tool = {
    id: toolId,
    pluginId,
    name: 'Record status',
    description: 'Write to a fixed support record.',
    enabled: true,
    method: 'POST',
    path: '/record',
    effect: 'WRITE',
    inputs: [],
    fixed: [{ name: 'recordId', location: 'body', value: 'configured-record' }],
    output: [{ name: 'status', path: ['status'], type: 'string' }],
    objectScope: JSON.stringify({
      policy: 'FIXED_CONFIG',
      description: 'Fixed administrator-approved support record.',
      targets: [{ name: 'recordId', location: 'body' }],
    }),
  }
  expect((await f.call('external-tools', 'POST', tool)).status).toBe(201)
  const base = await createKnowledgeBase(db, {
    workspaceId: f.workspaceId,
    createdByUserId: f.userId,
    name: 'Support knowledge',
  })
  await updateAiMemberConfig(db, {
    workspaceId: f.workspaceId,
    memberId: f.memberId,
    actingUserId: f.userId,
    instructions: `Use [[tool:external:${toolId}]].`,
    responseLanguage: 'English',
    knowledgeBaseId: base.id,
    replyWaitEnabled: false,
  })
  await publishAiMemberConfig(db, {
    workspaceId: f.workspaceId,
    memberId: f.memberId,
    actingUserId: f.userId,
    providerConfigured: true,
  })
  const customerId = crypto.randomUUID()
  const receive = (text: string) =>
    processFacebookInbound(db, {
      ingressId: crypto.randomUUID(),
      pageId: f.pageId,
      externalUserId: customerId,
      externalMessageId: crypto.randomUUID(),
      text,
      providerSentAt: new Date(),
      receivedAt: new Date(),
      payloadSha256: 'a'.repeat(64),
      eventFragment: {},
    })
  const inbound = await receive('Please record status.')
  if (inbound.kind !== 'created') throw new Error('Missing input')
  const assigned = await autoAssignConversation(db, {
    workspaceId: f.workspaceId,
    conversationId: inbound.conversationId,
  })
  const runId = assigned.aiResponseRunId
  if (!runId) throw new Error('Missing AI run')
  await db
    .update(aiResponseRun)
    .set({ scheduledFor: new Date(Date.now() - 1000) })
    .where(eq(aiResponseRun.id, runId))
  const outbound = vi.fn()
  const job = { body: { v: 1, type: 'ai.response', runId }, ack: vi.fn(), retry: vi.fn() }
  return {
    ...f,
    tool,
    toolId,
    runId,
    conversationId: inbound.conversationId,
    receive,
    outbound,
    liveEnv: { ...env, OUTBOUND_QUEUE: { send: outbound } as unknown as Queue },
    batch: { queue: 'ai', messages: [job] } as unknown as MessageBatch<unknown>,
  }
}

async function fixture() {
  const email = `${crypto.randomUUID()}@example.com`,
    password = 'correct-horse-battery-staple'
  const created = await createAuth(db, env).api.signUpEmail({
    body: { email, password, name: 'Tool manager' },
  })
  const signed = await app.request(
    '/api/auth/sign-in/email',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    },
    env,
  )
  const cookie = signed.headers.get('set-cookie')?.split(';', 1)[0]
  if (!cookie) throw new Error('No session')
  const workspace = await bootstrapWorkspace(db, {
    userId: created.user.id,
    userName: 'Manager',
    name: 'External tool workspace',
  })
  const pageId = crypto.randomUUID()
  const [support] = await connectFacebookPages(db, {
    workspaceId: workspace.id,
    actingUserId: created.user.id,
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
  if (!support) throw new Error('Missing channel')
  const ai = await createAiMember(db, {
    workspaceId: workspace.id,
    createdByUserId: created.user.id,
    displayName: 'Support AI',
    channelIds: [support.id],
  })
  const [access] = await db
    .select()
    .from(workspaceUserAccess)
    .where(eq(workspaceUserAccess.workspaceId, workspace.id))
  const [human] = await db.select().from(member).where(eq(member.workspaceUserAccessId, access.id))
  await setMemberChannelAccess(db, {
    workspaceId: workspace.id,
    actingUserId: created.user.id,
    memberId: human.id,
    channelIds: [support.id],
  })
  return {
    workspaceId: workspace.id,
    pageId,
    humanId: human.id,
    memberId: ai.id,
    userId: created.user.id,
    channelId: support.id,
    call: (path: string, method = 'GET', body?: unknown) =>
      app.request(
        `/api/workspaces/${workspace.id}/ai-operations/${ai.id}/${path}`,
        {
          method,
          headers: { Cookie: cookie, Origin: env.APP_URL, 'Content-Type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
        env,
      ),
  }
}
