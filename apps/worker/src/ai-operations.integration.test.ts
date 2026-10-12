import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  aiOperation,
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
import { eq } from 'drizzle-orm'
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
