import { randomUUID } from 'node:crypto'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import {
  bootstrapWorkspace,
  claimKnowledgeDocument,
  completeKnowledgeDocument,
  createDatabase,
  createInlineKnowledgeDocument,
  createKnowledgeBase,
  deleteKnowledgeDocument,
  failKnowledgeDocument,
  knowledgeChunk,
  knowledgeDocument,
  listPendingKnowledgeDocumentIds,
  searchKnowledgeChunks,
  user,
} from '../src'

const connectionString = process.env.DATABASE_URL

describe.skipIf(!connectionString)('knowledge indexing', () => {
  const pool = new Pool({ connectionString })
  const db = createDatabase(pool)

  beforeAll(async () => {
    await migrate(db, { migrationsFolder: 'drizzle' })
  })

  afterAll(() => pool.end())

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
      chunks: [{ text: 'returns', embedding: far }],
    })
    await completeKnowledgeDocument(db, {
      documentId: otherDocument.id,
      workspaceId: secondWorkspace.id,
      knowledgeBaseId: secondBase.id,
      processingStartedAt: otherClaim.processingStartedAt,
      contentSha256: 'c'.repeat(64),
      chunks: [{ text: 'private', embedding: near }],
    })

    const results = await searchKnowledgeChunks(db, {
      workspaceId: firstWorkspace.id,
      knowledgeBaseId: firstBase.id,
      embedding: near,
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
})

function vector(axis: number) {
  const result = Array.from({ length: 1_536 }, () => 0)
  result[axis] = 1
  return result
}
