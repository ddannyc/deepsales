import { createHmac } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  bootstrapWorkspace,
  connectFacebookPages,
  conversation,
  channelIdentity,
  workspaceUserAccess,
  memberChannelAccess,
  createDatabase,
  member,
  message,
  processFacebookInbound,
  takeOverConversation,
} from '@deepsales/db'
import { and, eq, sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAuth } from './auth'
import type { Bindings } from './bindings'
import { app, handleWebhookBatch } from './index'

const connectionString = process.env.DATABASE_URL
const pool = new Pool({ connectionString })
const db = createDatabase(pool)
const env = {
  APP_URL: 'http://localhost:8787',
  AUTH_RATE_LIMITER: { limit: async () => ({ success: true }) },
  BETTER_AUTH_SECRET: 'test-only-secret-that-is-at-least-32-characters',
  HYPERDRIVE: { connectionString },
} as unknown as Bindings

describe.skipIf(!connectionString)('inbox reading through authenticated routes', () => {
  beforeAll(() =>
    migrate(db, {
      migrationsFolder: resolve(
        dirname(fileURLToPath(import.meta.url)),
        '../../../packages/db/drizzle',
      ),
    }),
  )
  afterAll(() => pool.end())

  it('loads newest messages and every older page without duplicate microsecond boundary messages', async () => {
    const f = await fixture()
    await db.insert(message).values(
      Array.from({ length: 205 }, (_, index) => ({
        conversationId: f.conversationId,
        channelId: f.channelId,
        direction: 'INBOUND' as const,
        senderType: 'CUSTOMER' as const,
        text: `History ${index}`,
        createdAt: sql`'2025-01-01T00:00:00.123456Z'::timestamptz`,
      })),
    )
    const first = (await (
      await f.call(`/conversations/${f.conversationId}/messages?history=latest`)
    ).json()) as MessagePage
    expect(first.messages).toHaveLength(100)
    expect(first.messages.at(-1)?.text).toBe('Hello')
    const seen = new Set(first.messages.map((m) => m.id))
    await f.call(`/conversations/${f.conversationId}/read`, 'POST', { messageIds: [...seen] })
    expect(
      (
        (await (await f.call(`/conversations/${f.conversationId}`)).json()) as {
          conversation: { unread: boolean }
        }
      ).conversation.unread,
    ).toBe(true)
    let cursor = first.olderCursor
    expect(cursor).toBeTruthy()
    while (cursor) {
      const page = (await (
        await f.call(
          `/conversations/${f.conversationId}/messages?before=${encodeURIComponent(cursor)}`,
        )
      ).json()) as MessagePage
      for (const m of page.messages) {
        expect(seen.has(m.id)).toBe(false)
        seen.add(m.id)
      }
      await f.call(`/conversations/${f.conversationId}/read`, 'POST', {
        messageIds: page.messages.map((m) => m.id),
      })
      cursor = page.olderCursor
    }
    expect(seen.size).toBe(206)
    expect(
      (
        (await (await f.call(`/conversations/${f.conversationId}`)).json()) as {
          conversation: { unread: boolean }
        }
      ).conversation.unread,
    ).toBe(false)
  })

  it('acknowledges only supplied customer inputs and never lets an old window erase a newer input', async () => {
    const f = await fixture()
    const initial = (await (await f.call(`/conversations/${f.conversationId}`)).json()) as {
      conversation: { unread: boolean; unanswered: boolean }
    }
    expect(initial.conversation).toMatchObject({ unread: true, unanswered: true })
    const first = (await (
      await f.call(`/conversations/${f.conversationId}/messages`)
    ).json()) as MessagePage
    expect(
      (
        await f.call(`/conversations/${f.conversationId}/read`, 'POST', {
          messageIds: [first.messages[0].id],
        })
      ).status,
    ).toBe(200)
    expect(
      (
        (await (await f.call(`/conversations/${f.conversationId}`)).json()) as {
          conversation: { unread: boolean }
        }
      ).conversation.unread,
    ).toBe(false)
    const next = await f.inbound('Next')
    await Promise.all([
      f.call(`/conversations/${f.conversationId}/read`, 'POST', {
        messageIds: [first.messages[0].id],
      }),
      f.inbound('Later'),
    ])
    expect(
      (
        (await (await f.call(`/conversations/${f.conversationId}`)).json()) as {
          conversation: { unread: boolean }
        }
      ).conversation.unread,
    ).toBe(true)
    expect(
      (
        await f.call(`/conversations/${f.conversationId}/read`, 'POST', {
          messageIds: [crypto.randomUUID()],
        })
      ).status,
    ).toBe(400)
    const foreign = await fixture()
    expect(
      (
        await f.call(`/conversations/${foreign.conversationId}/read`, 'POST', {
          messageIds: [next.messageId],
        })
      ).status,
    ).toBe(404)
  })

  it('keeps unanswered through pending and failed replies, and requires a sent reply after the current input', async () => {
    const f = await fixture()
    await takeOverConversation(db, {
      workspaceId: f.workspaceId,
      conversationId: f.conversationId,
      actingUserId: f.userId,
    })
    const response = await f.call(`/conversations/${f.conversationId}/replies`, 'POST', {
      text: 'Welcome',
    })
    expect(response.status).toBe(201)
    const body = (await response.json()) as { message: { id: string } }
    const unanswered = async () =>
      (
        (await (await f.call(`/conversations/${f.conversationId}`)).json()) as {
          conversation: { unanswered: boolean }
        }
      ).conversation.unanswered
    expect(await unanswered()).toBe(true)
    await db.update(message).set({ deliveryState: 'FAILED' }).where(eq(message.id, body.message.id))
    expect(await unanswered()).toBe(true)
    await db.update(message).set({ deliveryState: 'SENT' }).where(eq(message.id, body.message.id))
    expect(await unanswered()).toBe(false)
    await f.inbound('Another question')
    expect(await unanswered()).toBe(true)
    const filtered = (await (await f.call('/conversations?attention=unanswered')).json()) as {
      conversations: { id: string }[]
    }
    expect(filtered.conversations.map((c) => c.id)).toContain(f.conversationId)
    const [empty] = await db
      .insert(message)
      .values({
        conversationId: f.conversationId,
        channelId: f.channelId,
        direction: 'OUTBOUND',
        senderType: 'MEMBER',
        senderMemberId: f.memberId,
        text: '   ',
        deliveryState: 'SENT',
      })
      .returning()
    expect(await unanswered()).toBe(true)
    await db.update(message).set({ text: 'Answer' }).where(eq(message.id, empty.id))
    expect(await unanswered()).toBe(false)
    await f.inbound('Question for AI')
    const [ai] = await db
      .insert(member)
      .values({ workspaceId: f.workspaceId, type: 'AI', displayName: 'Assistant' })
      .returning()
    const [answer] = await db
      .insert(message)
      .values({
        conversationId: f.conversationId,
        channelId: f.channelId,
        direction: 'OUTBOUND',
        senderType: 'MEMBER',
        senderMemberId: ai.id,
        text: 'AI answer',
        deliveryState: 'PENDING',
      })
      .returning()
    expect(await unanswered()).toBe(true)
    await db.update(message).set({ deliveryState: 'SENT' }).where(eq(message.id, answer.id))
    expect(await unanswered()).toBe(false)
    expect(
      (
        (await (await f.call(`/conversations/${f.conversationId}`)).json()) as {
          conversation: { unread: boolean }
        }
      ).conversation.unread,
    ).toBe(true)
  })

  it('keeps reading independent for each human and enforces channel access on history and acknowledgements', async () => {
    const f = await fixture()
    const other = await fixture()
    const [access] = await db
      .insert(workspaceUserAccess)
      .values({ workspaceId: f.workspaceId, userId: other.userId, role: 'AGENT' })
      .returning()
    const [agent] = await db
      .insert(member)
      .values({ workspaceId: f.workspaceId, workspaceUserAccessId: access.id, type: 'HUMAN' })
      .returning()
    const call = (path: string, body?: unknown) =>
      app.request(
        `/api/workspaces/${f.workspaceId}${path}`,
        {
          method: body ? 'POST' : 'GET',
          headers: {
            Cookie: other.cookie,
            Origin: env.APP_URL,
            'Content-Type': 'application/json',
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        },
        env,
      )
    const page = (await (
      await f.call(`/conversations/${f.conversationId}/messages`)
    ).json()) as MessagePage
    const body = { messageIds: [page.messages[0].id] }
    expect((await call(`/conversations/${f.conversationId}/read`, body)).status).toBe(403)
    expect((await call(`/conversations/${f.conversationId}/messages?history=latest`)).status).toBe(
      403,
    )
    await db.insert(memberChannelAccess).values({ memberId: agent.id, channelId: f.channelId })
    await f.call(`/conversations/${f.conversationId}/read`, 'POST', body)
    const unread = async () =>
      (
        (await (await call(`/conversations/${f.conversationId}`)).json()) as {
          conversation: { unread: boolean }
        }
      ).conversation.unread
    expect(await unread()).toBe(true)
    expect((await call(`/conversations/${f.conversationId}/read`, body)).status).toBe(200)
    expect(await unread()).toBe(false)
    await db
      .delete(memberChannelAccess)
      .where(
        and(
          eq(memberChannelAccess.memberId, agent.id),
          eq(memberChannelAccess.channelId, f.channelId),
        ),
      )
    expect((await call(`/conversations/${f.conversationId}/messages?history=latest`)).status).toBe(
      403,
    )
    expect((await call(`/conversations/${f.conversationId}/read`, body)).status).toBe(403)
  })

  it('pages all closed conversations without altering the five open views', async () => {
    const f = await fixture()
    const now = new Date('2025-01-01T00:00:00.123Z')
    const [identity] = await db
      .select({ id: channelIdentity.id })
      .from(channelIdentity)
      .where(eq(channelIdentity.channelId, f.channelId))
    await db.insert(conversation).values(
      Array.from({ length: 55 }, () => ({
        workspaceId: f.workspaceId,
        channelIdentityId: identity.id,
        status: 'CLOSED' as const,
        closedAt: now,
        closedByMemberId: f.memberId,
        updatedAt: now,
      })),
    )
    const first = (await (await f.call('/conversations?view=closed')).json()) as {
      conversations: { id: string; status: string }[]
      nextCursor: string
    }
    expect(first.conversations).toHaveLength(50)
    expect(first.conversations.every((c) => c.status === 'CLOSED')).toBe(true)
    const second = (await (
      await f.call(`/conversations?view=closed&cursor=${encodeURIComponent(first.nextCursor)}`)
    ).json()) as { conversations: { id: string }[]; nextCursor: string | null }
    expect(second.conversations).toHaveLength(5)
    expect(new Set([...first.conversations, ...second.conversations].map((c) => c.id)).size).toBe(
      55,
    )
    expect(second.nextCursor).toBeNull()
    expect((await f.call(`/conversations/${second.conversations[0].id}`)).status).toBe(200)
    const open = (await (await f.call('/conversations?view=all-open')).json()) as {
      conversations: { id: string }[]
    }
    expect(open.conversations.map((c) => c.id)).toEqual([f.conversationId])
    expect((await f.call('/conversations?attention=invalid')).status).toBe(400)
  })

  it('persists signed receipts before send completion, uses only echo time and isolates identities', async () => {
    const f = await fixture()
    const mid = crypto.randomUUID()
    const [outbound] = await db
      .insert(message)
      .values({
        conversationId: f.conversationId,
        channelId: f.channelId,
        direction: 'OUTBOUND',
        senderType: 'MEMBER',
        senderMemberId: f.memberId,
        text: 'Reply',
        deliveryState: 'PENDING',
      })
      .returning()
    const jobs: unknown[] = []
    const receiptEnv = {
      ...env,
      META_APP_SECRET: 'test-app-secret',
      WEBHOOKS_QUEUE: {
        send: async (job: unknown) => {
          jobs.push(job)
        },
      },
    } as unknown as Bindings
    const post = async (messaging: unknown[]) => {
      const body = JSON.stringify({ object: 'page', entry: [{ id: f.pageId, messaging }] })
      const signature = `sha256=${createHmac('sha256', 'test-app-secret').update(body).digest('hex')}`
      const response = await app.request(
        '/webhooks/facebook',
        { method: 'POST', body, headers: { 'x-hub-signature-256': signature } },
        receiptEnv,
      )
      expect(response.status).toBe(200)
      const acknowledgements: boolean[] = []
      await handleWebhookBatch(
        {
          messages: jobs.splice(0).map((body) => ({
            body,
            ack: () => acknowledgements.push(true),
            retry: () => {
              throw new Error('Unexpected receipt retry')
            },
          })),
        } as unknown as MessageBatch<unknown>,
        receiptEnv,
      )
      expect(acknowledgements.length).toBeGreaterThan(0)
    }
    const customer = { sender: { id: f.externalUserId }, recipient: { id: f.pageId } }
    await post([
      { ...customer, delivery: { mids: [mid], watermark: 1700000000001 } },
      { ...customer, read: { watermark: 1700000000001 } },
    ])
    await db
      .update(message)
      .set({
        deliveryState: 'SENT',
        externalMessageId: mid,
        deliveryCompletedAt: new Date(),
        providerSentAt: new Date(),
      })
      .where(eq(message.id, outbound.id))
    const current = async () => {
      const page = (await (
        await f.call(`/conversations/${f.conversationId}/messages?history=latest`)
      ).json()) as {
        messages: { id: string; delivered: boolean; read: boolean; providerSentAt: string | null }[]
      }
      return page.messages.find((m) => m.id === outbound.id)
    }
    expect(await current()).toMatchObject({ delivered: true, read: false, providerSentAt: null })
    await post([
      {
        sender: { id: f.pageId },
        recipient: { id: f.externalUserId },
        timestamp: 1700000000000,
        message: { mid, is_echo: true, text: 'Private reply' },
      },
    ])
    expect(await current()).toMatchObject({
      delivered: true,
      read: true,
      providerSentAt: '2023-11-14T22:13:20.000Z',
    })
    await post([
      { ...customer, read: { watermark: 1600000000000 } },
      { ...customer, delivery: { mids: [mid], watermark: 1600000000000 } },
    ])
    expect(await current()).toMatchObject({ delivered: true, read: true })
    await Promise.all(
      [1600000000000, 1700000000002, 1700000000001].map((watermark) =>
        handleWebhookBatch(
          {
            messages: [
              {
                body: {
                  v: 1,
                  type: 'facebook.receipt',
                  event: {
                    pageId: f.pageId,
                    externalUserId: f.externalUserId,
                    kind: 'read',
                    mids: [],
                    watermark: new Date(watermark).toISOString(),
                    providerSentAt: null,
                  },
                },
                ack: () => {},
                retry: () => {
                  throw new Error('Concurrent receipt failed')
                },
              },
            ],
          } as unknown as MessageBatch<unknown>,
          receiptEnv,
        ),
      ),
    )
    expect(await current()).toMatchObject({ delivered: true, read: true })
    const [unknown] = await db
      .insert(message)
      .values({
        conversationId: f.conversationId,
        channelId: f.channelId,
        direction: 'OUTBOUND',
        senderType: 'MEMBER',
        senderMemberId: f.memberId,
        text: 'Later',
        deliveryState: 'SENT',
        externalMessageId: 'unknown-mid',
      })
      .returning()
    await post([
      {
        sender: { id: crypto.randomUUID() },
        recipient: { id: f.pageId },
        delivery: { mids: ['unknown-mid'] },
        read: { watermark: 1800000000000 },
      },
    ])
    const otherIdentity = crypto.randomUUID()
    await processFacebookInbound(db, {
      ingressId: crypto.randomUUID(),
      pageId: f.pageId,
      externalUserId: otherIdentity,
      externalMessageId: crypto.randomUUID(),
      text: 'Other customer',
      providerSentAt: new Date(),
      receivedAt: new Date(),
      payloadSha256: 'a'.repeat(64),
      eventFragment: {},
    })
    await post([
      {
        sender: { id: otherIdentity },
        recipient: { id: f.pageId },
        delivery: { mids: ['unknown-mid'] },
      },
      {
        sender: { id: f.pageId },
        recipient: { id: otherIdentity },
        timestamp: 1700000000000,
        message: { mid: 'unknown-mid', is_echo: true },
      },
    ])
    const page = (await (
      await f.call(`/conversations/${f.conversationId}/messages?history=latest`)
    ).json()) as { messages: { id: string; delivered: boolean; read: boolean }[] }
    expect(page.messages.find((m) => m.id === unknown.id)).toMatchObject({
      delivered: false,
      read: false,
    })
    const invalid = await app.request(
      '/webhooks/facebook',
      { method: 'POST', body: '{}' },
      receiptEnv,
    )
    expect(invalid.status).toBe(401)
  })
})

type MessagePage = { messages: { id: string; text: string }[]; olderCursor: string | null }

async function fixture() {
  const auth = createAuth(db, env)
  const email = `${crypto.randomUUID()}@example.com`
  const password = 'correct-horse-battery-staple'
  const created = await auth.api.signUpEmail({ body: { email, password, name: 'Reading owner' } })
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
  if (!cookie) throw new Error('No sign-in cookie')
  const workspace = await bootstrapWorkspace(db, {
    userId: created.user.id,
    userName: 'Reading owner',
    name: 'Inbox reading',
  })
  const pageId = crypto.randomUUID()
  const externalUserId = crypto.randomUUID()
  const [channel] = await connectFacebookPages(db, {
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
  const inbound = async (text: string) => {
    const result = await processFacebookInbound(db, {
      ingressId: crypto.randomUUID(),
      pageId,
      externalUserId,
      externalMessageId: crypto.randomUUID(),
      text,
      providerSentAt: new Date(),
      receivedAt: new Date(),
      payloadSha256: 'a'.repeat(64),
      eventFragment: {},
    })
    if (result.kind !== 'created') throw new Error('Inbound not created')
    return result
  }
  const received = await inbound('Hello')
  const [owner] = await db
    .select({ id: member.id })
    .from(member)
    .where(eq(member.workspaceId, workspace.id))
  return {
    cookie,
    workspaceId: workspace.id,
    memberId: owner.id,
    userId: created.user.id,
    channelId: channel.id,
    pageId,
    externalUserId,
    conversationId: received.conversationId,
    inbound,
    call: (path: string, method = 'GET', body?: unknown) =>
      app.request(
        `/api/workspaces/${workspace.id}${path}`,
        {
          method,
          headers: { Cookie: cookie, 'Content-Type': 'application/json', Origin: env.APP_URL },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
        env,
      ),
  }
}
