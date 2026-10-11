import { randomUUID } from 'node:crypto'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import {
  bootstrapWorkspace,
  claimKnowledgeDocument,
  createFileKnowledgeDocument,
  completeKnowledgeDocument,
  createDatabase,
  createInlineKnowledgeDocument,
  createKnowledgeBase,
  deleteKnowledgeDocument,
  failKnowledgeDocument,
  knowledgeChunk,
  knowledgeBase,
  knowledgeDocument,
  type KnowledgeError,
  listPendingKnowledgeDocumentIds,
  mediaAsset,
  searchKnowledgeChunks,
  user,
} from '../src'

const connectionString = process.env.DATABASE_URL
const embeddingMetadata = {
  provider: 'alibaba',
  model: 'qwen3.7-text-embedding',
  dimensions: 1_536,
} as const

describe.skipIf(!connectionString)('knowledge indexing', () => {
  const pool = new Pool({ connectionString })
  const db = createDatabase(pool)

  beforeAll(async () => {
    await migrate(db, { migrationsFolder: 'drizzle' })
  })

  afterAll(() => pool.end())

  it('retrieves private asset descriptions only while their library reference is valid', async () => {
    const ownerId = randomUUID()
    await db.insert(user).values({ id: ownerId, name: 'Owner', email: `${ownerId}@example.com` })
    const workspace = await bootstrapWorkspace(db, {
      userId: ownerId,
      userName: 'Owner',
      name: 'Asset knowledge',
    })
    const base = await createKnowledgeBase(db, {
      workspaceId: workspace.id,
      createdByUserId: ownerId,
      name: 'Guides',
    })
    const assetId = randomUUID()
    await db.insert(mediaAsset).values({
      id: assetId,
      workspaceId: workspace.id,
      title: 'Setup guide',
      filename: 'guide.pdf',
      kind: 'FILE',
      mimeType: 'application/pdf',
      byteSize: 12,
      sha256: 'a'.repeat(64),
      storageKey: 'test/guide',
      inLibrary: true,
    })
    const doc = await createInlineKnowledgeDocument(db, {
      workspaceId: workspace.id,
      knowledgeBaseId: base.id,
      createdByUserId: ownerId,
      name: 'Setup guide',
      text: 'A setup guide with connection instructions.',
      mediaAssetId: assetId,
    })
    expect(doc.mediaAssetId).toBe(assetId)
    const claimed = await claimKnowledgeDocument(db, { documentId: doc.id })
    if (!claimed) throw new Error('Description not claimed')
    await completeKnowledgeDocument(db, {
      documentId: doc.id,
      workspaceId: workspace.id,
      knowledgeBaseId: base.id,
      contentSha256: 'b'.repeat(64),
      processingStartedAt: claimed.processingStartedAt,
      chunks: [{ text: 'A setup guide with connection instructions.', embedding: vector(0) }],
      embeddingMetadata,
    })
    const search = () =>
      searchKnowledgeChunks(db, {
        workspaceId: workspace.id,
        knowledgeBaseId: base.id,
        embedding: vector(0),
        embeddingMetadata,
      })
    expect(await search()).toEqual([expect.objectContaining({ mediaAssetId: assetId })])
    await db.update(mediaAsset).set({ deletedAt: new Date() }).where(eq(mediaAsset.id, assetId))
    expect(await search()).toEqual([])
    await expect(
      createInlineKnowledgeDocument(db, {
        workspaceId: workspace.id,
        knowledgeBaseId: base.id,
        createdByUserId: ownerId,
        name: 'Unavailable',
        text: 'Description',
        mediaAssetId: assetId,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('atomically indexes, scopes, retrieves, and deletes vector chunks', async () => {
    const firstUserId = randomUUID()
    const secondUserId = randomUUID()
    await db.insert(user).values([
      { id: firstUserId, name: 'First owner', email: `${firstUserId}@example.com` },
      { id: secondUserId, name: 'Second owner', email: `${secondUserId}@example.com` },
    ])
    const firstWorkspace = await bootstrapWorkspace(db, {
      userId: firstUserId,
      userName: 'First owner',
      name: 'Knowledge first',
    })
    const secondWorkspace = await bootstrapWorkspace(db, {
      userId: secondUserId,
      userName: 'Second owner',
      name: 'Knowledge second',
    })
    const firstBase = await createKnowledgeBase(db, {
      workspaceId: firstWorkspace.id,
      createdByUserId: firstUserId,
      name: 'Support facts',
    })
    const secondBase = await createKnowledgeBase(db, {
      workspaceId: secondWorkspace.id,
      createdByUserId: secondUserId,
      name: 'Other facts',
    })
    const firstDocument = await createInlineKnowledgeDocument(db, {
      workspaceId: firstWorkspace.id,
      knowledgeBaseId: firstBase.id,
      createdByUserId: firstUserId,
      name: 'Shipping',
      text: 'Shipping is free.',
    })
    const secondDocument = await createInlineKnowledgeDocument(db, {
      workspaceId: firstWorkspace.id,
      knowledgeBaseId: firstBase.id,
      createdByUserId: firstUserId,
      name: 'Returns',
      text: 'Returns take thirty days.',
    })
    const otherDocument = await createInlineKnowledgeDocument(db, {
      workspaceId: secondWorkspace.id,
      knowledgeBaseId: secondBase.id,
      createdByUserId: secondUserId,
      name: 'Private',
      text: 'Private workspace fact.',
    })
    const firstClaim = await claimKnowledgeDocument(db, { documentId: firstDocument.id })
    const secondClaim = await claimKnowledgeDocument(db, { documentId: secondDocument.id })
    const otherClaim = await claimKnowledgeDocument(db, { documentId: otherDocument.id })
    if (!firstClaim || !secondClaim || !otherClaim) throw new Error('Documents were not claimed')

    const near = vector(0)
    const far = vector(1)
    await completeKnowledgeDocument(db, {
      documentId: firstDocument.id,
      workspaceId: firstWorkspace.id,
      knowledgeBaseId: firstBase.id,
      processingStartedAt: firstClaim.processingStartedAt,
      contentSha256: 'a'.repeat(64),
      embeddingMetadata,
      chunks: Array.from({ length: 7 }, (_, ordinal) => ({
        text: `shipping ${ordinal}`,
        embedding: near,
      })),
    })
    expect(await claimKnowledgeDocument(db, { documentId: firstDocument.id })).toBeNull()
    await completeKnowledgeDocument(db, {
      documentId: secondDocument.id,
      workspaceId: firstWorkspace.id,
      knowledgeBaseId: firstBase.id,
      processingStartedAt: secondClaim.processingStartedAt,
      contentSha256: 'b'.repeat(64),
      embeddingMetadata,
      chunks: [{ text: 'returns', embedding: far }],
    })
    await completeKnowledgeDocument(db, {
      documentId: otherDocument.id,
      workspaceId: secondWorkspace.id,
      knowledgeBaseId: secondBase.id,
      processingStartedAt: otherClaim.processingStartedAt,
      contentSha256: 'c'.repeat(64),
      embeddingMetadata,
      chunks: [{ text: 'private', embedding: near }],
    })

    const results = await searchKnowledgeChunks(db, {
      workspaceId: firstWorkspace.id,
      knowledgeBaseId: firstBase.id,
      embedding: near,
      embeddingMetadata,
      maxDistance: 0.01,
      limit: 10,
    })
    expect(results).toHaveLength(6)
    expect(
      results.every(({ knowledgeDocumentId }) => knowledgeDocumentId === firstDocument.id),
    ).toBe(true)

    const otherResults = await searchKnowledgeChunks(db, {
      workspaceId: secondWorkspace.id,
      knowledgeBaseId: secondBase.id,
      embedding: near,
      embeddingMetadata,
      maxDistance: 0.01,
    })
    expect(otherResults.map(({ knowledgeDocumentId }) => knowledgeDocumentId)).toEqual([
      otherDocument.id,
    ])

    await deleteKnowledgeDocument(db, {
      workspaceId: firstWorkspace.id,
      knowledgeBaseId: firstBase.id,
      documentId: firstDocument.id,
      actingUserId: firstUserId,
    })
    expect(
      await db
        .select()
        .from(knowledgeChunk)
        .where(eq(knowledgeChunk.knowledgeDocumentId, firstDocument.id)),
    ).toHaveLength(0)
    expect(
      await db
        .select()
        .from(knowledgeChunk)
        .where(eq(knowledgeChunk.knowledgeDocumentId, secondDocument.id)),
    ).toHaveLength(1)
  })

  it('records active embedding metadata and rejects retrieval mismatches', async () => {
    const ownerId = randomUUID()
    await db
      .insert(user)
      .values({ id: ownerId, name: 'Metadata owner', email: `${ownerId}@example.com` })
    const workspace = await bootstrapWorkspace(db, {
      userId: ownerId,
      userName: 'Metadata owner',
      name: 'Knowledge metadata',
    })
    const base = await createKnowledgeBase(db, {
      workspaceId: workspace.id,
      createdByUserId: ownerId,
      name: 'Metadata facts',
    })
    const document = await createInlineKnowledgeDocument(db, {
      workspaceId: workspace.id,
      knowledgeBaseId: base.id,
      createdByUserId: ownerId,
      name: 'Metadata document',
      text: 'Metadata content',
    })
    const claimed = await claimKnowledgeDocument(db, { documentId: document.id })
    if (!claimed) throw new Error('Document was not claimed')

    await completeKnowledgeDocument(db, {
      documentId: document.id,
      workspaceId: workspace.id,
      knowledgeBaseId: base.id,
      processingStartedAt: claimed.processingStartedAt,
      contentSha256: 'e'.repeat(64),
      embeddingMetadata,
      chunks: [{ text: 'metadata', embedding: vector(0) }],
    })

    const [storedBase] = await db
      .select({
        provider: knowledgeBase.embeddingProvider,
        model: knowledgeBase.embeddingModel,
        dimensions: knowledgeBase.embeddingDimensions,
      })
      .from(knowledgeBase)
      .where(eq(knowledgeBase.id, base.id))
    expect(storedBase).toEqual(embeddingMetadata)

    await expect(
      searchKnowledgeChunks(db, {
        workspaceId: workspace.id,
        knowledgeBaseId: base.id,
        embedding: vector(0),
        embeddingMetadata: { ...embeddingMetadata, model: 'other-model' },
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
      message: 'Knowledge base embedding configuration mismatch',
    } satisfies Partial<KnowledgeError>)
  })

  it('leaves no chunks when a processing failure is persisted', async () => {
    const ownerId = randomUUID()
    await db
      .insert(user)
      .values({ id: ownerId, name: 'Failure owner', email: `${ownerId}@example.com` })
    const workspace = await bootstrapWorkspace(db, {
      userId: ownerId,
      userName: 'Failure owner',
      name: 'Knowledge failure',
    })
    const base = await createKnowledgeBase(db, {
      workspaceId: workspace.id,
      createdByUserId: ownerId,
      name: 'Failures',
    })
    const document = await createInlineKnowledgeDocument(db, {
      workspaceId: workspace.id,
      knowledgeBaseId: base.id,
      createdByUserId: ownerId,
      name: 'Broken',
      text: 'content',
    })
    const claimed = await claimKnowledgeDocument(db, { documentId: document.id })
    if (!claimed) throw new Error('Document was not claimed')
    await expect(
      completeKnowledgeDocument(db, {
        documentId: document.id,
        workspaceId: workspace.id,
        knowledgeBaseId: base.id,
        processingStartedAt: claimed.processingStartedAt,
        contentSha256: 'd'.repeat(64),
        embeddingMetadata,
        chunks: [{ text: 'broken', embedding: [1] }],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_EMBEDDING' })
    await failKnowledgeDocument(db, {
      documentId: document.id,
      processingStartedAt: claimed.processingStartedAt,
      failureCode: 'INVALID_EMBEDDING',
      failureMessage: 'Embedding provider returned an invalid response',
    })
    const [stored] = await db
      .select({ status: knowledgeDocument.status })
      .from(knowledgeDocument)
      .where(
        and(eq(knowledgeDocument.id, document.id), eq(knowledgeDocument.workspaceId, workspace.id)),
      )
    expect(stored?.status).toBe('FAILED')
    expect(
      await db
        .select()
        .from(knowledgeChunk)
        .where(eq(knowledgeChunk.knowledgeDocumentId, document.id)),
    ).toHaveLength(0)
  })

  it('recovers uploaded and stale processing documents', async () => {
    const ownerId = randomUUID()
    await db
      .insert(user)
      .values({ id: ownerId, name: 'Recovery owner', email: `${ownerId}@example.com` })
    const workspace = await bootstrapWorkspace(db, {
      userId: ownerId,
      userName: 'Recovery owner',
      name: 'Knowledge recovery',
    })
    const base = await createKnowledgeBase(db, {
      workspaceId: workspace.id,
      createdByUserId: ownerId,
      name: 'Recovery',
    })
    const uploaded = await createInlineKnowledgeDocument(db, {
      workspaceId: workspace.id,
      knowledgeBaseId: base.id,
      createdByUserId: ownerId,
      name: 'Uploaded',
      text: 'uploaded',
    })
    expect(
      await listPendingKnowledgeDocumentIds(db, { now: new Date(), claimTimeoutMs: 1_000 }),
    ).toContain(uploaded.id)

    const processing = await createInlineKnowledgeDocument(db, {
      workspaceId: workspace.id,
      knowledgeBaseId: base.id,
      createdByUserId: ownerId,
      name: 'Processing',
      text: 'processing',
    })
    const claimed = await claimKnowledgeDocument(db, {
      documentId: processing.id,
      now: new Date('2026-01-01T00:00:00.000Z'),
    })
    if (!claimed) throw new Error('Document was not claimed')
    expect(
      await listPendingKnowledgeDocumentIds(db, {
        now: new Date('2026-01-01T00:06:00.000Z'),
        claimTimeoutMs: 5 * 60 * 1_000,
      }),
    ).toContain(processing.id)
  })

  it('persists file documents, exposes their storage key, and keeps validation failures terminal', async () => {
    const ownerId = randomUUID()
    await db
      .insert(user)
      .values({ id: ownerId, name: 'File owner', email: `${ownerId}@example.com` })
    const workspace = await bootstrapWorkspace(db, {
      userId: ownerId,
      userName: 'File owner',
      name: 'Knowledge files',
    })
    const base = await createKnowledgeBase(db, {
      workspaceId: workspace.id,
      createdByUserId: ownerId,
      name: 'File facts',
    })

    const uploaded = await createFileKnowledgeDocument(db, {
      workspaceId: workspace.id,
      knowledgeBaseId: base.id,
      createdByUserId: ownerId,
      name: 'Guide.pdf',
      sourceType: 'PDF',
      storageKey: 'knowledge/guide',
    })
    expect(uploaded).toEqual(expect.objectContaining({ sourceType: 'PDF', status: 'UPLOADED' }))
    const claimed = await claimKnowledgeDocument(db, { documentId: uploaded.id })
    expect(claimed).toEqual(expect.objectContaining({ storageKey: 'knowledge/guide' }))

    const failed = await createFileKnowledgeDocument(db, {
      workspaceId: workspace.id,
      knowledgeBaseId: base.id,
      createdByUserId: ownerId,
      name: 'Oversized.txt',
      sourceType: 'TXT',
      failureCode: 'TOO_LARGE',
    })
    expect(failed).toEqual(expect.objectContaining({ status: 'FAILED', failureCode: 'TOO_LARGE' }))
    expect(
      await listPendingKnowledgeDocumentIds(db, { now: new Date(), claimTimeoutMs: 1_000 }),
    ).not.toContain(failed.id)
  })
})

function vector(axis: number) {
  const result = Array.from({ length: 1_536 }, () => 0)
  result[axis] = 1
  return result
}
