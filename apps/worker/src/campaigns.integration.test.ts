import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  bootstrapWorkspace,
  channelIdentity,
  connectFacebookPages,
  conversation,
  createDatabase,
  facebookMessagingWindow,
  member,
  message,
  processFacebookInbound,
  setMemberChannelAccess,
} from '@deepsales/db'
import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Pool } from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createAuth } from './auth'
import type { Bindings } from './bindings'
import { encryptFacebookToken } from './facebook'
import { app, handleOutboundBatch, handleScheduled } from './index'

const connectionString = process.env.DATABASE_URL
const pool = new Pool({ connectionString })
const db = createDatabase(pool)
const tokenKey = btoa(String.fromCharCode(...new Uint8Array(32)))
const env = {
  APP_URL: 'http://localhost:8787',
  AUTH_RATE_LIMITER: { limit: async () => ({ success: true }) },
  BETTER_AUTH_SECRET: 'test-only-secret-that-is-at-least-32-characters',
  HYPERDRIVE: { connectionString },
  META_APP_ID: 'test-app',
  META_APP_SECRET: 'test-app-secret',
  META_GRAPH_API_VERSION: 'v26.0',
  TOKEN_ENCRYPTION_KEY: tokenKey,
} as unknown as Bindings

describe.skipIf(!connectionString)('ordinary campaigns', () => {
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

  it('saves an explicit deduplicated audience without sending, then executes once without taking ownership', async () => {
    const f = await fixture()
    const id = crypto.randomUUID()
    const created = await f.call('', 'POST', {
      id,
      name: 'Neutral update',
      channelId: f.channelId,
      identityIds: [f.identityId, f.identityId],
      text: 'The library closes at five.',
    })
    expect(created.status).toBe(201)
    expect(await created.json()).toMatchObject({
      campaign: { id, status: 'DRAFT', identityIds: [f.identityId] },
    })
    expect(
      (await db.select().from(message).where(eq(message.conversationId, f.conversationId))).length,
    ).toBe(1)
    expect((await f.call(`/${id}/execute`, 'POST', {})).status).toBe(200)
    expect((await f.call(`/${id}/execute`, 'POST', {})).status).toBe(200)
    const queued: unknown[] = []
    await handleScheduled({
      ...env,
      OUTBOUND_QUEUE: {
        send: async (body: unknown) => {
          queued.push(body)
        },
      } as unknown as Queue,
    })
    const pending = await db
      .select()
      .from(message)
      .where(eq(message.conversationId, f.conversationId))
    expect(pending.filter((m) => m.direction === 'OUTBOUND')).toHaveLength(1)
    const reply = pending.find((m) => m.direction === 'OUTBOUND')
    if (!reply) throw new Error('Campaign message missing')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ message_id: 'neutral-reply' })),
    )
    const item = () => ({
      body: { v: 1, type: 'facebook.outbound', messageId: reply.id },
      ack: vi.fn(),
      retry: vi.fn(),
    })
    await handleOutboundBatch({ messages: [item()] } as unknown as MessageBatch<unknown>, env)
    await handleOutboundBatch({ messages: [item()] } as unknown as MessageBatch<unknown>, env)
    expect(globalThis.fetch).toHaveBeenCalledOnce()
    const provider = vi.mocked(globalThis.fetch)
    expect(JSON.parse(String(provider.mock.calls[0]?.[1]?.body))).toMatchObject({
      messaging_type: 'UPDATE',
    })
    expect(await (await f.call(`/${id}`, 'GET')).json()).toMatchObject({
      runs: [{ recipients: [{ state: 'SUCCESS' }] }],
    })
    const [current] = await db
      .select()
      .from(conversation)
      .where(eq(conversation.id, f.conversationId))
    expect(current.assigneeMemberId).toBeNull()
    expect(queued).toContainEqual({ v: 1, type: 'facebook.outbound', messageId: reply.id })
  })

  it('rechecks authorization and the normal window at delivery without sending revoked messages', async () => {
    for (const revoke of ['ACCESS', 'WINDOW']) {
      const f = await fixture()
      const id = crypto.randomUUID()
      expect(
        (
          await f.call('', 'POST', {
            id,
            name: 'Permission check',
            channelId: f.channelId,
            identityIds: [f.identityId],
            text: 'Neutral update',
          })
        ).status,
      ).toBe(201)
      expect((await f.call(`/${id}/execute`, 'POST', {})).status).toBe(200)
      const messages = await db
        .select()
        .from(message)
        .where(eq(message.conversationId, f.conversationId))
      const reply = messages.find((m) => m.direction === 'OUTBOUND')
      if (!reply) throw new Error('Missing outbound')
      if (revoke === 'ACCESS')
        await setMemberChannelAccess(db, {
          workspaceId: f.workspaceId,
          memberId: f.memberId,
          actingUserId: f.userId,
          channelIds: [],
        })
      else
        await db
          .update(facebookMessagingWindow)
          .set({ eligibleUntil: new Date(0) })
          .where(eq(facebookMessagingWindow.channelIdentityId, f.identityId))
      const fetcher = vi.fn()
      vi.stubGlobal('fetch', fetcher)
      await handleOutboundBatch(
        {
          messages: [
            {
              body: { v: 1, type: 'facebook.outbound', messageId: reply.id },
              ack: vi.fn(),
              retry: vi.fn(),
            },
          ],
        } as unknown as MessageBatch<unknown>,
        env,
      )
      expect(fetcher).not.toHaveBeenCalled()
      const [failed] = await db.select().from(message).where(eq(message.id, reply.id))
      expect(failed.deliveryState).toBe('FAILED')
      expect(failed.failureCode).toBe('CAMPAIGN_NOT_PERMITTED')
    }
  })

  it('rejects foreign identities and serializes concurrent execution against the saved audience', async () => {
    const f = await fixture()
    const foreign = await fixture()
    const id = crypto.randomUUID()
    const input = {
      id,
      name: 'Concurrent update',
      channelId: f.channelId,
      identityIds: [f.identityId],
      text: 'Neutral update',
    }
    expect((await f.call('', 'POST', { ...input, identityIds: [foreign.identityId] })).status).toBe(
      400,
    )
    expect((await f.call('', 'POST', input)).status).toBe(201)
    const executions = await Promise.all([
      f.call(`/${id}/execute`, 'POST', {}),
      f.call(`/${id}/execute`, 'POST', {}),
    ])
    expect(executions.map((r) => r.status)).toEqual([200, 200])
    expect(await (await f.call(`/${id}`)).json()).toMatchObject({
      runs: [{ recipients: [{ channelIdentityId: f.identityId, state: 'WAITING' }] }],
    })
    const messages = await db
      .select()
      .from(message)
      .where(eq(message.conversationId, f.conversationId))
    expect(messages.filter((m) => m.direction === 'OUTBOUND')).toHaveLength(1)
  })
})

async function fixture() {
  const email = `${crypto.randomUUID()}@example.com`
  const password = 'correct-horse-battery-staple'
  const created = await createAuth(db, env).api.signUpEmail({
    body: { email, password, name: 'Campaign owner' },
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
    name: 'Campaign test',
  })
  const [owner] = await db.select().from(member).where(eq(member.workspaceId, workspace.id))
  if (!owner) throw new Error('No member')
  const pageId = crypto.randomUUID()
  const encrypted = await encryptFacebookToken('test-page-token', tokenKey)
  const [connected] = await connectFacebookPages(db, {
    workspaceId: workspace.id,
    actingUserId: created.user.id,
    pages: [
      {
        pageId,
        displayName: 'Support',
        encryptedPageAccessToken: encrypted.ciphertext,
        tokenIv: encrypted.iv,
        tokenKeyVersion: encrypted.keyVersion,
      },
    ],
  })
  if (!connected) throw new Error('No channel')
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
    text: 'Hello',
    receivedAt: new Date(),
    providerSentAt: new Date(),
    payloadSha256: 'a'.repeat(64),
    eventFragment: {},
  })
  if (received.kind !== 'created') throw new Error('No inbound')
  const [current] = await db
    .select()
    .from(conversation)
    .where(eq(conversation.id, received.conversationId))
  const [identity] = await db
    .select()
    .from(channelIdentity)
    .where(eq(channelIdentity.id, current.channelIdentityId))
  return {
    workspaceId: workspace.id,
    memberId: owner.id,
    userId: created.user.id,
    conversationId: received.conversationId,
    identityId: identity.id,
    channelId: connected.id,
    call: (path: string, method = 'GET', body?: unknown) =>
      app.request(
        `/api/workspaces/${workspace.id}/campaigns${path}`,
        {
          method,
          headers: { Cookie: cookie, Origin: env.APP_URL, 'Content-Type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
        env,
      ),
  }
}
