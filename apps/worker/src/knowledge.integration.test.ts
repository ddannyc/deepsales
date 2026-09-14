import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { Pool } from 'pg'
import {
  bootstrapWorkspace,
  createDatabase,
  createFileKnowledgeDocument,
  createInlineKnowledgeDocument,
  createKnowledgeBase,
  knowledgeChunk,
  knowledgeDocument,
  user,
} from '@deepsales/db'
import type { Bindings } from './bindings'
import { AlibabaEmbeddingProvider } from './ai'
import { retrieveKnowledgeChunks } from './knowledge'
import { handleDocumentsBatch } from './index'

const connectionString = process.env.DATABASE_URL
const migrationsFolder = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../packages/db/drizzle',
)

describe.skipIf(!connectionString)('knowledge Worker consumer', () => {
  const pool = new Pool({ connectionString })
  const db = createDatabase(pool)

  beforeAll(async () => {
    await migrate(db, { migrationsFolder })
  })

  afterAll(() => pool.end())
  afterEach(() => vi.unstubAllGlobals())

  it('ingests with Alibaba metadata and uses the same provider for retrieval', async () => {
    const fixture = await createFixture(db)
    const embedding = vector(0)
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ data: [{ index: 0, embedding }] }),
    )
    vi.stubGlobal('fetch', fetch)

    const queued = queueMessage(fixture.documentId)
    await handleDocumentsBatch(batch(queued), environment())

    expect(queued.ack).toHaveBeenCalledOnce()
    expect(queued.retry).not.toHaveBeenCalled()
    expect(JSON.parse(fetch.mock.calls[0]?.[1]?.body as string)).toEqual({
      model: 'qwen3.7-text-embedding',
      input: ['Shipping is free.'],
      dimensions: 1_536,
      encoding_format: 'float',
    })

    const [storedDocument] = await db
      .select({ status: knowledgeDocument.status })
      .from(knowledgeDocument)
      .where(eq(knowledgeDocument.id, fixture.documentId))
    expect(storedDocument?.status).toBe('READY')
    expect(
      await db
        .select()
        .from(knowledgeChunk)
        .where(eq(knowledgeChunk.knowledgeDocumentId, fixture.documentId)),
    ).toHaveLength(1)

    const provider = new AlibabaEmbeddingProvider(
      { apiKey: 'test-key', baseUrl: 'http://ai.test/v1' },
      fetch,
    )
    const results = await retrieveKnowledgeChunks(
      db,
      provider,
      { AI_RETRIEVAL_MAX_DISTANCE: '0.35' },
      {
        workspaceId: fixture.workspaceId,
        knowledgeBaseId: fixture.knowledgeBaseId,
        query: 'shipping',
      },
    )
    expect(results).toHaveLength(1)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(JSON.parse(fetch.mock.calls[1]?.[1]?.body as string)).toEqual(
      expect.objectContaining({
        model: 'qwen3.7-text-embedding',
        dimensions: 1_536,
        input: ['shipping'],
      }),
    )

    const mismatchedEmbed = vi.fn(async () => [embedding])
    const mismatchedProvider = {
      metadata: { provider: 'alibaba', model: 'other-model', dimensions: 1_536 },
      embed: mismatchedEmbed,
    }
    await expect(
      retrieveKnowledgeChunks(
        db,
        mismatchedProvider,
        { AI_RETRIEVAL_MAX_DISTANCE: '0.35' },
        {
          workspaceId: fixture.workspaceId,
          knowledgeBaseId: fixture.knowledgeBaseId,
          query: 'shipping',
        },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(mismatchedEmbed).not.toHaveBeenCalled()
  })

  it('fails the document without READY state or partial chunks on provider failure', async () => {
    const fixture = await createFixture(db)
    const fetch = vi
      .fn()
      .mockResolvedValue(Response.json({ error: 'provider failed' }, { status: 400 }))
    vi.stubGlobal('fetch', fetch)

    const queued = queueMessage(fixture.documentId)
    await handleDocumentsBatch(batch(queued), environment())

    expect(queued.ack).toHaveBeenCalledOnce()
    expect(queued.retry).not.toHaveBeenCalled()
    const [storedDocument] = await db
      .select({ status: knowledgeDocument.status })
      .from(knowledgeDocument)
      .where(eq(knowledgeDocument.id, fixture.documentId))
    expect(storedDocument?.status).toBe('FAILED')
    expect(
      await db
        .select()
        .from(knowledgeChunk)
        .where(eq(knowledgeChunk.knowledgeDocumentId, fixture.documentId)),
    ).toHaveLength(0)
  })

  it('extracts a stored TXT file through the existing READY pipeline', async () => {
    const fixture = await createFileFixture(db, 'TXT')
    const objects = memoryBucket(fixture.storageKey, new TextEncoder().encode('Shipping is free.'))
    const embedding = vector(0)
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(Response.json({ data: [{ index: 0, embedding }] })),
    )

    const queued = queueMessage(fixture.documentId)
    await handleDocumentsBatch(batch(queued), environment(objects))

    expect(queued.ack).toHaveBeenCalledOnce()
    const [storedDocument] = await db
      .select({ status: knowledgeDocument.status })
      .from(knowledgeDocument)
      .where(eq(knowledgeDocument.id, fixture.documentId))
    expect(storedDocument?.status).toBe('READY')
    expect(
      await db
        .select({ text: knowledgeChunk.text })
        .from(knowledgeChunk)
        .where(eq(knowledgeChunk.knowledgeDocumentId, fixture.documentId)),
    ).toEqual([{ text: 'Shipping is free.' }])
  })

  it('marks a malformed stored PDF FAILED without chunks', async () => {
    const fixture = await createFileFixture(db, 'PDF')
    const objects = memoryBucket(fixture.storageKey, new TextEncoder().encode('%PDF-1.7'))
    const queued = queueMessage(fixture.documentId)

    await handleDocumentsBatch(batch(queued), environment(objects))

    expect(queued.ack).toHaveBeenCalledOnce()
    const [storedDocument] = await db
      .select({ status: knowledgeDocument.status, failureCode: knowledgeDocument.failureCode })
      .from(knowledgeDocument)
      .where(eq(knowledgeDocument.id, fixture.documentId))
    expect(storedDocument).toEqual({ status: 'FAILED', failureCode: 'FILE_EXTRACTION_FAILED' })
    expect(
      await db
        .select()
        .from(knowledgeChunk)
        .where(eq(knowledgeChunk.knowledgeDocumentId, fixture.documentId)),
    ).toHaveLength(0)
  })

  it('releases a file claim for retry when R2 reads fail', async () => {
    const fixture = await createFileFixture(db, 'TXT')
    const objects = memoryBucket(fixture.storageKey, new TextEncoder().encode('retry me'))
    objects.failGet = true
    const queued = queueMessage(fixture.documentId)

    await handleDocumentsBatch(batch(queued), environment(objects))

    expect(queued.retry).toHaveBeenCalledOnce()
    const [pending] = await db
      .select({
        status: knowledgeDocument.status,
        processingStartedAt: knowledgeDocument.processingStartedAt,
      })
      .from(knowledgeDocument)
      .where(eq(knowledgeDocument.id, fixture.documentId))
    expect(pending).toEqual({ status: 'UPLOADED', processingStartedAt: null })
  })
})

async function createFixture(db: ReturnType<typeof createDatabase>) {
  const ownerId = crypto.randomUUID()
  await db.insert(user).values({ id: ownerId, name: 'Owner', email: `${ownerId}@example.com` })
  const workspace = await bootstrapWorkspace(db, {
    userId: ownerId,
    userName: 'Owner',
    name: 'Knowledge worker test',
  })
  const base = await createKnowledgeBase(db, {
    workspaceId: workspace.id,
    createdByUserId: ownerId,
    name: 'Support facts',
  })
  const document = await createInlineKnowledgeDocument(db, {
    workspaceId: workspace.id,
    knowledgeBaseId: base.id,
    createdByUserId: ownerId,
    name: 'Shipping',
    text: 'Shipping is free.',
  })
  return { workspaceId: workspace.id, knowledgeBaseId: base.id, documentId: document.id }
}

async function createFileFixture(
  db: ReturnType<typeof createDatabase>,
  sourceType: 'PDF' | 'DOCX' | 'TXT' | 'MARKDOWN',
) {
  const ownerId = crypto.randomUUID()
  const storageKey = `knowledge/${ownerId}`
  await db.insert(user).values({ id: ownerId, name: 'Owner', email: `${ownerId}@example.com` })
  const workspace = await bootstrapWorkspace(db, {
    userId: ownerId,
    userName: 'Owner',
    name: 'Knowledge file test',
  })
  const base = await createKnowledgeBase(db, {
    workspaceId: workspace.id,
    createdByUserId: ownerId,
    name: 'Support facts',
  })
  const document = await createFileKnowledgeDocument(db, {
    workspaceId: workspace.id,
    knowledgeBaseId: base.id,
    createdByUserId: ownerId,
    name: `file.${sourceType.toLowerCase()}`,
    sourceType,
    storageKey,
  })
  return { documentId: document.id, storageKey }
}

function environment(objects?: R2Bucket): Bindings {
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
    OBJECTS: objects,
  }
}

function batch(message: ReturnType<typeof queueMessage>) {
  return { queue: 'deepsales-documents', messages: [message] } as unknown as MessageBatch<unknown>
}

function queueMessage(documentId: string) {
  return {
    body: { v: 1, type: 'knowledge.document', documentId },
    ack: vi.fn(),
    retry: vi.fn(),
  }
}

function vector(axis: number) {
  const result = Array.from({ length: 1_536 }, () => 0)
  result[axis] = 1
  return result
}

function memoryBucket(key: string, bytes: Uint8Array) {
  const values = new Map([[key, bytes]])
  const bucket = {
    values,
    failGet: false,
    get: vi.fn(async (requestedKey: string) => {
      if (values.has(requestedKey) && bucket.failGet) {
        throw new Error('R2 unavailable')
      }
      const value = values.get(requestedKey)
      return value ? { body: new Response(value).body } : null
    }),
    put: vi.fn(),
    delete: vi.fn(async (requestedKey: string) => {
      values.delete(requestedKey)
    }),
  } as unknown as R2Bucket & {
    values: Map<string, Uint8Array>
    failGet: boolean
  }
  return bucket
}
