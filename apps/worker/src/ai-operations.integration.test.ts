import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  aiOperation,
  aiProviderAttempt,
  aiTestBatchItem,
  bootstrapWorkspace,
  channel,
  claimKnowledgeDocument,
  completeKnowledgeDocument,
  conversation,
  createAiMember,
  createDatabase,
  createInlineKnowledgeDocument,
  createKnowledgeBase,
  customerPropertyDefinition,
  customerTagDefinition,
  getAiAnalytics,
  getAiMemberConfig,
  knowledgeChunk,
  listAiDiagnostics,
  mediaAsset,
  member,
  publishAiMemberConfig,
  setMemberChannelAccess,
  updateAiMemberConfig,
  workspaceUserAccess,
} from '@deepsales/db'
import { eq, sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Pool } from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createAuth } from './auth'
import type { Bindings } from './bindings'
import { app } from './index'

const connectionString = process.env.DATABASE_URL
const pool = new Pool({ connectionString })
const db = createDatabase(pool)
const env = {
  APP_URL: 'http://localhost:8787',
  AUTH_RATE_LIMITER: { limit: async () => ({ success: true }) },
  BETTER_AUTH_SECRET: 'test-only-secret-that-is-at-least-32-characters',
  HYPERDRIVE: { connectionString },
  AI_BASE_URL: 'https://ai.example.com',
  AI_API_KEY: 'test',
  LLM_PROVIDER: 'alibaba',
  LLM_MODEL: 'qwen3.8-flash',
  EMBEDDING_PROVIDER: 'alibaba',
  EMBEDDING_MODEL: 'qwen3.7-text-embedding',
  EMBEDDING_DIMENSIONS: '1536',
} as unknown as Bindings

describe.skipIf(!connectionString)('AI operations routes', () => {
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
  it('starts follow-up rules empty and saves a versioned immediate rule', async () => {
    const f = await fixture()
    const root = `/${f.aiId}/follow-ups`
    const empty = await f.call(root)
    expect(empty.status).toBe(200)
    expect(await empty.json()).toMatchObject({ rules: [] })
    const id = crypto.randomUUID()
    const saved = await f.call(root, 'POST', {
      id,
      name: 'Helpful check-in',
      enabled: true,
      timer: 'LAST_AI_REPLY',
      delaySeconds: 60,
      instructions: '',
      groups: [],
    })
    expect(saved.status).toBe(201)
    expect(await saved.json()).toMatchObject({
      rule: { id, revision: 1, enabled: true, timer: 'LAST_AI_REPLY', delaySeconds: 60 },
    })
    expect(
      (
        await f.call(root, 'POST', {
          id,
          revision: 1,
          name: 'Helpful check-in',
          enabled: false,
          timer: 'AI_ASSIGNMENT',
          delaySeconds: 120,
          instructions: '',
          groups: [],
        })
      ).status,
    ).toBe(201)
    expect(await (await f.call(root)).json()).toMatchObject({
      rules: [{ id, revision: 2, enabled: false }],
    })
  })
  it('resolves test instruction variables only from the simulated customer', async () => {
    const f = await fixture()
    await f.configCall({
      instructions:
        'Use {{customer.name}} {{customer.language}} {{customer.properties}} {{system.timeZone}}.',
    })
    const [definition] = await db
      .insert(customerPropertyDefinition)
      .values({ workspaceId: f.workspaceId, name: 'Quantity', level: 'CUSTOMER', type: 'NUMBER' })
      .returning()
    const sessionId = crypto.randomUUID()
    expect(
      (
        await f.call(`/${f.aiId}/sessions`, 'POST', {
          id: sessionId,
          source: 'DRAFT',
          customer: {
            properties: [{ definitionId: definition.id, value: 2 }],
            tags: [],
            source: '',
            language: 'en',
            memory: '',
          },
        })
      ).status,
    ).toBe(201)
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        expect(String(init?.body)).toContain('\\"customer.name\\":null')
        expect(String(init?.body)).toContain('Quantity')
        expect(String(init?.body)).not.toContain('customer_id')
        return Response.json({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  decision: 'ANSWER',
                  response: 'Thank you.',
                  handoffReason: null,
                  containsBusinessFacts: false,
                  usedChunkIds: [],
                }),
              },
            },
          ],
        })
      }),
    )
    const id = crypto.randomUUID()
    const response = await f.call(`/${f.aiId}/test`, 'POST', {
      id,
      source: 'DRAFT',
      sessionId,
      generation: 1,
      text: 'Use my simulated preference.',
    })
    expect(response.status).toBe(200)
    const [operation] = await db.select().from(aiOperation).where(eq(aiOperation.id, id))
    expect(operation.output).toMatchObject({
      variableInput: {
        version: 1,
        values: {
          'customer.name': null,
          'customer.language': 'en',
          'customer.properties': [{ name: 'Quantity', value: 2 }],
          'system.timeZone': 'UTC',
        },
      },
    })
    expect(
      (
        await db.execute(
          sql`select count(*)::int as count from customer_property_value where definition_id=${definition.id}`,
        )
      ).rows,
    ).toEqual([{ count: 0 }])
  })
  it('exposes a controlled instruction variable catalog and rejects unknown variable names', async () => {
    const f = await fixture()
    const foreign = await fixture()
    expect((await f.call(`/${foreign.aiId}/variables`)).status).toBe(404)
    const response = await f.call(`/${f.aiId}/variables`)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      variables: expect.arrayContaining([
        { key: 'customer.name', label: '联系人姓名', type: 'text' },
      ]),
      positions: ['instructions'],
      missing: null,
    })
    expect((await f.configCall({ instructions: 'Use {{customer.name}}.' })).status).toBe(200)
    expect((await f.configCall({ instructions: 'Use {{sql.query}}.' })).status).toBe(400)
    expect((await f.configCall({ instructions: 'Use {{url.host}}.' })).status).toBe(400)
  })
  it('manages controlled tag rules immediately and rejects foreign definitions', async () => {
    const f = await fixture()
    const [tag] = await db
      .insert(customerTagDefinition)
      .values({ workspaceId: f.workspaceId, name: 'Follow up', level: 'CUSTOMER' })
      .returning()
    const id = crypto.randomUUID()
    const rule = {
      id,
      definitionId: tag.id,
      instructions: 'Explicit follow-up request.',
      enabled: true,
    }
    expect((await f.call(`/${f.aiId}/tag-rules`, 'POST', rule)).status).toBe(201)
    expect(await (await f.call(`/${f.aiId}/tag-rules`)).json()).toMatchObject({
      rules: [{ ...rule, revision: 1 }],
    })
    expect(
      (
        await f.call(`/${f.aiId}/tag-rules`, 'POST', {
          ...rule,
          definitionId: crypto.randomUUID(),
          revision: 1,
        })
      ).status,
    ).toBe(400)
    expect(
      (await f.call(`/${f.aiId}/tag-rules`, 'POST', { ...rule, enabled: false, revision: 1 }))
        .status,
    ).toBe(201)
    expect((await f.call(`/${f.aiId}/tag-rules`, 'DELETE', { id, revision: 1 })).status).toBe(400)
    expect((await f.call(`/${f.aiId}/tag-rules`, 'DELETE', { id, revision: 2 })).status).toBe(200)
  })
  it('appends test tags only into the isolated simulated customer', async () => {
    const f = await fixture()
    expect((await f.configCall({ tagsEnabled: true })).status).toBe(200)
    const [definition] = await db
      .insert(customerTagDefinition)
      .values({
        workspaceId: f.workspaceId,
        name: 'Preferred contact',
        level: 'CUSTOMER',
      })
      .returning()
    expect(
      (
        await f.call(`/${f.aiId}/tag-rules`, 'POST', {
          id: crypto.randomUUID(),
          definitionId: definition.id,
          instructions: 'Collect stated preference.',
          enabled: true,
        })
      ).status,
    ).toBe(201)
    const sessionId = crypto.randomUUID()
    expect(
      (
        await f.call(`/${f.aiId}/sessions`, 'POST', {
          id: sessionId,
          source: 'DRAFT',
          customer: { properties: [], tags: [], source: '', language: '', memory: '' },
        })
      ).status,
    ).toBe(201)
    const fetcher = vi.fn(async (_input: unknown, init?: RequestInit) => {
      expect(String(init?.body)).toContain('Preferred contact')
      return Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                decision: 'ANSWER',
                response: 'Thank you.',
                handoffReason: null,
                containsBusinessFacts: false,
                usedChunkIds: [],
                appendedTags: [definition.id],
              }),
            },
          },
        ],
      })
    })
    vi.stubGlobal('fetch', fetcher)
    const result = await f.call(`/${f.aiId}/test`, 'POST', {
      id: crypto.randomUUID(),
      source: 'DRAFT',
      sessionId,
      generation: 1,
      text: 'I prefer email.',
    })
    expect(result.status).toBe(200)
    expect(await (await f.call(`/${f.aiId}/sessions/${sessionId}`)).json()).toMatchObject({
      session: { customer: { tags: [definition.id] } },
    })
    expect(fetcher).toHaveBeenCalledOnce()
    expect(
      (
        await db.execute(
          sql`select count(*)::int as count from customer_tag where tag_id = ${definition.id}`,
        )
      ).rows,
    ).toEqual([{ count: 0 }])
  })
  it('collects test properties only into the isolated simulated customer', async () => {
    const f = await fixture()
    const [definition] = await db
      .insert(customerPropertyDefinition)
      .values({
        workspaceId: f.workspaceId,
        name: 'Preferred contact',
        level: 'CUSTOMER',
        type: 'TEXT',
      })
      .returning()
    expect(
      (
        await f.call(`/${f.aiId}/property-rules`, 'POST', {
          id: crypto.randomUUID(),
          definitionId: definition.id,
          instructions: 'Collect stated preference.',
          enabled: true,
        })
      ).status,
    ).toBe(201)
    const sessionId = crypto.randomUUID()
    expect(
      (
        await f.call(`/${f.aiId}/sessions`, 'POST', {
          id: sessionId,
          source: 'DRAFT',
          customer: { properties: [], tags: [], source: '', language: '', memory: '' },
        })
      ).status,
    ).toBe(201)
    const fetcher = vi.fn(async (_input: unknown, init?: RequestInit) => {
      expect(String(init?.body)).toContain('Preferred contact')
      return Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                decision: 'ANSWER',
                response: 'Thank you.',
                handoffReason: null,
                containsBusinessFacts: false,
                usedChunkIds: [],
                collectedProperties: [{ definitionId: definition.id, value: 'email' }],
              }),
            },
          },
        ],
      })
    })
    vi.stubGlobal('fetch', fetcher)
    const result = await f.call(`/${f.aiId}/test`, 'POST', {
      id: crypto.randomUUID(),
      source: 'DRAFT',
      sessionId,
      generation: 1,
      text: 'I prefer email.',
    })
    expect(result.status).toBe(200)
    expect(await (await f.call(`/${f.aiId}/sessions/${sessionId}`)).json()).toMatchObject({
      session: { customer: { properties: [{ definitionId: definition.id, value: 'email' }] } },
    })
    expect(fetcher).toHaveBeenCalledOnce()
    expect(
      (
        await db.execute(
          sql`select count(*)::int as count from customer_property_value where definition_id = ${definition.id}`,
        )
      ).rows,
    ).toEqual([{ count: 0 }])
  })
  it('saves immediate typed property collection rules and rejects foreign or stale definitions', async () => {
    const f = await fixture()
    const [definition] = await db
      .insert(customerPropertyDefinition)
      .values({
        workspaceId: f.workspaceId,
        name: 'Preferred contact',
        level: 'CUSTOMER',
        type: 'TEXT',
        maxLength: 80,
      })
      .returning()
    const id = crypto.randomUUID()
    const saved = await f.call(`/${f.aiId}/property-rules`, 'POST', {
      id,
      definitionId: definition.id,
      instructions: 'Collect the preferred contact method only when stated.',
      enabled: true,
    })
    expect(saved.status).toBe(201)
    expect(await (await f.call(`/${f.aiId}/property-rules`)).json()).toMatchObject({
      rules: [{ id, enabled: true, revision: 1 }],
    })
    expect(
      (
        await f.call(`/${f.aiId}/property-rules`, 'POST', {
          id,
          definitionId: definition.id,
          instructions: 'Changed.',
          enabled: false,
          revision: 0,
        })
      ).status,
    ).toBe(400)
    expect(
      (
        await f.call(`/${f.aiId}/property-rules`, 'POST', {
          id,
          definitionId: definition.id,
          instructions: 'Changed.',
          enabled: false,
          revision: 1,
        })
      ).status,
    ).toBe(201)
    const other = await fixture()
    expect(
      (
        await other.call(`/${other.aiId}/property-rules`, 'POST', {
          id: crypto.randomUUID(),
          definitionId: definition.id,
          instructions: 'Collect.',
          enabled: true,
        })
      ).status,
    ).toBe(400)
    expect((await f.call(`/${f.aiId}/property-rules`, 'DELETE', { id, revision: 2 })).status).toBe(
      200,
    )
    expect(await (await f.call(`/${f.aiId}/property-rules`)).json()).toEqual({ rules: [] })
  })
  it('validates unpublished attachment fallback choices and defaults to single-turn skip', async () => {
    const f = await fixture()
    expect(
      await getAiMemberConfig(db, {
        workspaceId: f.workspaceId,
        memberId: f.aiId,
        actingUserId: f.userId,
      }),
    ).toMatchObject({ unparsedFallbackEnabled: false, unparsedFallbackTexts: [] })
    const saved = await f.configCall({
      unparsedFallbackEnabled: true,
      unparsedFallbackTexts: ['Please send text.', 'Could you describe this?'],
    })
    expect(saved.status).toBe(200)
    expect(await saved.json()).toMatchObject({
      config: {
        unparsedFallbackEnabled: true,
        unparsedFallbackTexts: ['Please send text.', 'Could you describe this?'],
        publishedSnapshot: null,
      },
    })
    expect((await f.configCall({ unparsedFallbackTexts: [''] })).status).toBe(400)
    expect((await f.configCall({ unparsedFallbackEnabled: 'true' })).status).toBe(400)
  })
  it('keeps customer memory disabled by default and enables it only after explicit publication', async () => {
    const f = await fixture()
    expect(
      await getAiMemberConfig(db, {
        workspaceId: f.workspaceId,
        memberId: f.aiId,
        actingUserId: f.userId,
      }),
    ).toMatchObject({ memoryEnabled: false })
    const saved = await f.configCall({ memoryEnabled: true })
    expect(saved.status).toBe(200)
    expect(await saved.json()).toMatchObject({
      config: { memoryEnabled: true, publishedSnapshot: null },
    })
    expect((await f.configCall({ memoryEnabled: 'true' })).status).toBe(400)
  })
  it('maintains question sets and freezes each batch before drafts or questions change', async () => {
    const f = await fixture()
    const setId = crypto.randomUUID()
    const saved = await f.call(`/${f.aiId}/question-sets`, 'POST', {
      id: setId,
      name: 'Neutral checks',
      questions: ['Hello.', 'Explain your role.'],
    })
    expect(saved.status).toBe(201)
    const id = crypto.randomUUID()
    expect(
      (await f.call(`/${f.aiId}/batches`, 'POST', { id, questionSetId: setId, source: 'DRAFT' }))
        .status,
    ).toBe(201)
    await f.configCall({ instructions: 'A newer draft.' })
    await f.call(`/${f.aiId}/question-sets`, 'POST', {
      id: setId,
      revision: 1,
      name: 'Changed',
      questions: ['Changed question.'],
    })
    const result = (await (await f.call(`/${f.aiId}/batches/${id}`)).json()) as {
      batch: unknown
      items: unknown[]
    }
    expect(result.batch).toMatchObject({
      id,
      source: 'DRAFT',
      snapshot: { instructions: 'Answer safely.' },
    })
    expect(result.items).toMatchObject([
      { text: 'Hello.', state: 'QUEUED', charged: false },
      { text: 'Explain your role.', state: 'QUEUED', charged: false },
    ])
    const other = await fixture()
    expect((await other.call(`/${f.aiId}/batches/${id}`)).status).toBe(404)
    const maximumSet = crypto.randomUUID(),
      maximumBatch = crypto.randomUUID()
    expect(
      (
        await f.call(`/${f.aiId}/question-sets`, 'POST', {
          id: maximumSet,
          name: 'Maximum batch',
          questions: Array(100).fill('Hello.'),
        })
      ).status,
    ).toBe(201)
    expect(
      (
        await f.call(`/${f.aiId}/batches`, 'POST', {
          id: maximumBatch,
          questionSetId: maximumSet,
          source: 'DRAFT',
        })
      ).status,
    ).toBe(201)
    const maximum = (await (await f.call(`/${f.aiId}/batches/${maximumBatch}`)).json()) as {
      items: unknown[]
    }
    expect(maximum.items).toHaveLength(100)
    expect(
      (
        await f.call(`/${f.aiId}/question-sets`, 'POST', {
          id: crypto.randomUUID(),
          name: 'Too many',
          questions: Array(101).fill('Hello.'),
        })
      ).status,
    ).toBe(400)
  })
  it('executes batch questions serially, deduplicates scheduling and protects the per-question budget', async () => {
    const f = await fixture()
    const setId = crypto.randomUUID(),
      id = crypto.randomUUID()
    await f.call(`/${f.aiId}/question-sets`, 'POST', {
      id: setId,
      name: 'Greetings',
      questions: ['Hello.', 'Good morning.'],
    })
    await f.call(`/${f.aiId}/batches`, 'POST', { id, questionSetId: setId, source: 'DRAFT' })
    const root = `/${f.aiId}/batches/${id}`
    const batch = (await (await f.call(root)).json()) as { items: [{ id: string }, { id: string }] }
    const [first, second] = batch.items
    if (!first || !second) throw new Error('Missing batch questions')
    await f.call('/budget', 'PATCH', { monthlyLimit: 1 })
    let release: () => void = () => {},
      started: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const received = new Promise<void>((resolve) => {
      started = resolve
    })
    const provider = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(init?.body)).toContain('Answer safely.')
      started()
      await gate
      return Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                decision: 'ANSWER',
                response: 'Hello.',
                handoffReason: null,
                containsBusinessFacts: false,
                usedChunkIds: [],
              }),
            },
          },
        ],
      })
    })
    vi.stubGlobal('fetch', provider)
    const running = f.call(`${root}/execute`, 'POST', { itemId: first.id, attempt: 0 })
    await received
    expect(
      (await f.call(`${root}/execute`, 'POST', { itemId: second.id, attempt: 0 })).status,
    ).toBe(409)
    expect((await f.call(`${root}/execute`, 'POST', { itemId: first.id, attempt: 0 })).status).toBe(
      409,
    )
    await f.configCall({ instructions: 'A later draft.' })
    release()
    expect((await running).status).toBe(200)
    expect((await f.call(`${root}/execute`, 'POST', { itemId: first.id, attempt: 0 })).status).toBe(
      200,
    )
    expect(provider).toHaveBeenCalledTimes(1)
    expect(
      (await f.call(`${root}/execute`, 'POST', { itemId: second.id, attempt: 0 })).status,
    ).toBe(200)
    expect(await (await f.call(root)).json()).toMatchObject({
      items: [
        { state: 'COMPLETED', charged: true, output: { decision: { response: 'Hello.' } } },
        { state: 'FAILED', charged: false, failureCode: 'QUOTA_EXHAUSTED' },
      ],
    })
    expect(await (await f.call('/budget')).json()).toMatchObject({ used: 1, reserved: 0 })
    expect(
      await db.select().from(conversation).where(eq(conversation.workspaceId, f.workspaceId)),
    ).toHaveLength(0)
  })
  it('cancels only unstarted questions and keeps late results attached to the original run', async () => {
    const f = await fixture()
    const setId = crypto.randomUUID(),
      id = crypto.randomUUID(),
      nextId = crypto.randomUUID()
    await f.call(`/${f.aiId}/question-sets`, 'POST', {
      id: setId,
      name: 'Neutral checks',
      questions: ['Hello.', 'Good morning.'],
    })
    await f.call(`/${f.aiId}/batches`, 'POST', { id, questionSetId: setId, source: 'DRAFT' })
    const root = `/${f.aiId}/batches/${id}`
    const { items } = (await (await f.call(root)).json()) as {
      items: [{ id: string }, { id: string }]
    }
    let release: () => void = () => {},
      started: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const received = new Promise<void>((resolve) => {
      started = resolve
    })
    vi.stubGlobal('fetch', async () => {
      started()
      await gate
      return Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                decision: 'ANSWER',
                response: 'Hello.',
                handoffReason: null,
                containsBusinessFacts: false,
                usedChunkIds: [],
              }),
            },
          },
        ],
      })
    })
    const executing = f.call(`${root}/execute`, 'POST', { itemId: items[0].id, attempt: 0 })
    await received
    expect((await f.call(`${root}/cancel`, 'POST', {})).status).toBe(200)
    await f.call(`/${f.aiId}/batches`, 'POST', {
      id: nextId,
      questionSetId: setId,
      source: 'DRAFT',
    })
    release()
    await executing
    expect(await (await f.call(root)).json()).toMatchObject({
      items: [{ state: 'COMPLETED' }, { state: 'CANCELLED', charged: false }],
    })
    expect(await (await f.call(`/${f.aiId}/batches/${nextId}`)).json()).toMatchObject({
      items: [
        { state: 'QUEUED', charged: false },
        { state: 'QUEUED', charged: false },
      ],
    })
  })
  it('recovers a failed question independently without charging again and pauses unknown results', async () => {
    const f = await fixture()
    const [definition] = await db
      .insert(customerPropertyDefinition)
      .values({
        workspaceId: f.workspaceId,
        name: 'Contact preference',
        type: 'TEXT',
        level: 'CUSTOMER',
      })
      .returning()
    await f.call(`/${f.aiId}/property-rules`, 'POST', {
      id: crypto.randomUUID(),
      definitionId: definition.id,
      instructions: 'Collect stated preference.',
      enabled: true,
    })
    const setId = crypto.randomUUID(),
      id = crypto.randomUUID()
    await f.call(`/${f.aiId}/question-sets`, 'POST', {
      id: setId,
      name: 'Retry checks',
      questions: ['Hello.', 'Good morning.'],
    })
    await f.call(`/${f.aiId}/batches`, 'POST', { id, questionSetId: setId, source: 'DRAFT' })
    const root = `/${f.aiId}/batches/${id}`
    const { items } = (await (await f.call(root)).json()) as {
      items: [{ id: string }, { id: string }]
    }
    let calls = 0
    vi.stubGlobal('fetch', async () => {
      calls++
      return Response.json({
        choices: [
          {
            message: {
              content:
                calls === 1
                  ? 'invalid JSON'
                  : JSON.stringify({
                      decision: 'ANSWER',
                      response: 'Hello again.',
                      handoffReason: null,
                      containsBusinessFacts: false,
                      usedChunkIds: [],
                    }),
            },
          },
        ],
      })
    })
    expect(
      (await f.call(`${root}/execute`, 'POST', { itemId: items[0].id, attempt: 0 })).status,
    ).toBe(200)
    expect(await (await f.call(root)).json()).toMatchObject({
      items: [
        { state: 'FAILED', failureCode: 'INVALID_OUTPUT', attempt: 1, charged: true },
        { state: 'QUEUED' },
      ],
    })
    expect(
      (await f.call(`${root}/execute`, 'POST', { itemId: items[0].id, attempt: 1 })).status,
    ).toBe(409)
    const [tag] = await db
      .insert(customerTagDefinition)
      .values({ workspaceId: f.workspaceId, name: 'Support review', level: 'CUSTOMER' })
      .returning()
    expect(
      (
        await f.call(`/${f.aiId}/handoff-rules`, 'POST', {
          name: 'Review tagged requests',
          enabled: true,
          condition: { kind: 'TAG', tagId: tag.id },
        })
      ).status,
    ).toBe(201)
    await db
      .update(aiTestBatchItem)
      .set({ retryAt: new Date(0) })
      .where(eq(aiTestBatchItem.id, items[0].id))
    expect(
      (await f.call(`${root}/execute`, 'POST', { itemId: items[0].id, attempt: 1 })).status,
    ).toBe(200)
    expect(
      (await f.call(`${root}/execute`, 'POST', { itemId: items[0].id, attempt: 1 })).status,
    ).toBe(200)
    expect(calls).toBe(2)
    expect(await (await f.call('/budget')).json()).toMatchObject({ used: 1, reserved: 0 })
    vi.stubGlobal('fetch', async () => {
      throw new Error('Connection lost')
    })
    await f.call(`${root}/execute`, 'POST', { itemId: items[1].id, attempt: 0 })
    expect(await (await f.call(root)).json()).toMatchObject({
      items: [
        { state: 'COMPLETED' },
        { state: 'UNKNOWN', charged: true, failureCode: 'OPERATION_PAUSED' },
      ],
    })
    expect(
      (await f.call(`${root}/execute`, 'POST', { itemId: items[1].id, attempt: 1 })).status,
    ).toBe(409)
  })
  it('restores an interrupted batch from durable provider results and prevents unauthorized completion', async () => {
    const f = await fixture()
    const setId = crypto.randomUUID(),
      id = crypto.randomUUID()
    await f.call(`/${f.aiId}/question-sets`, 'POST', {
      id: setId,
      name: 'Recovery',
      questions: ['Hello.', 'Good morning.'],
    })
    await f.call(`/${f.aiId}/batches`, 'POST', { id, questionSetId: setId, source: 'DRAFT' })
    const root = `/${f.aiId}/batches/${id}`
    const { items } = (await (await f.call(root)).json()) as {
      items: [{ id: string }, { id: string }]
    }
    const provider = vi.fn(async () =>
      Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                decision: 'ANSWER',
                response: 'Hello.',
                handoffReason: null,
                containsBusinessFacts: false,
                usedChunkIds: [],
              }),
            },
          },
        ],
      }),
    )
    vi.stubGlobal('fetch', provider)
    await f.call(`${root}/execute`, 'POST', { itemId: items[0].id, attempt: 0 })
    // Simulate a process stopping after its successful provider response was persisted.
    await db
      .update(aiOperation)
      .set({
        state: 'STARTED',
        output: { handoffContext: { rules: [], facts: { properties: [], tags: [] } } },
      })
      .where(eq(aiOperation.id, items[0].id))
    await db
      .update(aiTestBatchItem)
      .set({ state: 'RUNNING', claimedAt: new Date(0) })
      .where(eq(aiTestBatchItem.id, items[0].id))
    expect(
      (await f.call(`${root}/execute`, 'POST', { itemId: items[0].id, attempt: 1 })).status,
    ).toBe(200)
    expect(provider).toHaveBeenCalledTimes(1)
    expect(await (await f.call(root)).json()).toMatchObject({
      items: [{ state: 'COMPLETED', attempt: 1, charged: true }, { state: 'QUEUED' }],
    })
    vi.stubGlobal('fetch', async () => {
      await db
        .update(workspaceUserAccess)
        .set({ role: 'AGENT' })
        .where(eq(workspaceUserAccess.workspaceId, f.workspaceId))
      return Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                decision: 'ANSWER',
                response: 'Private answer.',
                handoffReason: null,
                containsBusinessFacts: false,
                usedChunkIds: [],
              }),
            },
          },
        ],
      })
    })
    expect(
      (await f.call(`${root}/execute`, 'POST', { itemId: items[1].id, attempt: 0 })).status,
    ).toBe(403)
    expect((await f.call(`/${f.aiId}/question-sets`)).status).toBe(403)
    await db
      .update(workspaceUserAccess)
      .set({ role: 'OWNER' })
      .where(eq(workspaceUserAccess.workspaceId, f.workspaceId))
    expect(await (await f.call(root)).json()).toMatchObject({
      items: [
        { state: 'COMPLETED' },
        {
          state: 'FAILED',
          failureCode: 'FORBIDDEN',
          output: { handoffContext: { facts: { properties: [], tags: [] } } },
        },
      ],
    })
    const other = await fixture()
    expect(
      (
        await other.call(`/${other.aiId}/batches/${id}/execute`, 'POST', {
          itemId: items[0].id,
          attempt: 1,
        })
      ).status,
    ).toBe(404)
    expect(await (await f.call(root)).json()).toMatchObject({
      items: [{ state: 'COMPLETED' }, { state: 'FAILED' }],
    })
  })
  it.each([true, false])(
    'refreshes failed batch tag rules under the frozen published switch %s',
    async (enabled) => {
      const f = await fixture()
      const [support] = await db
        .insert(channel)
        .values({
          workspaceId: f.workspaceId,
          provider: 'FACEBOOK_MESSENGER',
          displayName: 'Support',
        })
        .returning()
      await setMemberChannelAccess(db, {
        workspaceId: f.workspaceId,
        memberId: f.aiId,
        actingUserId: f.userId,
        channelIds: [support.id],
      })
      await f.configCall({ tagsEnabled: enabled })
      const identity = {
        workspaceId: f.workspaceId,
        memberId: f.aiId,
        actingUserId: f.userId,
        providerConfigured: true,
      }
      await publishAiMemberConfig(db, identity)
      const [oldTag, newTag] = await db
        .insert(customerTagDefinition)
        .values([
          { workspaceId: f.workspaceId, name: 'Original classification', level: 'CUSTOMER' },
          { workspaceId: f.workspaceId, name: 'Updated classification', level: 'CUSTOMER' },
        ])
        .returning()
      const original = {
        id: crypto.randomUUID(),
        definitionId: oldTag.id,
        instructions: 'Original rule.',
        enabled: true,
      }
      expect((await f.call(`/${f.aiId}/tag-rules`, 'POST', original)).status).toBe(201)
      const setId = crypto.randomUUID(),
        id = crypto.randomUUID()
      await f.call(`/${f.aiId}/question-sets`, 'POST', {
        id: setId,
        name: 'Classification check',
        questions: ['Please follow up.'],
      })
      expect(
        (
          await f.call(`/${f.aiId}/batches`, 'POST', {
            id,
            questionSetId: setId,
            source: 'PUBLISHED',
          })
        ).status,
      ).toBe(201)
      const root = `/${f.aiId}/batches/${id}`
      const { items } = (await (await f.call(root)).json()) as { items: [{ id: string }] }
      let modelCalls = 0
      const provider = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        if (String(url).endsWith('/embeddings'))
          return Response.json({
            data: [
              { index: 0, embedding: Array.from({ length: 1536 }, (_, i) => (i === 0 ? 1 : 0)) },
            ],
          })
        modelCalls++
        const prompt = String(init?.body)
        if (modelCalls === 1) {
          expect(prompt.includes('Original rule.')).toBe(enabled)
          return Response.json({}, { status: 503 })
        }
        expect(prompt).not.toContain('Original rule.')
        expect(prompt.includes('Current independent rule.')).toBe(enabled)
        return Response.json({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  decision: 'ANSWER',
                  response: 'Thank you.',
                  handoffReason: null,
                  containsBusinessFacts: false,
                  usedChunkIds: [],
                  appendedTags: enabled ? [newTag.id] : [],
                }),
              },
            },
          ],
        })
      })
      vi.stubGlobal('fetch', provider)
      await f.call(`${root}/execute`, 'POST', { itemId: items[0].id, attempt: 0 })
      expect(await (await f.call(root)).json()).toMatchObject({
        items: [{ state: 'FAILED', charged: true }],
      })
      expect(
        (await f.call(`/${f.aiId}/tag-rules`, 'POST', { ...original, enabled: false, revision: 1 }))
          .status,
      ).toBe(201)
      expect(
        (
          await f.call(`/${f.aiId}/tag-rules`, 'POST', {
            id: crypto.randomUUID(),
            definitionId: newTag.id,
            instructions: 'Current independent rule.',
            enabled: true,
          })
        ).status,
      ).toBe(201)
      await f.configCall({ tagsEnabled: !enabled })
      await publishAiMemberConfig(db, identity)
      await db
        .update(aiTestBatchItem)
        .set({ retryAt: new Date(0) })
        .where(eq(aiTestBatchItem.id, items[0].id))
      await db
        .update(aiProviderAttempt)
        .set({ retryAt: new Date(0) })
        .where(eq(aiProviderAttempt.operationId, items[0].id))
      await f.call(`${root}/execute`, 'POST', { itemId: items[0].id, attempt: 1 })
      expect(await (await f.call(root)).json()).toMatchObject({
        items: [
          {
            state: 'COMPLETED',
            charged: true,
            output: { decision: { appendedTags: enabled ? [newTag.id] : [] } },
          },
        ],
      })
      expect(modelCalls).toBe(2)
      expect(await (await f.call('/budget')).json()).toMatchObject({ used: 1, reserved: 0 })
      expect(
        await db.select().from(conversation).where(eq(conversation.workspaceId, f.workspaceId)),
      ).toEqual([])
    },
  )
  it('regenerates invalid retrieval on a failed-question retry while retaining one logical charge', async () => {
    const f = await fixture()
    const doc = await createInlineKnowledgeDocument(db, {
      workspaceId: f.workspaceId,
      knowledgeBaseId: f.baseId,
      createdByUserId: f.userId,
      name: 'Shipping',
      text: 'Shipping is free.',
    })
    const claim = await claimKnowledgeDocument(db, { documentId: doc.id })
    if (!claim) throw new Error('No document claim')
    await completeKnowledgeDocument(db, {
      documentId: doc.id,
      processingStartedAt: claim.processingStartedAt,
      workspaceId: f.workspaceId,
      knowledgeBaseId: f.baseId,
      contentSha256: 'f'.repeat(64),
      embeddingMetadata: { provider: 'alibaba', model: 'qwen3.7-text-embedding', dimensions: 1536 },
      chunks: [
        {
          text: 'Shipping is free.',
          embedding: Array.from({ length: 1536 }, (_, i) => (i === 0 ? 1 : 0)),
        },
      ],
    })
    const setId = crypto.randomUUID(),
      id = crypto.randomUUID()
    await f.call(`/${f.aiId}/question-sets`, 'POST', {
      id: setId,
      name: 'Retrieval',
      questions: ['How is shipping handled?'],
    })
    await f.call(`/${f.aiId}/batches`, 'POST', { id, questionSetId: setId, source: 'DRAFT' })
    const root = `/${f.aiId}/batches/${id}`
    const { items } = (await (await f.call(root)).json()) as { items: [{ id: string }] }
    let embeddings = 0
    vi.stubGlobal('fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).endsWith('/embeddings')) {
        embeddings++
        return Response.json({
          data: [
            {
              index: 0,
              embedding:
                embeddings === 1 ? [1] : Array.from({ length: 1536 }, (_, i) => (i === 0 ? 1 : 0)),
            },
          ],
        })
      }
      const chunkId = /knowledge_chunk id=\\"([^\\]+)\\"/.exec(String(init?.body))?.[1]
      if (!chunkId) throw new Error('No retrieved chunk')
      return Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                decision: 'ANSWER',
                response: 'Shipping is free.',
                handoffReason: null,
                containsBusinessFacts: true,
                usedChunkIds: [chunkId],
              }),
            },
          },
        ],
      })
    })
    await f.call(`${root}/execute`, 'POST', { itemId: items[0].id, attempt: 0 })
    expect(await (await f.call(root)).json()).toMatchObject({
      items: [{ state: 'FAILED', charged: true }],
    })
    await db
      .update(aiTestBatchItem)
      .set({ retryAt: new Date(0) })
      .where(eq(aiTestBatchItem.id, items[0].id))
    await f.call(`${root}/execute`, 'POST', { itemId: items[0].id, attempt: 1 })
    expect(embeddings).toBe(2)
    expect(await (await f.call(root)).json()).toMatchObject({
      items: [
        {
          state: 'COMPLETED',
          charged: true,
          output: { decision: { response: 'Shipping is free.' } },
          chunkIds: [expect.any(String)],
        },
      ],
    })
    expect(await (await f.call('/budget')).json()).toMatchObject({ used: 1, reserved: 0 })
  })
  it('honors provider retry-after and blocks every remaining question when a result is unknown', async () => {
    const f = await fixture()
    const setId = crypto.randomUUID(),
      id = crypto.randomUUID()
    await f.call(`/${f.aiId}/question-sets`, 'POST', {
      id: setId,
      name: 'Pause checks',
      questions: ['Hello.', 'Good morning.'],
    })
    await f.call(`/${f.aiId}/batches`, 'POST', { id, questionSetId: setId, source: 'DRAFT' })
    const root = `/${f.aiId}/batches/${id}`
    const { items } = (await (await f.call(root)).json()) as {
      items: [{ id: string }, { id: string }]
    }
    vi.stubGlobal(
      'fetch',
      async () => new Response(null, { status: 429, headers: { 'retry-after': '600' } }),
    )
    const before = Date.now()
    await f.call(`${root}/execute`, 'POST', { itemId: items[0].id, attempt: 0 })
    const data = (await (await f.call(root)).json()) as { items: [{ retryAt: string }] }
    expect(new Date(data.items[0].retryAt).getTime()).toBeGreaterThanOrEqual(before + 600000)
    expect(
      (await f.call(`${root}/execute`, 'POST', { itemId: items[0].id, attempt: 1 })).status,
    ).toBe(409)
    vi.stubGlobal('fetch', async () => {
      throw new Error('Connection lost')
    })
    await f.call(`${root}/execute`, 'POST', { itemId: items[1].id, attempt: 0 })
    await db
      .update(aiTestBatchItem)
      .set({ retryAt: new Date(0) })
      .where(eq(aiTestBatchItem.id, items[0].id))
    expect(
      (await f.call(`${root}/execute`, 'POST', { itemId: items[0].id, attempt: 1 })).status,
    ).toBe(409)
    expect(await (await f.call(root)).json()).toMatchObject({
      items: [{ state: 'FAILED' }, { state: 'UNKNOWN' }],
    })
  })
  it('shows missing setup resources without changing a saved draft and checks workspace access', async () => {
    const f = await fixture()
    const setup = await f.call(`/${f.aiId}/setup`)
    expect(await setup.json()).toMatchObject({
      memberActive: true,
      providerReady: true,
      knowledgeBaseId: f.baseId,
      readyDocuments: 0,
      channels: [],
    })
    const doc = await createInlineKnowledgeDocument(db, {
      workspaceId: f.workspaceId,
      knowledgeBaseId: f.baseId,
      createdByUserId: f.userId,
      name: 'Greeting',
      text: 'Welcome.',
    })
    const claim = await claimKnowledgeDocument(db, { documentId: doc.id })
    if (!claim) throw new Error('No document claim')
    await completeKnowledgeDocument(db, {
      documentId: doc.id,
      processingStartedAt: claim.processingStartedAt,
      workspaceId: f.workspaceId,
      knowledgeBaseId: f.baseId,
      contentSha256: 'd'.repeat(64),
      embeddingMetadata: { provider: 'alibaba', model: 'qwen3.7-text-embedding', dimensions: 1536 },
      chunks: [
        { text: 'Welcome.', embedding: Array.from({ length: 1536 }, (_, i) => (i === 0 ? 1 : 0)) },
      ],
    })
    const [accessChannel] = await db
      .insert(channel)
      .values({
        workspaceId: f.workspaceId,
        provider: 'FACEBOOK_MESSENGER',
        displayName: 'Support',
      })
      .returning()
    await setMemberChannelAccess(db, {
      workspaceId: f.workspaceId,
      memberId: f.aiId,
      actingUserId: f.userId,
      channelIds: [accessChannel.id],
    })
    expect(await (await f.call(`/${f.aiId}/setup`)).json()).toMatchObject({
      readyDocuments: 1,
      channels: [{ id: accessChannel.id, name: 'Support' }],
    })
    await db.update(channel).set({ status: 'DISABLED' }).where(eq(channel.id, accessChannel.id))
    expect(await (await f.call(`/${f.aiId}/setup`)).json()).toMatchObject({ channels: [] })
    const other = await fixture()
    expect((await other.call(`/${f.aiId}/setup`)).status).toBe(404)
    await db
      .update(workspaceUserAccess)
      .set({ role: 'AGENT' })
      .where(eq(workspaceUserAccess.workspaceId, f.workspaceId))
    expect((await f.call(`/${f.aiId}/setup`)).status).toBe(403)
  })
  it('blocks unaffordable or invalid persona generation and rejects completion after permission revocation', async () => {
    const f = await fixture()
    const input = {
      id: crypto.randomUUID(),
      mode: 'GENERATE',
      brief: 'Give clear explanations.',
      sourceInstructions: '',
    }
    const before = await getAiMemberConfig(db, {
      workspaceId: f.workspaceId,
      memberId: f.aiId,
      actingUserId: f.userId,
    })
    await f.call('/budget', 'PATCH', { monthlyLimit: 0 })
    const provider = vi.fn(async () =>
      Response.json({ choices: [{ message: { content: 'invalid JSON' } }] }),
    )
    vi.stubGlobal('fetch', provider)
    expect((await f.call(`/${f.aiId}/persona`, 'POST', input)).status).toBe(409)
    expect(provider).not.toHaveBeenCalled()
    await f.call('/budget', 'PATCH', { monthlyLimit: 2 })
    expect((await f.call(`/${f.aiId}/persona`, 'POST', input)).status).toBe(502)
    expect((await f.call(`/${f.aiId}/persona`, 'POST', input)).status).toBe(502)
    expect(provider).toHaveBeenCalledTimes(1)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        await db
          .update(workspaceUserAccess)
          .set({ role: 'AGENT' })
          .where(eq(workspaceUserAccess.workspaceId, f.workspaceId))
        return Response.json({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  decision: 'ANSWER',
                  response: 'Be concise.',
                  handoffReason: null,
                  containsBusinessFacts: false,
                  usedChunkIds: [],
                }),
              },
            },
          ],
        })
      }),
    )
    expect(
      (await f.call(`/${f.aiId}/persona`, 'POST', { ...input, id: crypto.randomUUID() })).status,
    ).toBe(403)
    await db
      .update(workspaceUserAccess)
      .set({ role: 'OWNER' })
      .where(eq(workspaceUserAccess.workspaceId, f.workspaceId))
    expect(
      await getAiMemberConfig(db, {
        workspaceId: f.workspaceId,
        memberId: f.aiId,
        actingUserId: f.userId,
      }),
    ).toEqual(before)
    expect(await (await f.call('/budget')).json()).toMatchObject({ used: 2, reserved: 0 })
  })
  it('generates an editable persona candidate without saving or publishing and reuses its charge', async () => {
    const f = await fixture()
    const provider = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(init?.body)).toContain('configuration draft')
      return Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                decision: 'ANSWER',
                response: 'Be a concise support assistant.',
                handoffReason: null,
                containsBusinessFacts: false,
                usedChunkIds: [],
              }),
            },
          },
        ],
      })
    })
    vi.stubGlobal('fetch', provider)
    const before = await getAiMemberConfig(db, {
      workspaceId: f.workspaceId,
      memberId: f.aiId,
      actingUserId: f.userId,
    })
    const input = {
      id: crypto.randomUUID(),
      mode: 'OPTIMIZE',
      brief: 'Use concise explanations.',
      sourceInstructions: before.instructions,
    }
    const response = await f.call(`/${f.aiId}/persona`, 'POST', input)
    expect(response.status).toBe(200)
    const result = await response.json()
    expect(result).toMatchObject({
      candidate: {
        id: input.id,
        sourceInstructions: 'Answer safely.',
        instructions: expect.stringContaining('Be a concise support assistant.'),
      },
    })
    expect((await f.call(`/${f.aiId}/persona`, 'POST', input)).status).toBe(200)
    expect(provider).toHaveBeenCalledTimes(1)
    expect(
      await getAiMemberConfig(db, {
        workspaceId: f.workspaceId,
        memberId: f.aiId,
        actingUserId: f.userId,
      }),
    ).toEqual(before)
    expect(await (await f.call('/budget')).json()).toMatchObject({ used: 1, reserved: 0 })
    const other = await fixture()
    expect((await other.call(`/${f.aiId}/persona`, 'POST', input)).status).toBe(404)
  })
  it('accepts long persona candidates and reserves room for mandatory safety instructions', async () => {
    const f = await fixture()
    let instructions = 'Explain clearly. '.repeat(1000)
    vi.stubGlobal('fetch', async () =>
      Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                decision: 'ANSWER',
                response: instructions,
                handoffReason: null,
                containsBusinessFacts: false,
                usedChunkIds: [],
              }),
            },
          },
        ],
      }),
    )
    const input = { mode: 'GENERATE', brief: 'Give clear explanations.', sourceInstructions: '' }
    const response = await f.call(`/${f.aiId}/persona`, 'POST', {
      ...input,
      id: crypto.randomUUID(),
    })
    expect(response.status).toBe(200)
    const result = (await response.json()) as { candidate: { instructions: string } }
    expect(result.candidate.instructions).toContain(instructions.trim())
    expect(result.candidate.instructions).toContain('Respect current authorization')
    expect(result.candidate.instructions.length).toBeLessThanOrEqual(20000)
    instructions = 'x'.repeat(20000)
    expect(
      (await f.call(`/${f.aiId}/persona`, 'POST', { ...input, id: crypto.randomUUID() })).status,
    ).toBe(502)
  })
  it('uses canonical simulated language codes and retains an explicit language change across turns', async () => {
    const f = await fixture()
    await f.configCall({ automaticLanguageEnabled: true })
    const id = crypto.randomUUID()
    const customer = { properties: [], tags: [], source: '', language: 'English', memory: '' }
    expect(
      (await f.call(`/${f.aiId}/sessions`, 'POST', { id, source: 'DRAFT', customer })).status,
    ).toBe(400)
    const created = await f.call(`/${f.aiId}/sessions`, 'POST', {
      id,
      source: 'DRAFT',
      customer: { ...customer, language: 'EN-us' },
    })
    expect(await created.json()).toMatchObject({ session: { customer: { language: 'en-US' } } })
    let turn = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        const body = String(init?.body)
        expect(body).toContain(
          turn === 2 ? 'Established language: zh' : 'Established language: en-US',
        )
        turn++
        return Response.json({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  decision: 'ANSWER',
                  response: 'Hello',
                  handoffReason: null,
                  containsBusinessFacts: false,
                  usedChunkIds: [],
                  languageSelection:
                    turn === 1
                      ? { language: 'en-US', explicitSwitch: false }
                      : turn === 2
                        ? { language: 'zh', explicitSwitch: true }
                        : null,
                }),
              },
            },
          ],
        })
      }),
    )
    for (const text of ['Hello', 'Please reply in Chinese', 'OK']) {
      const response = await f.call(`/${f.aiId}/test`, 'POST', {
        id: crypto.randomUUID(),
        source: 'DRAFT',
        text,
        sessionId: id,
        generation: 1,
      })
      expect(await response.json()).toMatchObject({ operation: { state: 'COMPLETED' } })
    }
    expect(await (await f.call(`/${f.aiId}/sessions/${id}`)).json()).toMatchObject({
      session: { customer: { language: 'zh' } },
    })
  })
  it('freezes published and selected historical configurations and records invalid model output as failure', async () => {
    const f = await fixture()
    const [accessChannel] = await db
      .insert(channel)
      .values({
        workspaceId: f.workspaceId,
        provider: 'FACEBOOK_MESSENGER',
        displayName: 'Test channel',
      })
      .returning()
    await setMemberChannelAccess(db, {
      workspaceId: f.workspaceId,
      memberId: f.aiId,
      actingUserId: f.userId,
      channelIds: [accessChannel.id],
    })
    const published = await publishAiMemberConfig(db, {
      workspaceId: f.workspaceId,
      memberId: f.aiId,
      actingUserId: f.userId,
      providerConfigured: true,
    })
    const versionId = published.publishedVersionId
    if (!versionId) throw new Error('No published version')
    const sessions = []
    for (const source of ['PUBLISHED', 'VERSION']) {
      const id = crypto.randomUUID()
      const input = {
        id,
        source,
        versionId: source === 'VERSION' ? versionId : undefined,
        customer: { properties: [], tags: [], source: '', language: '', memory: '' },
      }
      expect((await f.call(`/${f.aiId}/sessions`, 'POST', input)).status).toBe(201)
      expect((await f.call(`/${f.aiId}/sessions`, 'POST', input)).status).toBe(201)
      sessions.push(input)
    }
    expect((await f.configCall({ instructions: 'A later draft instruction.' })).status).toBe(200)
    await publishAiMemberConfig(db, {
      workspaceId: f.workspaceId,
      memberId: f.aiId,
      actingUserId: f.userId,
      providerConfigured: true,
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        expect(String(init?.body)).toContain('Answer safely.')
        expect(String(init?.body)).not.toContain('A later draft instruction.')
        return Response.json({ choices: [{ message: { content: 'bad JSON' } }] })
      }),
    )
    for (const session of sessions) {
      const result = await f.call(`/${f.aiId}/test`, 'POST', {
        id: crypto.randomUUID(),
        source: session.source,
        versionId: session.versionId,
        sessionId: session.id,
        generation: 1,
        text: 'Hello',
      })
      expect(await result.json()).toMatchObject({
        operation: { configVersionId: versionId, state: 'FAILED', failureCode: 'INVALID_OUTPUT' },
      })
    }
  })
  it('validates simulated property types and tenant references before spending and protects quota', async () => {
    const f = await fixture()
    const other = await fixture()
    const [number] = await db
      .insert(customerPropertyDefinition)
      .values({ workspaceId: f.workspaceId, name: 'Count', level: 'CUSTOMER', type: 'NUMBER' })
      .returning()
    const [option] = await db
      .insert(customerPropertyDefinition)
      .values({
        workspaceId: f.workspaceId,
        name: 'Color',
        level: 'CONVERSATION',
        type: 'OPTION',
        options: ['Blue'],
      })
      .returning()
    const [tag] = await db
      .insert(customerTagDefinition)
      .values({ workspaceId: other.workspaceId, name: 'Other', level: 'CUSTOMER' })
      .returning()
    const customer = { properties: [], tags: [], source: '', language: '', memory: '' }
    for (const change of [
      { properties: [{ definitionId: number.id, value: 'three' }] },
      { properties: [{ definitionId: option.id, value: 'Red' }] },
      { tags: [tag.id] },
    ])
      expect(
        (
          await f.call(`/${f.aiId}/sessions`, 'POST', {
            id: crypto.randomUUID(),
            source: 'DRAFT',
            customer: { ...customer, ...change },
          })
        ).status,
      ).toBe(400)
    const id = crypto.randomUUID()
    expect(
      (
        await f.call(`/${f.aiId}/sessions`, 'POST', {
          id,
          source: 'DRAFT',
          customer: {
            ...customer,
            properties: [
              { definitionId: number.id, value: 3 },
              { definitionId: option.id, value: 'Blue' },
            ],
          },
        })
      ).status,
    ).toBe(201)
    expect((await f.call('/budget', 'PATCH', { monthlyLimit: 0 })).status).toBe(200)
    const provider = vi.fn()
    vi.stubGlobal('fetch', provider)
    expect(
      (
        await f.call(`/${f.aiId}/test`, 'POST', {
          id: crypto.randomUUID(),
          source: 'DRAFT',
          text: 'Hello',
          sessionId: id,
          generation: 1,
        })
      ).status,
    ).toBe(409)
    expect(provider).not.toHaveBeenCalled()
    expect(await (await f.call(`/${f.aiId}/sessions/${id}`)).json()).toMatchObject({ turns: [] })
  })
  it('cancels an in-flight test durably and rejects old generations and concurrent new turns', async () => {
    const f = await fixture()
    const sessionId = crypto.randomUUID()
    expect(
      (
        await f.call(`/${f.aiId}/sessions`, 'POST', {
          id: sessionId,
          source: 'DRAFT',
          customer: { properties: [], tags: [], source: '', language: '', memory: 'Old memory' },
        })
      ).status,
    ).toBe(201)
    let release: () => void = () => {}
    let started: () => void = () => {}
    const waiting = new Promise<void>((resolve) => {
      release = resolve
    })
    const entered = new Promise<void>((resolve) => {
      started = resolve
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        started()
        await waiting
        return Response.json({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  decision: 'ANSWER',
                  response: 'Late answer',
                  handoffReason: null,
                  containsBusinessFacts: false,
                  usedChunkIds: [],
                }),
              },
            },
          ],
        })
      }),
    )
    const input = {
      id: crypto.randomUUID(),
      source: 'DRAFT',
      text: 'Hello',
      sessionId,
      generation: 1,
    }
    const pending = f.call(`/${f.aiId}/test`, 'POST', input)
    await entered
    expect(
      (await f.call(`/${f.aiId}/test`, 'POST', { ...input, id: crypto.randomUUID() })).status,
    ).toBe(409)
    expect(
      (await f.call(`/${f.aiId}/sessions/${sessionId}/clear`, 'POST', { generation: 1 })).status,
    ).toBe(200)
    release()
    expect(await (await pending).json()).toMatchObject({
      operation: {
        state: 'CANCELLED',
        failureCode: 'TEST_CLEARED',
        output: { testContext: { customer: { memory: 'Old memory' } } },
      },
    })
    expect(await (await f.call(`/${f.aiId}/sessions/${sessionId}`)).json()).toMatchObject({
      session: { customer: { memory: '' } },
      turns: [],
    })
    expect((await f.call(`/${f.aiId}/test`, 'POST', input)).status).toBe(400)
    const other = await fixture()
    expect((await other.call(`/${f.aiId}/sessions/${sessionId}`)).status).toBe(404)
    await db
      .update(workspaceUserAccess)
      .set({ role: 'AGENT' })
      .where(eq(workspaceUserAccess.workspaceId, f.workspaceId))
    expect((await f.call(`/${f.aiId}/sessions/${sessionId}`)).status).toBe(403)
  })
  it('keeps multi-turn tests and simulated memory isolated and clears the context', async () => {
    const f = await fixture()
    const sessionId = crypto.randomUUID()
    const created = await f.call(`/${f.aiId}/sessions`, 'POST', {
      id: sessionId,
      source: 'DRAFT',
      customer: {
        properties: [],
        tags: [],
        source: 'Demo',
        language: 'en',
        memory: 'Likes colors',
      },
    })
    expect(created.status).toBe(201)
    const provider = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).includes('embeddings'))
        return Response.json({
          data: [{ embedding: Array.from({ length: 1536 }, (_, i) => (i === 0 ? 1 : 0)) }],
        })
      const prompt = String(init?.body)
      expect(prompt).toContain('Likes colors')
      const second = prompt.includes('The second option')
      if (second) expect(prompt).toContain('Choose blue or green.')
      return Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                decision: 'ANSWER',
                response: second ? 'You chose green.' : 'Choose blue or green.',
                handoffReason: null,
                containsBusinessFacts: false,
                usedChunkIds: [],
              }),
            },
          },
        ],
      })
    })
    vi.stubGlobal('fetch', provider)
    for (const text of ['Show two colors', 'The second option']) {
      const response = await f.call(`/${f.aiId}/test`, 'POST', {
        id: crypto.randomUUID(),
        source: 'DRAFT',
        text,
        sessionId,
        generation: 1,
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ operation: { state: 'COMPLETED' } })
    }
    const read = await f.call(`/${f.aiId}/sessions/${sessionId}`)
    expect(await read.json()).toMatchObject({
      session: { generation: 1 },
      turns: [{ input: 'Show two colors' }, { input: 'The second option' }],
    })
    expect(
      (await f.call(`/${f.aiId}/sessions/${sessionId}/clear`, 'POST', { generation: 1 })).status,
    ).toBe(200)
    expect(await (await f.call(`/${f.aiId}/sessions/${sessionId}`)).json()).toMatchObject({
      session: { generation: 2, customer: { memory: '', tags: [], properties: [] } },
      turns: [],
    })
    expect(
      await db.select().from(conversation).where(eq(conversation.workspaceId, f.workspaceId)),
    ).toEqual([])
  })
  it('simulates semantic handoff with the configured timezone and keeps rule writes authorized', async () => {
    const f = await fixture()
    await f.configCall({ timeZone: 'Asia/Hong_Kong' })
    const root = `/${f.aiId}/handoff-rules`
    const created = await f.call(root, 'POST', {
      name: 'Comparison',
      enabled: true,
      condition: { kind: 'SEMANTIC', text: 'Compare options today' },
    })
    expect(created.status).toBe(201)
    const { rule } = (await created.json()) as { rule: { id: string; revision: number } }
    const calls = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(init?.body)).toContain('Asia/Hong_Kong')
      return Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                decision: 'HANDOFF',
                response: '',
                handoffReason: 'KEYWORD',
                handoffRuleId: rule.id,
                containsBusinessFacts: false,
                usedChunkIds: [],
              }),
            },
          },
        ],
      })
    })
    vi.stubGlobal('fetch', calls)
    const input = { id: crypto.randomUUID(), source: 'DRAFT', text: 'Compare options today' }
    const result = await f.call(`/${f.aiId}/test`, 'POST', input)
    expect(result.status).toBe(200)
    expect(await result.json()).toMatchObject({
      operation: {
        state: 'COMPLETED',
        output: { kind: 'HANDOFF', decision: { handoffRuleId: rule.id } },
      },
    })
    expect((await f.call(`/${f.aiId}/test`, 'POST', input)).status).toBe(200)
    expect(calls).toHaveBeenCalledTimes(1)
    expect(
      await db.select().from(conversation).where(eq(conversation.workspaceId, f.workspaceId)),
    ).toEqual([])
    const patch = {
      name: 'Comparison',
      enabled: false,
      revision: rule.revision,
      condition: { kind: 'SEMANTIC', text: 'Compare options today' },
    }
    expect((await f.call(`${root}/${rule.id}`, 'PATCH', patch)).status).toBe(200)
    expect((await f.call(`${root}/${rule.id}`, 'PATCH', patch)).status).toBe(400)
    const other = await fixture()
    expect((await other.call(`/${f.aiId}/handoff-rules`)).status).toBe(404)
    await db
      .update(workspaceUserAccess)
      .set({ role: 'AGENT' })
      .where(eq(workspaceUserAccess.workspaceId, f.workspaceId))
    expect((await f.call(root)).status).toBe(403)
    expect((await f.call(`${root}/${rule.id}`, 'DELETE', { revision: 2 })).status).toBe(403)
  })
  it('previews a grounded private asset in the sandbox without creating a conversation or sending', async () => {
    const f = await fixture()
    const assetId = crypto.randomUUID()
    await db.insert(mediaAsset).values({
      id: assetId,
      workspaceId: f.workspaceId,
      title: 'Guide',
      filename: 'guide.pdf',
      kind: 'FILE',
      mimeType: 'application/pdf',
      byteSize: 12,
      sha256: 'a'.repeat(64),
      storageKey: 'test/guide',
      inLibrary: true,
    })
    const doc = await createInlineKnowledgeDocument(db, {
      workspaceId: f.workspaceId,
      knowledgeBaseId: f.baseId,
      createdByUserId: f.userId,
      name: 'Guide',
      text: 'Setup instructions.',
      mediaAssetId: assetId,
    })
    const claim = await claimKnowledgeDocument(db, { documentId: doc.id })
    if (!claim) throw new Error('Description not claimed')
    const vector = Array.from({ length: 1536 }, (_, i) => (i === 0 ? 1 : 0))
    await completeKnowledgeDocument(db, {
      documentId: doc.id,
      processingStartedAt: claim.processingStartedAt,
      workspaceId: f.workspaceId,
      knowledgeBaseId: f.baseId,
      contentSha256: 'b'.repeat(64),
      embeddingMetadata: { provider: 'alibaba', model: 'qwen3.7-text-embedding', dimensions: 1536 },
      chunks: [{ text: 'Setup instructions.', embedding: vector }],
    })
    const [chunk] = await db
      .select()
      .from(knowledgeChunk)
      .where(eq(knowledgeChunk.knowledgeDocumentId, doc.id))
    const calls = vi.fn(async (url: RequestInfo | URL) =>
      String(url).endsWith('/embeddings')
        ? Response.json({ data: [{ index: 0, embedding: vector }] })
        : Response.json({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    decision: 'ANSWER',
                    response: 'Here is the guide.',
                    handoffReason: null,
                    containsBusinessFacts: false,
                    usedChunkIds: [chunk.id],
                    mediaAssetId: assetId,
                  }),
                },
              },
            ],
          }),
    )
    vi.stubGlobal('fetch', calls)
    const result = await f.call(`/${f.aiId}/test`, 'POST', {
      id: crypto.randomUUID(),
      source: 'DRAFT',
      text: 'Send the guide.',
    })
    expect(result.status).toBe(200)
    expect(await result.json()).toMatchObject({
      operation: { state: 'COMPLETED', output: { decision: { mediaAssetId: assetId } } },
    })
    expect(
      await db.select().from(conversation).where(eq(conversation.workspaceId, f.workspaceId)),
    ).toEqual([])
    expect(calls).toHaveBeenCalledTimes(2)
  })
  it('isolates idempotent tests, retains diagnostics and feedback, and rejects unauthorized reads', async () => {
    const f = await fixture()
    const calls = vi.fn(async () =>
      Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                decision: 'ANSWER',
                response: 'Hello. How can I help?',
                handoffReason: null,
                containsBusinessFacts: false,
                usedChunkIds: [],
              }),
            },
          },
        ],
      }),
    )
    vi.stubGlobal('fetch', calls)
    const input = { id: crypto.randomUUID(), source: 'DRAFT', text: 'Hello' }
    const results = await Promise.all([
      f.call(`/${f.aiId}/test`, 'POST', input),
      f.call(`/${f.aiId}/test`, 'POST', input),
    ])
    expect(results.map((r) => r.status)).toEqual([200, 200])
    expect(calls).toHaveBeenCalledOnce()
    const diagnostic = await f.call(`/${input.id}/diagnostics`)
    expect(diagnostic.status).toBe(200)
    expect(await diagnostic.json()).toMatchObject({
      operation: { state: 'COMPLETED', input: 'Hello', charged: true },
      attempts: [{ state: 'SUCCESS' }],
    })
    const feedback = await f.call(`/${input.id}/feedback`, 'POST', {
      category: 'MODEL',
      note: 'Check tone',
    })
    expect(((await feedback.json()) as { feedback: unknown[] }).feedback).toMatchObject([
      { category: 'MODEL', note: 'Check tone' },
    ])
    expect(
      await db.select().from(conversation).where(eq(conversation.workspaceId, f.workspaceId)),
    ).toEqual([])
    await db
      .update(workspaceUserAccess)
      .set({ role: 'AGENT' })
      .where(eq(workspaceUserAccess.workspaceId, f.workspaceId))
    expect((await f.call(`/${input.id}/diagnostics`)).status).toBe(403)
    expect((await f.call('/budget')).status).toBe(403)
    await db
      .update(workspaceUserAccess)
      .set({ role: 'OWNER' })
      .where(eq(workspaceUserAccess.workspaceId, f.workspaceId))
    const other = await fixture()
    expect((await other.call(`/${input.id}/diagnostics`)).status).toBe(404)
    await db.update(member).set({ status: 'DISABLED' }).where(eq(member.workspaceId, f.workspaceId))
    expect((await f.call(`/${input.id}/diagnostics`)).status).toBe(403)
  })
  it('validates and replaces an advertising draft table atomically', async () => {
    const f = await fixture()
    const original = [{ adId: '123456', content: 'Lamp reference.' }]
    const accepted = await f.configCall({ adLearningEnabled: true, adMappings: original })
    expect(accepted.status).toBe(200)
    const saved = (await accepted.json()) as {
      config: { adMappings: unknown; adLearningEnabled: boolean }
    }
    expect(saved.config).toMatchObject({ adLearningEnabled: true, adMappings: original })
    expect((await f.configCall({ adMappings: [...original, ...original] })).status).toBe(400)
    expect(
      (
        await f.configCall({
          adMappings: [{ adId: '123', content: 'A', url: 'https://example.test' }],
        })
      ).status,
    ).toBe(400)
    expect(
      (
        await getAiMemberConfig(db, {
          workspaceId: f.workspaceId,
          memberId: f.aiId,
          actingUserId: f.userId,
        })
      ).adMappings,
    ).toEqual(original)
    const other = await fixture()
    expect((await other.configCall({ adMappings: [] }, f.aiId)).status).toBe(404)
    expect(
      (await f.configCall({ adMappings: [{ adId: '1', content: 'x'.repeat(1024 * 1024) }] }))
        .status,
    ).toBe(413)
    const latest = await f.configCall({
      adMappings: [{ adId: '789', content: 'Torch reference.' }],
    })
    expect(
      ((await latest.json()) as { config: { adMappings: unknown } }).config.adMappings,
    ).toEqual([{ adId: '789', content: 'Torch reference.' }])
    expect((await f.configCall({ adMappings: [] })).status).toBe(200)
    expect((await f.configCall({ naturalToneEnabled: true, replyWaitEnabled: false })).status).toBe(
      200,
    )
    expect((await f.configCall({ replyWaitEnabled: 'false' })).status).toBe(400)
    expect((await f.configCall({ naturalToneEnabled: 'true' })).status).toBe(400)
    expect(
      (await f.configCall({ automaticLanguageEnabled: true, timeZone: 'America/New_York' })).status,
    ).toBe(200)
    expect((await f.configCall({ automaticLanguageEnabled: 'true' })).status).toBe(400)
    expect((await f.configCall({ timeZone: 'Invalid/Zone' })).status).toBe(400)
    expect((await f.configCall({ timeZone: '' })).status).toBe(400)
    await db
      .update(workspaceUserAccess)
      .set({ role: 'AGENT' })
      .where(eq(workspaceUserAccess.workspaceId, f.workspaceId))
    expect((await f.configCall({ adLearningEnabled: false })).status).toBe(403)
    expect((await f.configCall({ automaticLanguageEnabled: false, timeZone: 'UTC' })).status).toBe(
      403,
    )
    expect((await f.configCall({ naturalToneEnabled: false, replyWaitEnabled: true })).status).toBe(
      403,
    )
  })
  it('deduplicates operations and separates tests across UTC date boundaries', async () => {
    const f = await fixture()
    const common = {
      workspaceId: f.workspaceId,
      memberId: f.aiId,
      kind: 'TEST',
      state: 'COMPLETED',
      charged: true,
      period: '2026-09',
    }
    await db.insert(aiOperation).values([
      { ...common, id: crypto.randomUUID(), createdAt: new Date('2026-09-01T23:59:59Z') },
      { ...common, id: crypto.randomUUID(), createdAt: new Date('2026-09-02T00:00:00Z') },
    ])
    const identity = {
      workspaceId: f.workspaceId,
      actingUserId: f.userId,
      memberId: f.aiId,
      from: new Date('2026-09-02T00:00:00Z'),
      to: new Date('2026-09-03T00:00:00Z'),
      timezone: 'Asia/Hong_Kong',
    }
    const analytics = await getAiAnalytics(db, identity)
    expect(analytics.usage).toMatchObject([
      { kind: 'TEST', operations: 1, charged: 1, provider_attempts: 0 },
    ])
    expect(analytics.runs).toEqual([])
    expect(analytics.replies).toEqual([])
    expect(analytics.providerCost).toBeNull()
  })
  it('pages every diagnostic record even when timestamps are identical', async () => {
    const f = await fixture()
    const createdAt = new Date()
    await db.insert(aiOperation).values(
      Array.from({ length: 105 }, () => ({
        id: crypto.randomUUID(),
        workspaceId: f.workspaceId,
        memberId: f.aiId,
        kind: 'TEST',
        period: '2026-10',
        createdAt,
      })),
    )
    const identity = { workspaceId: f.workspaceId, memberId: f.aiId, actingUserId: f.userId }
    const first = await listAiDiagnostics(db, identity)
    expect(first.tests).toHaveLength(100)
    if (!first.nextCursor) throw new Error('No cursor')
    const second = await listAiDiagnostics(db, { ...identity, cursor: first.nextCursor })
    expect(second.tests).toHaveLength(5)
    expect(new Set([...first.tests, ...second.tests].map(({ id }) => id)).size).toBe(105)
    expect(second.nextCursor).toBeNull()
  })
})

async function fixture() {
  const email = `${crypto.randomUUID()}@example.com`
  const password = 'correct-horse-battery-staple'
  const created = await createAuth(db, env).api.signUpEmail({
    body: { email, password, name: 'Operations owner' },
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
    userName: 'Owner',
    name: 'AI operations',
  })
  const base = await createKnowledgeBase(db, {
    workspaceId: workspace.id,
    createdByUserId: created.user.id,
    name: 'Facts',
  })
  const ai = await createAiMember(db, {
    workspaceId: workspace.id,
    createdByUserId: created.user.id,
    displayName: 'AI',
  })
  await updateAiMemberConfig(db, {
    workspaceId: workspace.id,
    memberId: ai.id,
    actingUserId: created.user.id,
    instructions: 'Answer safely.',
    responseLanguage: 'English',
    knowledgeBaseId: base.id,
  })
  return {
    workspaceId: workspace.id,
    userId: created.user.id,
    aiId: ai.id,
    baseId: base.id,
    configCall: (body: unknown, memberId = ai.id) =>
      app.request(
        `/api/workspaces/${workspace.id}/ai-members/${memberId}/config`,
        {
          method: 'PATCH',
          headers: { Cookie: cookie, 'Content-Type': 'application/json', Origin: env.APP_URL },
          body: JSON.stringify(body),
        },
        env,
      ),
    call: (path: string, method = 'GET', body?: unknown) =>
      app.request(
        `/api/workspaces/${workspace.id}/ai-operations${path}`,
        {
          method,
          headers: { Cookie: cookie, 'Content-Type': 'application/json', Origin: env.APP_URL },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
        env,
      ),
  }
}
