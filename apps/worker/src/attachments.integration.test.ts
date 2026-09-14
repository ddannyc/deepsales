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
  facebookAttachmentSource,
  expireFacebookInboundAttachments,
  MAX_INBOUND_ATTACHMENT_BYTES,
  messageAttachment,
  processFacebookInbound,
  user,
} from '@deepsales/db'
import type { Bindings } from './bindings'
import { handleDocumentsBatch } from './index'
import { encryptFacebookToken } from './facebook'

const connectionString = process.env.DATABASE_URL
const tokenKey = btoa(String.fromCharCode(...new Uint8Array(32)))
const migrationsFolder = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../packages/db/drizzle',
)

describe.skipIf(!connectionString)('inbound attachment consumer', () => {
  const pool = new Pool({ connectionString })
  const db = createDatabase(pool)

  beforeAll(async () => {
    await migrate(db, { migrationsFolder })
  })

  afterAll(() => pool.end())
  afterEach(() => vi.unstubAllGlobals())

  it('stores a bounded private object and removes its encrypted source on success', async () => {
    const fixture = await createFixture(db)
    const objects = memoryBucket()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('image-bytes', {
          headers: { 'content-type': 'image/png' },
        }),
      ),
    )
    const queued = queueMessage(fixture.attachmentId)

    await handleDocumentsBatch(batch(queued), environment(objects))

    expect(queued.ack).toHaveBeenCalledOnce()
    expect(queued.retry).not.toHaveBeenCalled()
    const [stored] = await db
      .select()
      .from(messageAttachment)
      .where(eq(messageAttachment.id, fixture.attachmentId))
    expect(stored).toEqual(
      expect.objectContaining({
        storageState: 'READY',
        byteSize: 11,
        mimeType: 'image/png',
        storageKey: expect.stringContaining(`attachments/${fixture.attachmentId}/`),
      }),
    )
    expect(
      await db
        .select()
        .from(facebookAttachmentSource)
        .where(eq(facebookAttachmentSource.attachmentId, fixture.attachmentId)),
    ).toHaveLength(0)
    expect(objects.values).toHaveLength(1)
  })

  it.each([
    ['expired source', new Date(0), 'SOURCE_EXPIRED', false],
    ['oversized response', undefined, 'TOO_LARGE', true],
  ])('marks a %s as FAILED', async (_name, expiresAt, failureCode, fetchCalled) => {
    const fixture = await createFixture(db, { expiresAt: expiresAt ?? undefined })
    const objects = memoryBucket()
    const fetch = vi.fn().mockResolvedValue(
      failureCode === 'TOO_LARGE'
        ? new Response('small', {
            headers: {
              'content-type': 'image/png',
              'content-length': String(MAX_INBOUND_ATTACHMENT_BYTES + 1),
            },
          })
        : new Response('image-bytes', { headers: { 'content-type': 'image/png' } }),
    )
    vi.stubGlobal('fetch', fetch)
    const queued = queueMessage(fixture.attachmentId)

    await handleDocumentsBatch(batch(queued), environment(objects))

    expect(fetch).toHaveBeenCalledTimes(fetchCalled ? 1 : 0)
    expect(queued.ack).toHaveBeenCalledOnce()
    const [stored] = await db
      .select()
      .from(messageAttachment)
      .where(eq(messageAttachment.id, fixture.attachmentId))
    expect(stored).toEqual(expect.objectContaining({ storageState: 'FAILED', failureCode }))
    expect(
      await db
        .select()
        .from(facebookAttachmentSource)
        .where(eq(facebookAttachmentSource.attachmentId, fixture.attachmentId)),
    ).toHaveLength(1)
  })

  it('keeps a valid attachment pending when R2 is unavailable so queue retry can recover it', async () => {
    const fixture = await createFixture(db)
    const objects = memoryBucket(true)
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response('image-bytes', { headers: { 'content-type': 'image/png' } }),
        ),
    )
    const queued = queueMessage(fixture.attachmentId)

    await handleDocumentsBatch(batch(queued), environment(objects))

    expect(queued.ack).not.toHaveBeenCalled()
    expect(queued.retry).toHaveBeenCalledOnce()
    const [stored] = await db
      .select()
      .from(messageAttachment)
      .where(eq(messageAttachment.id, fixture.attachmentId))
    expect(stored).toEqual(
      expect.objectContaining({ storageState: 'PENDING', processingStartedAt: null }),
    )
    expect(
      await db
        .select()
        .from(facebookAttachmentSource)
        .where(eq(facebookAttachmentSource.attachmentId, fixture.attachmentId)),
    ).toHaveLength(1)
  })

  it('expires lost pending work during maintenance', async () => {
    const fixture = await createFixture(db, { expiresAt: new Date(0) })
    await db
      .update(messageAttachment)
      .set({ processingStartedAt: new Date(Date.now() - 10 * 60 * 1_000) })
      .where(eq(messageAttachment.id, fixture.attachmentId))

    const expired = await expireFacebookInboundAttachments(db, { now: new Date() })

    expect(expired.map(({ id }) => id)).toContain(fixture.attachmentId)
    const [stored] = await db
      .select()
      .from(messageAttachment)
      .where(eq(messageAttachment.id, fixture.attachmentId))
    expect(stored).toEqual(
      expect.objectContaining({
        storageState: 'FAILED',
        failureCode: 'SOURCE_EXPIRED',
        processingStartedAt: null,
      }),
    )
  })
})

async function createFixture(
  db: ReturnType<typeof createDatabase>,
  input: { expiresAt?: Date } = {},
) {
  const ownerId = randomUUID()
  const pageId = randomUUID()
  const sourceUrl = `https://provider.example/${ownerId}.png`
  const encrypted = await encryptFacebookToken(sourceUrl, tokenKey)
  await db.insert(user).values({ id: ownerId, name: 'Owner', email: `${ownerId}@example.com` })
  const workspace = await bootstrapWorkspace(db, {
    userId: ownerId,
    userName: 'Owner',
    name: 'Attachment consumer test',
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
  if (!channel) throw new Error('Facebook channel was not created')
  const receivedAt = new Date()
  const received = await processFacebookInbound(db, {
    ingressId: randomUUID(),
    pageId,
    externalUserId: `customer-${ownerId}`,
    externalMessageId: `mid-${ownerId}`,
    text: null,
    attachments: [
      {
        kind: 'IMAGE',
        filename: 'photo.png',
        mimeType: 'image/png',
        encryptedSourceUrl: encrypted.ciphertext,
        urlIv: encrypted.iv,
        tokenKeyVersion: encrypted.keyVersion,
        expiresAt: input.expiresAt ?? new Date(receivedAt.getTime() + 60_000),
      },
    ],
    providerSentAt: receivedAt,
    receivedAt,
    payloadSha256: 'a'.repeat(64),
    eventFragment: { messageId: `mid-${ownerId}`, attachmentKinds: ['IMAGE'] },
  })
  if (received.kind !== 'created') throw new Error('Attachment was not created')
  return { attachmentId: received.attachmentIds[0] as string }
}

function memoryBucket(failPut = false) {
  const values: Array<{ key: string; body: Uint8Array }> = []
  return {
    values,
    put: vi.fn(async (key: string, body: ReadableStream<Uint8Array>) => {
      if (failPut) throw new Error('R2 unavailable')
      values.push({ key, body: new Uint8Array(await new Response(body).arrayBuffer()) })
      return {}
    }),
  } as unknown as R2Bucket & { values: typeof values }
}

function environment(objects: R2Bucket): Bindings {
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
    OBJECTS: objects,
  }
}

function batch(message: ReturnType<typeof queueMessage>) {
  return { queue: 'deepsales-documents', messages: [message] } as unknown as MessageBatch<unknown>
}

function queueMessage(attachmentId: string) {
  return {
    body: { v: 1, type: 'facebook.attachment', attachmentId },
    ack: vi.fn(),
    retry: vi.fn(),
  }
}
