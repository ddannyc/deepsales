import { and, asc, cosineDistance, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm'
import type { Database } from './database'
import {
  knowledgeBase,
  knowledgeChunk,
  knowledgeDocument,
  member,
  mediaAsset,
  workspaceUserAccess,
} from './schema'

export const KNOWLEDGE_CHUNK_CODE_POINTS = 2_000
export const KNOWLEDGE_CHUNK_OVERLAP_CODE_POINTS = 200
export const MAX_INLINE_KNOWLEDGE_CODE_POINTS = 1_000_000
export const KNOWLEDGE_DOCUMENT_CLAIM_TIMEOUT_MS = 5 * 60 * 1_000
export const MAX_KNOWLEDGE_RETRIEVAL_CHUNKS = 6
export const DEFAULT_KNOWLEDGE_RETRIEVAL_MAX_DISTANCE = 0.35

export type KnowledgeEmbeddingMetadata = {
  provider: string
  model: string
  dimensions: number
}

export type KnowledgeErrorCode = 'FORBIDDEN' | 'NOT_FOUND' | 'INVALID_REQUEST' | 'CONFLICT'

export class KnowledgeError extends Error {
  constructor(
    readonly code: KnowledgeErrorCode,
    message: string = code,
  ) {
    super(message)
  }
}

export type KnowledgeProcessingErrorCode =
  | 'EMPTY_CONTENT'
  | 'DOCUMENT_CONTENT_MISSING'
  | 'FILE_EXTRACTION_FAILED'
  | 'INVALID_UTF8'
  | 'INVALID_EMBEDDING'
  | 'EMBEDDING_CONFIGURATION_MISMATCH'
  | 'TOO_LARGE'
  | 'DOCUMENT_NOT_PROCESSABLE'

export class KnowledgeProcessingError extends Error {
  constructor(
    readonly code: KnowledgeProcessingErrorCode,
    message: string = code,
  ) {
    super(message)
  }
}

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0]

export type KnowledgeDocumentSummary = {
  mediaAvailable: boolean
  mediaAssetId: string | null
  id: string
  workspaceId: string
  knowledgeBaseId: string
  name: string
  sourceType: 'TEXT' | 'PDF' | 'DOCX' | 'TXT' | 'MARKDOWN'
  question: string | null
  answer: string | null
  revision: number
  status: 'UPLOADED' | 'PROCESSING' | 'READY' | 'FAILED'
  contentSha256: string | null
  failureCode: string | null
  failureMessage: string | null
  processingStartedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export type KnowledgeFileSourceType = 'PDF' | 'DOCX' | 'TXT' | 'MARKDOWN'

export function normalizeKnowledgeText(text: string) {
  const normalizedLineEndings = text.replace(/\r\n?/g, '\n')
  const withoutControls = Array.from(normalizedLineEndings, (character) => {
    const code = character.charCodeAt(0)
    return (code < 32 && code !== 9 && code !== 10) || (code >= 127 && code <= 159)
      ? ' '
      : character
  }).join('')
  return withoutControls
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim()
}

export function chunkKnowledgeText(text: string) {
  const normalized = normalizeKnowledgeText(text)
  if (!normalized) return []

  const chunks: string[] = []
  let current: string[] = []
  const paragraphs = normalized
    .split(/\n(?:[ \t]*\n)+/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)

  for (const paragraph of paragraphs) {
    const points = Array.from(paragraph)
    if (points.length > KNOWLEDGE_CHUNK_CODE_POINTS) {
      if (current.length) {
        chunks.push(current.join(''))
        current = []
      }
      for (
        let start = 0;
        start < points.length;
        start += KNOWLEDGE_CHUNK_CODE_POINTS - KNOWLEDGE_CHUNK_OVERLAP_CODE_POINTS
      ) {
        const end = Math.min(start + KNOWLEDGE_CHUNK_CODE_POINTS, points.length)
        chunks.push(points.slice(start, end).join(''))
        if (end === points.length) break
      }
      continue
    }

    const candidate = current.length ? [...current, '\n', '\n', ...points] : points
    if (candidate.length <= KNOWLEDGE_CHUNK_CODE_POINTS) {
      current = candidate
      continue
    }

    chunks.push(current.join(''))
    const overlap = current.slice(-KNOWLEDGE_CHUNK_OVERLAP_CODE_POINTS)
    current =
      overlap.length + 2 + points.length <= KNOWLEDGE_CHUNK_CODE_POINTS
        ? [...overlap, '\n', '\n', ...points]
        : points
  }

  if (current.length) chunks.push(current.join(''))
  return chunks
}

export async function hashKnowledgeText(text: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function normalizeQuestionAnswer(input: { question: string; answer: string }) {
  const question = normalizeKnowledgeText(input.question)
  const answer = normalizeKnowledgeText(input.answer)
  if (!question || !answer || Array.from(question).length > 400 || Array.from(answer).length > 1500)
    throw new KnowledgeError('INVALID_REQUEST', 'Question or answer is empty or too long')
  return { question, answer, sourceText: `Question: ${question}\nAnswer: ${answer}` }
}

export async function createKnowledgeQuestions(
  db: Database,
  input: {
    workspaceId: string
    knowledgeBaseId: string
    actingUserId: string
    items: { id: string; question: string; answer: string }[]
  },
) {
  if (!input.items.length || input.items.length > 100) throw new KnowledgeError('INVALID_REQUEST')
  const items = await Promise.all(
    input.items.map(async (item) => {
      const pair = normalizeQuestionAnswer(item)
      return {
        id: item.id,
        ...pair,
        questionKey: await hashKnowledgeText(pair.question),
        name: Array.from(pair.question).slice(0, 80).join(''),
      }
    }),
  )
  return db.transaction(async (tx) => {
    await assertManager(tx, input.workspaceId, input.actingUserId)
    await assertKnowledgeBase(tx, input.workspaceId, input.knowledgeBaseId)
    await tx.execute(
      sql`select id from knowledge_base where id = ${input.knowledgeBaseId} for update`,
    )
    await tx
      .insert(knowledgeDocument)
      .values(
        items.map((item) => ({
          ...item,
          workspaceId: input.workspaceId,
          knowledgeBaseId: input.knowledgeBaseId,
          sourceType: 'TEXT' as const,
        })),
      )
      .onConflictDoNothing()
    const rows = await tx
      .select({ ...documentSummarySelection, questionKey: knowledgeDocument.questionKey })
      .from(knowledgeDocument)
      .where(
        and(
          eq(knowledgeDocument.workspaceId, input.workspaceId),
          eq(knowledgeDocument.knowledgeBaseId, input.knowledgeBaseId),
          or(
            inArray(
              knowledgeDocument.id,
              items.map((i) => i.id),
            ),
            inArray(
              knowledgeDocument.questionKey,
              items.map((i) => i.questionKey),
            ),
          ),
        ),
      )
    const documents = new Map<string, KnowledgeDocumentSummary>()
    for (const item of items) {
      const byId = rows.find((r) => r.id === item.id)
      const row = byId ?? rows.find((r) => r.questionKey === item.questionKey)
      if (!row || row.question !== item.question || row.answer !== item.answer)
        throw new KnowledgeError(
          'CONFLICT',
          'Question or retry identifier already exists with different content',
        )
      const { questionKey: _key, ...document } = row
      documents.set(document.id, document)
    }
    return [...documents.values()]
  })
}

export async function updateKnowledgeQuestion(
  db: Database,
  input: {
    workspaceId: string
    knowledgeBaseId: string
    actingUserId: string
    documentId: string
    question: string
    answer: string
    expectedRevision: number
  },
) {
  const pair = normalizeQuestionAnswer(input)
  const questionKey = await hashKnowledgeText(pair.question)
  return db.transaction(async (tx) => {
    await assertManager(tx, input.workspaceId, input.actingUserId)
    await assertKnowledgeBase(tx, input.workspaceId, input.knowledgeBaseId)
    await tx.execute(
      sql`select id from knowledge_base where id = ${input.knowledgeBaseId} for update`,
    )
    const [current] = await tx
      .select()
      .from(knowledgeDocument)
      .where(
        and(
          eq(knowledgeDocument.id, input.documentId),
          eq(knowledgeDocument.workspaceId, input.workspaceId),
          eq(knowledgeDocument.knowledgeBaseId, input.knowledgeBaseId),
        ),
      )
      .for('update')
    if (!current?.question) throw new KnowledgeError('NOT_FOUND', 'Question not found')
    if (current.revision !== input.expectedRevision) {
      if (
        current.revision === input.expectedRevision + 1 &&
        current.question === pair.question &&
        current.answer === pair.answer
      )
        return (
          await tx
            .select(documentSummarySelection)
            .from(knowledgeDocument)
            .where(eq(knowledgeDocument.id, current.id))
        )[0]
      throw new KnowledgeError('CONFLICT', 'Question changed; refresh before editing')
    }
    const [duplicate] = await tx
      .select({ id: knowledgeDocument.id })
      .from(knowledgeDocument)
      .where(
        and(
          eq(knowledgeDocument.knowledgeBaseId, input.knowledgeBaseId),
          eq(knowledgeDocument.questionKey, questionKey),
        ),
      )
    if (duplicate && duplicate.id !== current.id)
      throw new KnowledgeError('CONFLICT', 'Question already exists')
    await tx.delete(knowledgeChunk).where(eq(knowledgeChunk.knowledgeDocumentId, current.id))
    const [updated] = await tx
      .update(knowledgeDocument)
      .set({
        ...pair,
        questionKey,
        name: Array.from(pair.question).slice(0, 80).join(''),
        revision: current.revision + 1,
        indexOperationId: crypto.randomUUID(),
        status: 'UPLOADED',
        contentSha256: null,
        failureCode: null,
        failureMessage: null,
        processingStartedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(knowledgeDocument.id, current.id))
      .returning(documentSummarySelection)
    return updated
  })
}

export async function createKnowledgeBase(
  db: Database,
  input: { workspaceId: string; createdByUserId: string; name: string },
) {
  const name = cleanName(input.name, 'Knowledge base name')
  return db.transaction(async (tx) => {
    await assertManager(tx, input.workspaceId, input.createdByUserId)
    const [created] = await tx
      .insert(knowledgeBase)
      .values({ workspaceId: input.workspaceId, name })
      .returning({
        id: knowledgeBase.id,
        workspaceId: knowledgeBase.workspaceId,
        name: knowledgeBase.name,
        createdAt: knowledgeBase.createdAt,
        updatedAt: knowledgeBase.updatedAt,
      })
    if (!created) throw new KnowledgeError('INVALID_REQUEST', 'Knowledge base was not created')
    return created
  })
}

export async function listKnowledgeBases(
  db: Database,
  input: { workspaceId: string; userId: string },
) {
  await assertAccess(db, input.workspaceId, input.userId)
  return db
    .select({
      id: knowledgeBase.id,
      workspaceId: knowledgeBase.workspaceId,
      name: knowledgeBase.name,
      createdAt: knowledgeBase.createdAt,
      updatedAt: knowledgeBase.updatedAt,
    })
    .from(knowledgeBase)
    .where(eq(knowledgeBase.workspaceId, input.workspaceId))
    .orderBy(asc(knowledgeBase.name), asc(knowledgeBase.id))
}

export async function listKnowledgeDocuments(
  db: Database,
  input: { workspaceId: string; knowledgeBaseId: string; userId: string },
) {
  await assertKnowledgeBaseAccess(db, input)
  return db
    .select(documentSummarySelection)
    .from(knowledgeDocument)
    .where(
      and(
        eq(knowledgeDocument.workspaceId, input.workspaceId),
        eq(knowledgeDocument.knowledgeBaseId, input.knowledgeBaseId),
      ),
    )
    .orderBy(asc(knowledgeDocument.createdAt), asc(knowledgeDocument.id))
}

export async function createInlineKnowledgeDocument(
  db: Database,
  input: {
    workspaceId: string
    knowledgeBaseId: string
    createdByUserId: string
    name: string
    text: string
    mediaAssetId?: string
  },
) {
  const name = cleanName(input.name, 'Document name')
  const normalized = normalizeKnowledgeText(input.text)
  const codePointLength = Array.from(normalized).length
  const failureCode = !normalized
    ? 'EMPTY_CONTENT'
    : codePointLength > MAX_INLINE_KNOWLEDGE_CODE_POINTS
      ? 'TOO_LARGE'
      : null
  const contentSha256 = failureCode ? await hashKnowledgeText(normalized) : null
  const now = new Date()

  return db.transaction(async (tx) => {
    await assertManager(tx, input.workspaceId, input.createdByUserId)
    await assertKnowledgeBase(tx, input.workspaceId, input.knowledgeBaseId)
    if (input.mediaAssetId) {
      const [asset] = await tx
        .select({ id: mediaAsset.id })
        .from(mediaAsset)
        .where(
          and(
            eq(mediaAsset.id, input.mediaAssetId),
            eq(mediaAsset.workspaceId, input.workspaceId),
            eq(mediaAsset.inLibrary, true),
            isNull(mediaAsset.deletedAt),
          ),
        )
        .for('share')
      if (!asset) throw new KnowledgeError('NOT_FOUND', 'Media asset is unavailable')
      if (!normalized || codePointLength > 2000)
        throw new KnowledgeError(
          'INVALID_REQUEST',
          'Asset description must contain 1–2000 code points',
        )
    }
    const [created] = await tx
      .insert(knowledgeDocument)
      .values({
        workspaceId: input.workspaceId,
        knowledgeBaseId: input.knowledgeBaseId,
        name,
        sourceType: 'TEXT',
        sourceText: input.text,
        mediaAssetId: input.mediaAssetId,
        status: failureCode ? 'FAILED' : 'UPLOADED',
        contentSha256,
        failureCode,
        failureMessage: failureCode ? failureMessage(failureCode) : null,
        updatedAt: now,
      })
      .returning(documentSummarySelection)
    if (!created) throw new KnowledgeError('INVALID_REQUEST', 'Document was not created')
    return created
  })
}

export async function createFileKnowledgeDocument(
  db: Database,
  input: {
    workspaceId: string
    knowledgeBaseId: string
    createdByUserId: string
    name: string
    sourceType: KnowledgeFileSourceType
    storageKey?: string
    failureCode?: string
    failureMessage?: string
  },
) {
  const name = cleanName(input.name, 'Document name')
  const failureCode = input.failureCode?.slice(0, 100) ?? null
  const now = new Date()

  return db.transaction(async (tx) => {
    await assertManager(tx, input.workspaceId, input.createdByUserId)
    await assertKnowledgeBase(tx, input.workspaceId, input.knowledgeBaseId)
    const [created] = await tx
      .insert(knowledgeDocument)
      .values({
        workspaceId: input.workspaceId,
        knowledgeBaseId: input.knowledgeBaseId,
        name,
        sourceType: input.sourceType,
        storageKey: input.storageKey ?? null,
        status: failureCode ? 'FAILED' : 'UPLOADED',
        failureCode,
        failureMessage: failureCode
          ? (input.failureMessage ?? failureMessage(failureCode)).slice(0, 500)
          : null,
        updatedAt: now,
      })
      .returning(documentSummarySelection)
    if (!created) throw new KnowledgeError('INVALID_REQUEST', 'Document was not created')
    return created
  })
}

export async function assertKnowledgeBaseManager(
  db: Database,
  input: { workspaceId: string; knowledgeBaseId: string; userId: string },
) {
  await db.transaction(async (tx) => {
    await assertManager(tx, input.workspaceId, input.userId)
    await assertKnowledgeBase(tx, input.workspaceId, input.knowledgeBaseId)
  })
}

export async function getKnowledgeDocumentStorageKey(
  db: Database,
  input: {
    workspaceId: string
    knowledgeBaseId: string
    documentId: string
    actingUserId: string
  },
) {
  return db.transaction(async (tx) => {
    await assertManager(tx, input.workspaceId, input.actingUserId)
    const [document] = await tx
      .select({ id: knowledgeDocument.id, storageKey: knowledgeDocument.storageKey })
      .from(knowledgeDocument)
      .where(
        and(
          eq(knowledgeDocument.id, input.documentId),
          eq(knowledgeDocument.workspaceId, input.workspaceId),
          eq(knowledgeDocument.knowledgeBaseId, input.knowledgeBaseId),
        ),
      )
      .limit(1)
    if (!document) throw new KnowledgeError('NOT_FOUND', 'Document not found')
    return document
  })
}

export async function deleteKnowledgeDocument(
  db: Database,
  input: {
    workspaceId: string
    knowledgeBaseId: string
    documentId: string
    actingUserId: string
  },
) {
  return db.transaction(async (tx) => {
    await assertManager(tx, input.workspaceId, input.actingUserId)
    const [document] = await tx
      .select({ id: knowledgeDocument.id })
      .from(knowledgeDocument)
      .where(
        and(
          eq(knowledgeDocument.id, input.documentId),
          eq(knowledgeDocument.workspaceId, input.workspaceId),
          eq(knowledgeDocument.knowledgeBaseId, input.knowledgeBaseId),
        ),
      )
      .limit(1)
    if (!document) throw new KnowledgeError('NOT_FOUND', 'Document not found')
    await tx.delete(knowledgeDocument).where(eq(knowledgeDocument.id, input.documentId))
    return document
  })
}

export async function claimKnowledgeDocument(
  db: Database,
  input: { documentId: string; now?: Date; claimTimeoutMs?: number },
) {
  const now = input.now ?? new Date()
  const cutoff = new Date(
    now.getTime() - (input.claimTimeoutMs ?? KNOWLEDGE_DOCUMENT_CLAIM_TIMEOUT_MS),
  )

  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({
        id: knowledgeDocument.id,
        workspaceId: knowledgeDocument.workspaceId,
        knowledgeBaseId: knowledgeDocument.knowledgeBaseId,
        name: knowledgeDocument.name,
        sourceType: knowledgeDocument.sourceType,
        sourceText: knowledgeDocument.sourceText,
        storageKey: knowledgeDocument.storageKey,
        status: knowledgeDocument.status,
        processingStartedAt: knowledgeDocument.processingStartedAt,
        revision: knowledgeDocument.revision,
        indexOperationId: knowledgeDocument.indexOperationId,
      })
      .from(knowledgeDocument)
      .where(eq(knowledgeDocument.id, input.documentId))
      .for('update')
      .limit(1)
    if (!current || current.status === 'READY' || current.status === 'FAILED') return null
    if (current.processingStartedAt && current.processingStartedAt.getTime() > cutoff.getTime()) {
      return null
    }

    const [claimed] = await tx
      .update(knowledgeDocument)
      .set({ status: 'PROCESSING', processingStartedAt: now, updatedAt: now })
      .where(
        and(
          eq(knowledgeDocument.id, input.documentId),
          or(
            eq(knowledgeDocument.status, 'UPLOADED'),
            and(
              eq(knowledgeDocument.status, 'PROCESSING'),
              or(
                isNull(knowledgeDocument.processingStartedAt),
                lte(knowledgeDocument.processingStartedAt, cutoff),
              ),
            ),
          ),
        ),
      )
      .returning({ id: knowledgeDocument.id })
    if (!claimed) return null
    return { ...current, status: 'PROCESSING' as const, processingStartedAt: now }
  })
}

export async function completeKnowledgeDocument(
  db: Database,
  input: {
    documentId: string
    processingStartedAt: Date
    workspaceId: string
    knowledgeBaseId: string
    contentSha256: string
    revision?: number
    embeddingMetadata: KnowledgeEmbeddingMetadata
    chunks: Array<{ text: string; embedding: number[] }>
    now?: Date
  },
) {
  if (!input.chunks.length) throw new KnowledgeProcessingError('EMPTY_CONTENT')
  assertEmbeddingMetadata(input.embeddingMetadata)
  for (const chunk of input.chunks) assertEmbedding(chunk.embedding)

  const now = input.now ?? new Date()
  return db.transaction(async (tx) => {
    const [base] = await tx
      .select({
        embeddingProvider: knowledgeBase.embeddingProvider,
        embeddingModel: knowledgeBase.embeddingModel,
        embeddingDimensions: knowledgeBase.embeddingDimensions,
      })
      .from(knowledgeBase)
      .where(
        and(
          eq(knowledgeBase.id, input.knowledgeBaseId),
          eq(knowledgeBase.workspaceId, input.workspaceId),
        ),
      )
      .for('update')
      .limit(1)
    if (!base) return null

    const [current] = await tx
      .select({
        status: knowledgeDocument.status,
        processingStartedAt: knowledgeDocument.processingStartedAt,
        revision: knowledgeDocument.revision,
      })
      .from(knowledgeDocument)
      .where(
        and(
          eq(knowledgeDocument.id, input.documentId),
          eq(knowledgeDocument.workspaceId, input.workspaceId),
          eq(knowledgeDocument.knowledgeBaseId, input.knowledgeBaseId),
        ),
      )
      .for('update')
      .limit(1)
    if (
      current?.status !== 'PROCESSING' ||
      current.revision !== (input.revision ?? 1) ||
      current.processingStartedAt?.getTime() !== input.processingStartedAt.getTime()
    ) {
      return null
    }

    const [existingChunk] = await tx
      .select({ id: knowledgeChunk.id })
      .from(knowledgeChunk)
      .where(eq(knowledgeChunk.knowledgeBaseId, input.knowledgeBaseId))
      .limit(1)
    const activeMetadata =
      base.embeddingProvider !== null &&
      base.embeddingModel !== null &&
      base.embeddingDimensions !== null
        ? {
            provider: base.embeddingProvider,
            model: base.embeddingModel,
            dimensions: base.embeddingDimensions,
          }
        : null
    if (
      existingChunk ||
      base.embeddingProvider !== null ||
      base.embeddingModel !== null ||
      base.embeddingDimensions !== null
    ) {
      if (!activeMetadata || !embeddingMetadataMatches(activeMetadata, input.embeddingMetadata)) {
        throw new KnowledgeProcessingError(
          'EMBEDDING_CONFIGURATION_MISMATCH',
          'Knowledge base embedding configuration mismatch',
        )
      }
    }

    await tx.delete(knowledgeChunk).where(eq(knowledgeChunk.knowledgeDocumentId, input.documentId))
    await tx.insert(knowledgeChunk).values(
      input.chunks.map((chunk, ordinal) => ({
        knowledgeDocumentId: input.documentId,
        knowledgeBaseId: input.knowledgeBaseId,
        workspaceId: input.workspaceId,
        ordinal,
        text: chunk.text,
        embedding: chunk.embedding,
      })),
    )
    const [updated] = await tx
      .update(knowledgeDocument)
      .set({
        status: 'READY',
        processingStartedAt: null,
        contentSha256: input.contentSha256,
        failureCode: null,
        failureMessage: null,
        updatedAt: now,
      })
      .where(eq(knowledgeDocument.id, input.documentId))
      .returning(documentSummarySelection)
    if (!activeMetadata) {
      await tx
        .update(knowledgeBase)
        .set({
          embeddingProvider: input.embeddingMetadata.provider,
          embeddingModel: input.embeddingMetadata.model,
          embeddingDimensions: input.embeddingMetadata.dimensions,
          updatedAt: now,
        })
        .where(eq(knowledgeBase.id, input.knowledgeBaseId))
    }
    return updated ?? null
  })
}

export async function failKnowledgeDocument(
  db: Database,
  input: {
    documentId: string
    processingStartedAt: Date
    failureCode: string
    revision?: number
    failureMessage?: string
    now?: Date
  },
) {
  const now = input.now ?? new Date()
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({
        status: knowledgeDocument.status,
        processingStartedAt: knowledgeDocument.processingStartedAt,
        revision: knowledgeDocument.revision,
      })
      .from(knowledgeDocument)
      .where(eq(knowledgeDocument.id, input.documentId))
      .for('update')
      .limit(1)
    if (
      current?.status !== 'PROCESSING' ||
      current.revision !== (input.revision ?? 1) ||
      current.processingStartedAt?.getTime() !== input.processingStartedAt.getTime()
    ) {
      return null
    }

    await tx.delete(knowledgeChunk).where(eq(knowledgeChunk.knowledgeDocumentId, input.documentId))
    const [failed] = await tx
      .update(knowledgeDocument)
      .set({
        status: 'FAILED',
        processingStartedAt: null,
        failureCode: input.failureCode.slice(0, 100),
        failureMessage: (input.failureMessage ?? 'Document processing failed').slice(0, 500),
        updatedAt: now,
      })
      .where(eq(knowledgeDocument.id, input.documentId))
      .returning(documentSummarySelection)
    return failed ?? null
  })
}

export async function releaseKnowledgeDocument(
  db: Database,
  input: { documentId: string; processingStartedAt: Date; revision?: number; now?: Date },
) {
  const now = input.now ?? new Date()
  return db
    .update(knowledgeDocument)
    .set({ status: 'UPLOADED', processingStartedAt: null, updatedAt: now })
    .where(
      and(
        eq(knowledgeDocument.id, input.documentId),
        eq(knowledgeDocument.status, 'PROCESSING'),
        eq(knowledgeDocument.processingStartedAt, input.processingStartedAt),
        eq(knowledgeDocument.revision, input.revision ?? 1),
      ),
    )
    .returning({ id: knowledgeDocument.id })
}

export async function listPendingKnowledgeDocumentIds(
  db: Database,
  input: { now?: Date; claimTimeoutMs?: number; limit?: number } = {},
) {
  const now = input.now ?? new Date()
  const cutoff = new Date(
    now.getTime() - (input.claimTimeoutMs ?? KNOWLEDGE_DOCUMENT_CLAIM_TIMEOUT_MS),
  )
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 100)
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({ id: knowledgeDocument.id })
      .from(knowledgeDocument)
      .where(
        or(
          eq(knowledgeDocument.status, 'UPLOADED'),
          and(
            eq(knowledgeDocument.status, 'PROCESSING'),
            or(
              isNull(knowledgeDocument.processingStartedAt),
              lte(knowledgeDocument.processingStartedAt, cutoff),
            ),
          ),
        ),
      )
      .orderBy(asc(knowledgeDocument.updatedAt), asc(knowledgeDocument.id))
      .limit(limit)
      .for('update', { skipLocked: true })
    return rows.map(({ id }) => id)
  })
}

export async function searchKnowledgeChunks(
  db: Database,
  input: {
    workspaceId: string
    knowledgeBaseId: string
    embedding: number[]
    embeddingMetadata: KnowledgeEmbeddingMetadata
    maxDistance?: number
    limit?: number
  },
) {
  await assertKnowledgeBaseEmbeddingCompatibility(db, input)
  assertEmbedding(input.embedding)
  const maxDistance = input.maxDistance ?? DEFAULT_KNOWLEDGE_RETRIEVAL_MAX_DISTANCE
  if (!Number.isFinite(maxDistance) || maxDistance < 0) {
    throw new KnowledgeError('INVALID_REQUEST', 'Invalid retrieval distance')
  }
  const limit = Math.min(Math.max(input.limit ?? MAX_KNOWLEDGE_RETRIEVAL_CHUNKS, 1), 6)
  const distance = cosineDistance(knowledgeChunk.embedding, input.embedding)
  return db
    .select({
      id: knowledgeChunk.id,
      mediaAssetId: knowledgeDocument.mediaAssetId,
      knowledgeDocumentId: knowledgeChunk.knowledgeDocumentId,
      text: knowledgeChunk.text,
      ordinal: knowledgeChunk.ordinal,
      distance,
    })
    .from(knowledgeChunk)
    .innerJoin(knowledgeDocument, eq(knowledgeDocument.id, knowledgeChunk.knowledgeDocumentId))
    .leftJoin(mediaAsset, eq(mediaAsset.id, knowledgeDocument.mediaAssetId))
    .where(
      and(
        eq(knowledgeChunk.workspaceId, input.workspaceId),
        eq(knowledgeChunk.knowledgeBaseId, input.knowledgeBaseId),
        eq(knowledgeDocument.workspaceId, input.workspaceId),
        eq(knowledgeDocument.knowledgeBaseId, input.knowledgeBaseId),
        or(
          isNull(knowledgeDocument.mediaAssetId),
          and(
            eq(mediaAsset.workspaceId, input.workspaceId),
            eq(mediaAsset.inLibrary, true),
            isNull(mediaAsset.deletedAt),
          ),
        ),
        eq(knowledgeDocument.status, 'READY'),
        lte(distance, maxDistance),
      ),
    )
    .orderBy(distance, asc(knowledgeChunk.knowledgeDocumentId), asc(knowledgeChunk.ordinal))
    .limit(limit)
}

export async function assertKnowledgeBaseEmbeddingCompatibility(
  db: Database,
  input: {
    workspaceId: string
    knowledgeBaseId: string
    embeddingMetadata: KnowledgeEmbeddingMetadata
  },
) {
  const [base] = await db
    .select({
      embeddingProvider: knowledgeBase.embeddingProvider,
      embeddingModel: knowledgeBase.embeddingModel,
      embeddingDimensions: knowledgeBase.embeddingDimensions,
    })
    .from(knowledgeBase)
    .where(
      and(
        eq(knowledgeBase.id, input.knowledgeBaseId),
        eq(knowledgeBase.workspaceId, input.workspaceId),
      ),
    )
    .limit(1)
  if (!base) throw new KnowledgeError('NOT_FOUND', 'Knowledge base not found')

  const activeMetadata =
    base.embeddingProvider !== null &&
    base.embeddingModel !== null &&
    base.embeddingDimensions !== null
      ? {
          provider: base.embeddingProvider,
          model: base.embeddingModel,
          dimensions: base.embeddingDimensions,
        }
      : null
  if (!activeMetadata || !embeddingMetadataMatches(activeMetadata, input.embeddingMetadata)) {
    throw new KnowledgeError('INVALID_REQUEST', 'Knowledge base embedding configuration mismatch')
  }
}

const documentSummarySelection = {
  mediaAvailable: sql<boolean>`(${knowledgeDocument.mediaAssetId} is null or exists (select 1 from ${mediaAsset} where ${mediaAsset.id} = ${knowledgeDocument.mediaAssetId} and ${mediaAsset.workspaceId} = ${knowledgeDocument.workspaceId} and ${mediaAsset.inLibrary} and ${mediaAsset.deletedAt} is null))`,
  mediaAssetId: knowledgeDocument.mediaAssetId,
  id: knowledgeDocument.id,
  workspaceId: knowledgeDocument.workspaceId,
  knowledgeBaseId: knowledgeDocument.knowledgeBaseId,
  name: knowledgeDocument.name,
  sourceType: knowledgeDocument.sourceType,
  question: knowledgeDocument.question,
  answer: knowledgeDocument.answer,
  revision: knowledgeDocument.revision,
  status: knowledgeDocument.status,
  contentSha256: knowledgeDocument.contentSha256,
  failureCode: knowledgeDocument.failureCode,
  failureMessage: knowledgeDocument.failureMessage,
  processingStartedAt: knowledgeDocument.processingStartedAt,
  createdAt: knowledgeDocument.createdAt,
  updatedAt: knowledgeDocument.updatedAt,
}

async function assertKnowledgeBaseAccess(
  db: Database,
  input: { workspaceId: string; knowledgeBaseId: string; userId: string },
) {
  await assertAccess(db, input.workspaceId, input.userId)
  await assertKnowledgeBase(db, input.workspaceId, input.knowledgeBaseId)
}

async function assertAccess(db: Database | Transaction, workspaceId: string, userId: string) {
  const [access] = await db
    .select({ id: workspaceUserAccess.id })
    .from(workspaceUserAccess)
    .innerJoin(member, eq(member.workspaceUserAccessId, workspaceUserAccess.id))
    .where(
      and(
        eq(workspaceUserAccess.workspaceId, workspaceId),
        eq(workspaceUserAccess.userId, userId),
        eq(member.workspaceId, workspaceId),
        eq(member.type, 'HUMAN'),
        eq(member.status, 'ACTIVE'),
      ),
    )
    .limit(1)
  if (!access) throw new KnowledgeError('FORBIDDEN', 'Workspace access required')
}

async function assertManager(tx: Transaction, workspaceId: string, userId: string) {
  const [access] = await tx
    .select({ role: workspaceUserAccess.role })
    .from(workspaceUserAccess)
    .innerJoin(member, eq(member.workspaceUserAccessId, workspaceUserAccess.id))
    .where(
      and(
        eq(workspaceUserAccess.workspaceId, workspaceId),
        eq(workspaceUserAccess.userId, userId),
        eq(member.workspaceId, workspaceId),
        eq(member.type, 'HUMAN'),
        eq(member.status, 'ACTIVE'),
      ),
    )
    .limit(1)
  if (!access || access.role === 'AGENT') {
    throw new KnowledgeError('FORBIDDEN', 'Manager access required')
  }
}

async function assertKnowledgeBase(
  db: Database | Transaction,
  workspaceId: string,
  knowledgeBaseId: string,
) {
  const [base] = await db
    .select({ id: knowledgeBase.id })
    .from(knowledgeBase)
    .where(and(eq(knowledgeBase.id, knowledgeBaseId), eq(knowledgeBase.workspaceId, workspaceId)))
    .limit(1)
  if (!base) throw new KnowledgeError('NOT_FOUND', 'Knowledge base not found')
}

function cleanName(value: string, label: string) {
  const name = value.trim()
  if (!name || Array.from(name).length > 100) {
    throw new KnowledgeError('INVALID_REQUEST', `${label} is invalid`)
  }
  return name
}

function failureMessage(code: string) {
  return (
    {
      EMPTY_CONTENT: 'Inline text is empty',
      TOO_LARGE: 'Document is larger than 10 MiB',
      INVALID_UTF8: 'Document is not valid UTF-8',
      FILE_EXTRACTION_FAILED: 'Document could not be extracted',
      DOCUMENT_CONTENT_MISSING: 'Document content is unavailable',
      MIME_MISMATCH: 'File type does not match its extension',
      INVALID_FILE_SIGNATURE: 'File signature is invalid',
      UNSUPPORTED_FILE_TYPE: 'File type is not supported',
    }[code] ?? 'Document processing failed'
  )
}

function assertEmbedding(embedding: number[]): asserts embedding is number[] {
  if (embedding.length !== 1_536 || embedding.some((value) => !Number.isFinite(value))) {
    throw new KnowledgeProcessingError('INVALID_EMBEDDING', 'Embedding dimension must be 1536')
  }
}

function assertEmbeddingMetadata(metadata: KnowledgeEmbeddingMetadata) {
  if (!metadata.provider || !metadata.model || metadata.dimensions !== 1_536) {
    throw new KnowledgeProcessingError(
      'EMBEDDING_CONFIGURATION_MISMATCH',
      'Knowledge base embedding configuration mismatch',
    )
  }
}

function embeddingMetadataMatches(
  left: KnowledgeEmbeddingMetadata,
  right: KnowledgeEmbeddingMetadata,
) {
  return (
    left.provider === right.provider &&
    left.model === right.model &&
    left.dimensions === right.dimensions
  )
}
