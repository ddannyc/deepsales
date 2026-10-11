import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  aiOperation,
  bootstrapWorkspace,
  conversation,
  createAiMember,
  createDatabase,
  createKnowledgeBase,
  getAiAnalytics,
  getAiMemberConfig,
  listAiDiagnostics,
  member,
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
    await db
      .update(workspaceUserAccess)
      .set({ role: 'AGENT' })
      .where(eq(workspaceUserAccess.workspaceId, f.workspaceId))
    expect((await f.configCall({ adLearningEnabled: false })).status).toBe(403)
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
