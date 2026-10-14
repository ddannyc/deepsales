import { isolateOutboundRecoveryTest } from './outbound.test-fixture'
import { randomUUID } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { Pool } from 'pg'
import {
  bootstrapWorkspace,
  connectFacebookPages,
  createDatabase,
  createFacebookHumanReply as createHumanReply,
  deliveryAttempt,
  message,
  processFacebookInbound,
  setMemberChannelAccess,
  takeOverConversation,
  member,
  user,
} from '@deepsales/db'
import type { Bindings } from './bindings'
import { handleOutboundBatch, handleScheduled } from './index'
import { encryptFacebookToken as encryptToken } from './facebook'

const connectionString = process.env.DATABASE_URL
const tokenKey = btoa(String.fromCharCode(...new Uint8Array(32)))
const migrationsFolder = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../packages/db/drizzle',
)

describe.skipIf(!connectionString)('outbound Worker consumer', () => {
  const pool = new Pool({ connectionString })
  const db = createDatabase(pool)

  beforeAll(async () => {
    await migrate(db, { migrationsFolder })
  })

  afterAll(() => pool.end())
  afterEach(() => vi.unstubAllGlobals())

  it('sends a claimed message once and records SENT', async () => {
    const fixture = await createFixture(db)
    const fakeFetch = vi.fn().mockResolvedValue(Response.json({ message_id: 'meta-message-1' }))
    vi.stubGlobal('fetch', fakeFetch)

    const queued = queueMessage(fixture.messageId)
    await handleOutboundBatch(batch(queued), environment())
    await handleOutboundBatch(batch(queueMessage(fixture.messageId)), environment())

    expect(fakeFetch).toHaveBeenCalledOnce()
    const [url, init] = fakeFetch.mock.calls[0] ?? []
    expect(url).toEqual(new URL(`https://graph.facebook.com/v26.0/${fixture.pageId}/messages`))
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      recipient: { id: fixture.externalUserId },
      messaging_type: 'RESPONSE',
      message: { text: 'hello from human' },
    })
    expect(queued.ack).toHaveBeenCalledOnce()
    expect(queued.retry).not.toHaveBeenCalled()

    const [sent] = await db.select().from(message).where(eq(message.id, fixture.messageId))
    expect(sent).toEqual(
      expect.objectContaining({ deliveryState: 'SENT', externalMessageId: 'meta-message-1' }),
    )
  })

  it('keeps a Meta rejection FAILED and stores only a redacted attempt', async () => {
    const fixture = await createFixture(db)
    const fakeFetch = vi.fn().mockResolvedValue(
      Response.json(
        {
          error: {
            code: 190,
            error_subcode: 463,
            type: 'OAuthException',
            message: 'access_token=page-token',
          },
        },
        { status: 400 },
      ),
    )
    vi.stubGlobal('fetch', fakeFetch)

    const queued = queueMessage(fixture.messageId)
    await handleOutboundBatch(batch(queued), environment())

    expect(fakeFetch).toHaveBeenCalledOnce()
    expect(queued.ack).toHaveBeenCalledOnce()
    const [failed] = await db.select().from(message).where(eq(message.id, fixture.messageId))
    expect(failed).toEqual(
      expect.objectContaining({
        deliveryState: 'FAILED',
        externalMessageId: null,
        failureCode: 'FACEBOOK_DELIVERY_FAILED',
      }),
    )
    const attempts = await pool.query(
      'select code, subcode, type, message from facebook_delivery_attempt where message_id = $1',
      [fixture.messageId],
    )
    expect(attempts.rows).toEqual([
      {
        code: 190,
        subcode: 463,
        type: 'OAuthException',
        message: 'access_token=[redacted]',
      },
    ])
  })

  it('retries transient Graph failures and records each delivery attempt', async () => {
    const fixture = await createFixture(db)
    const fakeFetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ error: { message: 'busy' } }, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ message_id: 'meta-message-2' }))
    vi.stubGlobal('fetch', fakeFetch)

    const first = queueMessage(fixture.messageId)
    await handleOutboundBatch(batch(first), environment())

    expect(first.ack).not.toHaveBeenCalled()
    expect(first.retry).toHaveBeenCalledOnce()
    expect(
      await db
        .select({
          deliveryState: message.deliveryState,
          deliveryStartedAt: message.deliveryStartedAt,
        })
        .from(message)
        .where(eq(message.id, fixture.messageId)),
    ).toEqual([{ deliveryState: 'PENDING', deliveryStartedAt: null }])

    const second = queueMessage(fixture.messageId)
    await handleOutboundBatch(batch(second), environment())

    expect(fakeFetch).toHaveBeenCalledTimes(2)
    expect(second.ack).toHaveBeenCalledOnce()
    expect(
      await db
        .select({ attemptNumber: deliveryAttempt.attemptNumber })
        .from(deliveryAttempt)
        .where(eq(deliveryAttempt.messageId, fixture.messageId))
        .orderBy(deliveryAttempt.attemptNumber),
    ).toEqual([{ attemptNumber: 1 }, { attemptNumber: 2 }])
  })

  it('marks a network failure ambiguous without retrying the Graph call', async () => {
    const fixture = await createFixture(db)
    const fakeFetch = vi.fn().mockRejectedValue(new Error('socket closed'))
    vi.stubGlobal('fetch', fakeFetch)

    const queued = queueMessage(fixture.messageId)
    await handleOutboundBatch(batch(queued), environment())

    expect(fakeFetch).toHaveBeenCalledOnce()
    expect(queued.ack).toHaveBeenCalledOnce()
    expect(queued.retry).not.toHaveBeenCalled()
    const [failed] = await db.select().from(message).where(eq(message.id, fixture.messageId))
    expect(failed).toEqual(
      expect.objectContaining({
        deliveryState: 'FAILED',
        externalMessageId: null,
        failureCode: 'AMBIGUOUS_DELIVERY',
      }),
    )
  })

  it('requeues unclaimed committed messages during scheduled recovery', async () => {
    await isolateOutboundRecoveryTest(pool)
    const fixture = await createFixture(db)
    const send = vi.fn().mockResolvedValue(undefined)

    await handleScheduled({
      ...environment(),
      OUTBOUND_QUEUE: { send } as unknown as Queue,
    })

    expect(send).toHaveBeenCalledWith({
      v: 1,
      type: 'facebook.outbound',
      messageId: fixture.messageId,
    })
  })
})

async function createFixture(db: ReturnType<typeof createDatabase>) {
  const ownerId = randomUUID()
  const externalUserId = `customer-${ownerId}`
  const pageId = `page-${ownerId}`
  await db.insert(user).values({ id: ownerId, name: 'Owner', email: `${ownerId}@example.com` })
  const workspace = await bootstrapWorkspace(db, {
    userId: ownerId,
    userName: 'Owner',
    name: 'Worker outbound test',
  })
  const token = await encryptToken('page-token', tokenKey)
  const [connected] = await connectFacebookPages(db, {
    workspaceId: workspace.id,
    actingUserId: ownerId,
    pages: [
      {
        pageId,
        displayName: 'Support',
        encryptedPageAccessToken: token.ciphertext,
        tokenIv: token.iv,
        tokenKeyVersion: token.keyVersion,
      },
    ],
  })
  if (!connected) throw new Error('Facebook channel was not created')
  const [owner] = await db.select().from(member).where(eq(member.workspaceId, workspace.id))
  if (!owner) throw new Error('Owner member was not created')
  await setMemberChannelAccess(db, {
    workspaceId: workspace.id,
    memberId: owner.id,
    actingUserId: ownerId,
    channelIds: [connected.id],
  })
  const receivedAt = new Date()
  const received = await processFacebookInbound(db, {
    ingressId: randomUUID(),
    pageId,
    externalUserId,
    externalMessageId: `mid-${ownerId}`,
    text: 'customer question',
    providerSentAt: receivedAt,
    receivedAt,
    payloadSha256: 'a'.repeat(64),
    eventFragment: { messageId: `mid-${ownerId}` },
  })
  if (received.kind !== 'created') throw new Error('Inbound message was not created')
  await takeOverConversation(db, {
    workspaceId: workspace.id,
    conversationId: received.conversationId,
    actingUserId: ownerId,
  })
  const created = await createHumanReply(db, {
    workspaceId: workspace.id,
    conversationId: received.conversationId,
    actingUserId: ownerId,
    text: 'hello from human',
  })
  return { messageId: created.message.id, externalUserId, pageId }
}

function environment(): Bindings {
  return {
    APP_URL: 'http://localhost:8787',
    AUTH_RATE_LIMITER: {} as RateLimit,
    BETTER_AUTH_SECRET: 'test-only-secret-that-is-at-least-32-characters',
    HYPERDRIVE: { connectionString } as Hyperdrive,
    META_APP_ID: 'app-1',
    META_APP_SECRET: 'app-secret',
    META_VERIFY_TOKEN: 'verify-token',
    META_GRAPH_API_VERSION: 'v26.0',
    TOKEN_ENCRYPTION_KEY: tokenKey,
  }
}

function batch(message: ReturnType<typeof queueMessage>) {
  return { queue: 'deepsales-outbound', messages: [message] } as unknown as MessageBatch<unknown>
}

function queueMessage(messageId: string) {
  return {
    body: { v: 1, type: 'facebook.outbound', messageId },
    ack: vi.fn(),
    retry: vi.fn(),
  }
}
