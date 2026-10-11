import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  bootstrapWorkspace,
  connectFacebookPages,
  createDatabase,
  getAiBudget,
  member,
  message,
  messageTranslation,
  processFacebookInbound,
  saveAiBudget,
  setMemberChannelAccess,
  takeOverConversation,
} from '@deepsales/db'
import { and, eq } from 'drizzle-orm'
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
} as unknown as Bindings

function providerResponse(text = 'Hello') {
  return Response.json({
    choices: [
      {
        message: {
          content: JSON.stringify({
            decision: 'ANSWER',
            response: text,
            handoffReason: null,
            containsBusinessFacts: false,
            usedChunkIds: [],
          }),
        },
      },
    ],
  })
}

describe.skipIf(!connectionString)('message translation routes', () => {
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

  it('retains originals, charges once, and requires the persisted version before creating a reply', async () => {
    const f = await fixture()
    const calls = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body))
      expect(payload.messages[0].content).toContain('Translate')
      expect(JSON.parse(payload.messages[1].content)).toEqual({ text: '你好' })
      return providerResponse()
    })
    vi.stubGlobal('fetch', calls)
    const input = {
      id: crypto.randomUUID(),
      sourceVersion: crypto.randomUUID(),
      sourceText: '你好',
      targetLanguage: 'en',
    }
    expect((await f.call('translations', input)).status).toBe(200)
    const result = (await (await f.call('translations', input)).json()) as {
      translation: { id: string; translatedText: string }
    }
    expect(result.translation.translatedText).toBe('Hello')
    expect(calls).toHaveBeenCalledTimes(1)
    expect(await getAiBudget(db, f.identity)).toMatchObject({ used: 1 })
    expect(await f.outbound()).toEqual([])
    const confirmation = {
      id: input.id,
      sourceText: input.sourceText,
      sourceVersion: input.sourceVersion,
      targetLanguage: input.targetLanguage,
    }
    const reply = { text: 'Hello', clientKey: input.id, translation: confirmation }
    for (const invalid of [
      { sourceText: '再见' },
      { sourceVersion: crypto.randomUUID() },
      { targetLanguage: 'fr' },
    ]) {
      expect(
        (await f.call('replies', { ...reply, translation: { ...confirmation, ...invalid } }))
          .status,
      ).toBe(400)
    }
    expect(await f.outbound()).toEqual([])
    expect((await f.call('replies', reply)).status).toBe(201)
    expect((await f.call('replies', reply)).status).toBe(201)
    expect(await f.outbound()).toHaveLength(1)
    const [record] = await db
      .select()
      .from(messageTranslation)
      .where(eq(messageTranslation.id, input.id))
    expect(record).toMatchObject({
      sourceText: '你好',
      translatedText: 'Hello',
      sentMessageId: (await f.outbound())[0].id,
    })

    const incoming = {
      id: crypto.randomUUID(),
      sourceVersion: crypto.randomUUID(),
      sourceMessageId: f.messageId,
      targetLanguage: 'en',
    }
    expect((await f.call('translations', incoming)).status).toBe(200)
    expect(
      (
        await f.call('translations', {
          ...incoming,
          id: crypto.randomUUID(),
          sourceVersion: crypto.randomUUID(),
        })
      ).status,
    ).toBe(200)
    expect(calls).toHaveBeenCalledTimes(2)
    const [original] = await db.select().from(message).where(eq(message.id, f.messageId))
    expect(original.text).toBe('你好')
  })

  it('does not call a provider on quota exhaustion or foreign conversation access', async () => {
    const f = await fixture()
    const other = await fixture()
    const calls = vi.fn(async () => providerResponse())
    vi.stubGlobal('fetch', calls)
    const input = {
      id: crypto.randomUUID(),
      sourceVersion: crypto.randomUUID(),
      sourceText: '你好',
      targetLanguage: 'en',
    }
    expect((await other.call('translations', input, f.conversationId)).status).toBe(404)
    await saveAiBudget(db, { ...f.identity, monthlyLimit: 0 })
    const response = await f.call('translations', input)
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: { code: 'QUOTA_EXHAUSTED' } })
    expect(calls).not.toHaveBeenCalled()
    expect(await f.outbound()).toEqual([])
  })

  it('accepts long historical translations while retaining the outbound text limit', async () => {
    const f = await fixture()
    const translatedText = 'Translated sentence. '.repeat(150)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => providerResponse(translatedText)),
    )
    const common = { sourceVersion: crypto.randomUUID(), targetLanguage: 'en' }
    const incoming = await f.call('translations', {
      ...common,
      id: crypto.randomUUID(),
      sourceMessageId: f.messageId,
    })
    expect(incoming.status).toBe(200)
    expect(await incoming.json()).toMatchObject({
      translation: { translatedText: translatedText.trim() },
    })
    expect(
      (await f.call('translations', { ...common, id: crypto.randomUUID(), sourceText: '你好' }))
        .status,
    ).toBe(400)
    expect(await f.outbound()).toEqual([])
  })

  it('rechecks channel access after the provider completes and never exposes a revoked result', async () => {
    const f = await fixture()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        await setMemberChannelAccess(db, { ...f.identity, memberId: f.memberId, channelIds: [] })
        return providerResponse()
      }),
    )
    const input = {
      id: crypto.randomUUID(),
      sourceVersion: crypto.randomUUID(),
      sourceText: '你好',
      targetLanguage: 'en',
    }
    expect((await f.call('translations', input)).status).toBe(403)
    const [record] = await db
      .select()
      .from(messageTranslation)
      .where(eq(messageTranslation.id, input.id))
    expect(record.translatedText).toBeNull()
    expect(await f.outbound()).toEqual([])
  })

  it('pauses ambiguous provider failures without a second charge or automatic send', async () => {
    const f = await fixture()
    const calls = vi.fn(async () => {
      throw new Error('network unavailable')
    })
    vi.stubGlobal('fetch', calls)
    const input = {
      id: crypto.randomUUID(),
      sourceVersion: crypto.randomUUID(),
      sourceText: '你好',
      targetLanguage: 'en',
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await f.call('translations', input)
      expect(response.status).toBe(409)
      expect(await response.json()).toMatchObject({ error: { code: 'OPERATION_PAUSED' } })
    }
    expect(calls).toHaveBeenCalledTimes(1)
    expect(await getAiBudget(db, f.identity)).toMatchObject({ used: 1 })
    expect(await f.outbound()).toEqual([])
  })
})

async function fixture() {
  const email = `${crypto.randomUUID()}@example.com`
  const password = 'correct-horse-battery-staple'
  const created = await createAuth(db, env).api.signUpEmail({
    body: { email, password, name: 'Translation owner' },
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
    name: 'Translation test',
  })
  const [owner] = await db.select().from(member).where(eq(member.workspaceId, workspace.id))
  const pageId = crypto.randomUUID()
  const [connected] = await connectFacebookPages(db, {
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
  await setMemberChannelAccess(db, {
    workspaceId: workspace.id,
    actingUserId: created.user.id,
    memberId: owner.id,
    channelIds: [connected.id],
  })
  const received = await processFacebookInbound(db, {
    ingressId: crypto.randomUUID(),
    pageId,
    externalUserId: crypto.randomUUID(),
    externalMessageId: crypto.randomUUID(),
    text: '你好',
    providerSentAt: new Date(),
    receivedAt: new Date(),
    payloadSha256: 'a'.repeat(64),
    eventFragment: {},
  })
  if (received.kind !== 'created') throw new Error('Inbound was not created')
  await takeOverConversation(db, {
    workspaceId: workspace.id,
    conversationId: received.conversationId,
    actingUserId: created.user.id,
  })
  return {
    identity: { workspaceId: workspace.id, actingUserId: created.user.id },
    memberId: owner.id,
    conversationId: received.conversationId,
    messageId: received.messageId,
    call: (path: string, body: unknown, conversationId = received.conversationId) =>
      app.request(
        `/api/workspaces/${workspace.id}/conversations/${conversationId}/${path}`,
        {
          method: 'POST',
          headers: { Cookie: cookie, 'Content-Type': 'application/json', Origin: env.APP_URL },
          body: JSON.stringify(body),
        },
        env,
      ),
    outbound: () =>
      db
        .select()
        .from(message)
        .where(
          and(
            eq(message.conversationId, received.conversationId),
            eq(message.direction, 'OUTBOUND'),
          ),
        ),
  }
}
