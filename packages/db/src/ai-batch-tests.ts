import { and, asc, desc, eq, sql } from 'drizzle-orm'
import { assertAiHandoffReferences, readEnabledAiHandoffRules } from './ai-handoff-rules'
import { AiMemberError, getAiMemberConfig } from './ai-members'
import {
  AiUsageError,
  createAiTest,
  recordAiTestResult,
  resolveTestConfiguration,
} from './ai-operations'
import { readAiTestPropertyRules } from './ai-property-rules'
import { readAiTestTagRules } from './ai-tag-rules'
import type { Database } from './database'
import {
  aiOperation,
  aiProviderAttempt,
  aiQuestionSet,
  aiTestBatch,
  aiTestBatchItem,
  workspace,
} from './schema'

type Identity = { workspaceId: string; memberId: string; actingUserId: string }
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0]

export async function listAiQuestionSets(db: Database, input: Identity) {
  await getAiMemberConfig(db, input)
  return db
    .select()
    .from(aiQuestionSet)
    .where(
      and(
        eq(aiQuestionSet.workspaceId, input.workspaceId),
        eq(aiQuestionSet.memberId, input.memberId),
      ),
    )
    .orderBy(asc(aiQuestionSet.name), asc(aiQuestionSet.id))
}

export async function saveAiQuestionSet(
  db: Database,
  input: Identity & {
    id: string
    name: string
    questions: string[]
    revision?: number
  },
) {
  if (
    !input.name.trim() ||
    input.name.length > 100 ||
    input.questions.length < 1 ||
    input.questions.length > 100 ||
    input.questions.some((q) => !q.trim() || q.length > 8000)
  )
    throw new AiMemberError('INVALID_REQUEST')
  return db.transaction(async (tx) => {
    await tx.execute(sql`select id from ${workspace} where id = ${input.workspaceId} for update`)
    await getAiMemberConfig(tx, input)
    const [existing] = await tx.select().from(aiQuestionSet).where(eq(aiQuestionSet.id, input.id))
    if (
      existing &&
      (existing.workspaceId !== input.workspaceId || existing.memberId !== input.memberId)
    )
      throw new AiMemberError('NOT_FOUND')
    const values = { name: input.name.trim(), questions: input.questions.map((q) => q.trim()) }
    if (existing) {
      if (existing.revision !== input.revision) throw new AiMemberError('INVALID_REQUEST')
      const [result] = await tx
        .update(aiQuestionSet)
        .set({ ...values, revision: existing.revision + 1 })
        .where(eq(aiQuestionSet.id, input.id))
        .returning()
      return result
    }
    if (input.revision !== undefined) throw new AiMemberError('NOT_FOUND')
    const [result] = await tx
      .insert(aiQuestionSet)
      .values({ ...values, id: input.id, workspaceId: input.workspaceId, memberId: input.memberId })
      .returning()
    return result
  })
}

export async function deleteAiQuestionSet(
  db: Database,
  input: Identity & { id: string; revision: number },
) {
  await db.transaction(async (tx) => {
    await tx.execute(sql`select id from ${workspace} where id = ${input.workspaceId} for update`)
    await getAiMemberConfig(tx, input)
    const removed = await tx
      .delete(aiQuestionSet)
      .where(
        and(
          eq(aiQuestionSet.id, input.id),
          eq(aiQuestionSet.workspaceId, input.workspaceId),
          eq(aiQuestionSet.memberId, input.memberId),
          eq(aiQuestionSet.revision, input.revision),
        ),
      )
      .returning()
    if (!removed.length) throw new AiMemberError('NOT_FOUND')
  })
}

export async function createAiTestBatch(
  db: Database,
  input: Identity & {
    id: string
    questionSetId: string
    source: 'DRAFT' | 'PUBLISHED' | 'VERSION'
    versionId?: string
  },
) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select id from ${workspace} where id = ${input.workspaceId} for update`)
    await getAiMemberConfig(tx, input)
    const [existing] = await tx.select().from(aiTestBatch).where(eq(aiTestBatch.id, input.id))
    if (existing) {
      if (
        existing.workspaceId !== input.workspaceId ||
        existing.memberId !== input.memberId ||
        existing.questionSetId !== input.questionSetId ||
        existing.source !== input.source ||
        (input.source === 'VERSION' && existing.configVersionId !== input.versionId)
      )
        throw new AiMemberError('INVALID_REQUEST')
      return existing
    }
    const [set] = await tx
      .select()
      .from(aiQuestionSet)
      .where(
        and(
          eq(aiQuestionSet.id, input.questionSetId),
          eq(aiQuestionSet.workspaceId, input.workspaceId),
          eq(aiQuestionSet.memberId, input.memberId),
        ),
      )
    if (!set) throw new AiMemberError('NOT_FOUND')
    const config = await resolveTestConfiguration(tx, input)
    const [batch] = await tx
      .insert(aiTestBatch)
      .values({
        id: input.id,
        workspaceId: input.workspaceId,
        memberId: input.memberId,
        questionSetId: set.id,
        name: set.name,
        source: input.source,
        snapshot: config.snapshot,
        configVersionId: config.versionId,
      })
      .returning()
    await tx.insert(aiTestBatchItem).values(
      set.questions.map((text, position) => ({
        id: crypto.randomUUID(),
        batchId: input.id,
        position,
        text,
      })),
    )
    return batch
  })
}

export async function listAiTestBatches(db: Database, input: Identity) {
  await getAiMemberConfig(db, input)
  return db
    .select()
    .from(aiTestBatch)
    .where(
      and(eq(aiTestBatch.workspaceId, input.workspaceId), eq(aiTestBatch.memberId, input.memberId)),
    )
    .orderBy(desc(aiTestBatch.createdAt), desc(aiTestBatch.id))
    .limit(50)
}

export async function lockAiTestBatch(tx: Transaction, input: Identity & { id: string }) {
  await tx.execute(sql`select id from ${workspace} where id = ${input.workspaceId} for share`)
  await getAiMemberConfig(tx, input)
  const [batch] = await tx
    .select()
    .from(aiTestBatch)
    .where(
      and(
        eq(aiTestBatch.id, input.id),
        eq(aiTestBatch.workspaceId, input.workspaceId),
        eq(aiTestBatch.memberId, input.memberId),
      ),
    )
    .for('update')
  if (!batch) throw new AiMemberError('NOT_FOUND')
  return batch
}

export async function readAiTestBatch(db: Database, input: Identity & { id: string }) {
  return db.transaction(async (tx) => {
    const batch = await lockAiTestBatch(tx, input)
    const items = await tx
      .select({
        id: aiTestBatchItem.id,
        position: aiTestBatchItem.position,
        text: aiTestBatchItem.text,
        state: aiTestBatchItem.state,
        attempt: aiTestBatchItem.attempt,
        failureCode: aiTestBatchItem.failureCode,
        retryAt: aiTestBatchItem.retryAt,
        charged: sql<boolean>`coalesce(${aiOperation.charged}, false)`,
        output: aiOperation.output,
        chunkIds: aiOperation.chunkIds,
        operationState: aiOperation.state,
      })
      .from(aiTestBatchItem)
      .leftJoin(aiOperation, eq(aiOperation.id, aiTestBatchItem.id))
      .where(eq(aiTestBatchItem.batchId, batch.id))
      .orderBy(asc(aiTestBatchItem.position))
    return { batch, items }
  })
}

export async function cancelAiTestBatch(db: Database, input: Identity & { id: string }) {
  await db.transaction(async (tx) => {
    const batch = await lockAiTestBatch(tx, input)
    await tx
      .update(aiTestBatch)
      .set({ cancelledAt: batch.cancelledAt ?? new Date() })
      .where(eq(aiTestBatch.id, batch.id))
    await tx
      .update(aiTestBatchItem)
      .set({ state: 'CANCELLED' })
      .where(and(eq(aiTestBatchItem.batchId, batch.id), eq(aiTestBatchItem.state, 'QUEUED')))
  })
}

export async function claimAiTestBatchItem(
  db: Database,
  input: Identity & { id: string; itemId: string; attempt: number },
) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select id from ${workspace} where id = ${input.workspaceId} for update`)
    const batch = await lockAiTestBatch(tx, input)
    const config = await getAiMemberConfig(tx, input)
    if (config.memberStatus !== 'ACTIVE') throw new AiMemberError('INVALID_CONFIGURATION')
    const items = await tx
      .select()
      .from(aiTestBatchItem)
      .where(eq(aiTestBatchItem.batchId, batch.id))
    const item = items.find((i) => i.id === input.itemId)
    if (!item) throw new AiMemberError('NOT_FOUND')
    if (['COMPLETED', 'CANCELLED'].includes(item.state)) return null
    if (
      items.some((i) => i.state === 'UNKNOWN') ||
      items.some((i) => i.state === 'RUNNING' && i.id !== item.id)
    )
      throw new AiUsageError('OPERATION_PAUSED')
    if (item.attempt !== input.attempt) throw new AiUsageError('OPERATION_PAUSED')
    const recovering = item.state === 'RUNNING'
    if (recovering && item.claimedAt && item.claimedAt.getTime() > Date.now() - 60_000)
      throw new AiUsageError('RETRY_LATER', 60_000)
    if (batch.cancelledAt && !recovering && item.state !== 'FAILED') return null
    if (!recovering && item.attempt >= 3) throw new AiUsageError('OPERATION_PAUSED')
    if (item.retryAt && item.retryAt.getTime() > Date.now())
      throw new AiUsageError('RETRY_LATER', item.retryAt.getTime() - Date.now())
    const [previous] = await tx.select().from(aiOperation).where(eq(aiOperation.id, item.id))
    if (previous && ['UNKNOWN', 'CANCELLED'].includes(previous.state)) {
      await tx
        .update(aiTestBatchItem)
        .set({ state: 'UNKNOWN', failureCode: 'OPERATION_PAUSED' })
        .where(eq(aiTestBatchItem.id, item.id))
      return null
    }
    if (previous?.state === 'FAILED')
      await tx
        .update(aiOperation)
        .set({ state: previous.charged ? 'STARTED' : 'RESERVED', failureCode: null })
        .where(eq(aiOperation.id, item.id))
    const test = await createAiTest(tx, {
      ...input,
      id: item.id,
      source: batch.source as 'DRAFT' | 'PUBLISHED' | 'VERSION',
      text: item.text,
      frozenConfiguration: { snapshot: batch.snapshot, versionId: batch.configVersionId },
    })
    if (previous?.state === 'FAILED') {
      const output = {
        propertyRules: await readAiTestPropertyRules(tx, input.workspaceId, input.memberId),
        tagRules: batch.snapshot.tagsEnabled
          ? await readAiTestTagRules(tx, input.workspaceId, input.memberId)
          : [],
        handoffContext: {
          rules: await readEnabledAiHandoffRules(tx, input.workspaceId, input.memberId),
          facts: { properties: [], tags: [] },
        },
      }
      await tx.update(aiOperation).set({ output }).where(eq(aiOperation.id, item.id))
      test.operation.output = output
    }
    const attempt = recovering ? item.attempt : item.attempt + 1
    await tx
      .update(aiTestBatchItem)
      .set({ state: 'RUNNING', attempt, claimedAt: new Date(), retryAt: null, failureCode: null })
      .where(eq(aiTestBatchItem.id, item.id))
    return { operation: test.operation, attempt }
  })
}

export async function recordAiBatchResult(
  db: Database,
  input: Identity & { id: string; itemId: string; attempt: number },
  result: Parameters<typeof recordAiTestResult>[1],
) {
  await db.transaction(async (tx) => {
    await lockAiTestBatch(tx, input)
    const config = await getAiMemberConfig(tx, input)
    if (config.memberStatus !== 'ACTIVE') throw new AiMemberError('INVALID_CONFIGURATION')
    const [item] = await tx
      .select()
      .from(aiTestBatchItem)
      .where(and(eq(aiTestBatchItem.id, input.itemId), eq(aiTestBatchItem.batchId, input.id)))
    if (item?.state !== 'RUNNING' || item.attempt !== input.attempt) return
    const [operation] = await tx.select().from(aiOperation).where(eq(aiOperation.id, item.id))
    const original = (
      operation?.output as { handoffContext?: { rules: { id: string; revision: number }[] } } | null
    )?.handoffContext
    const current = await readEnabledAiHandoffRules(tx, input.workspaceId, input.memberId)
    if (
      !original ||
      original.rules.length !== current.length ||
      original.rules.some((r) => !current.some((c) => c.id === r.id && c.revision === r.revision))
    )
      throw new AiMemberError('INVALID_CONFIGURATION')
    await assertAiHandoffReferences(tx, input.workspaceId, current)
    await recordAiTestResult(tx, result)
    await tx
      .update(aiTestBatchItem)
      .set({ state: 'COMPLETED' })
      .where(eq(aiTestBatchItem.id, item.id))
  })
}

export async function failAiBatchItem(
  db: Database,
  input: { id: string; itemId: string; attempt: number; code: string },
) {
  await db.transaction(async (tx) => {
    await tx.select().from(aiTestBatch).where(eq(aiTestBatch.id, input.id)).for('update')
    const [operation] = await tx.select().from(aiOperation).where(eq(aiOperation.id, input.itemId))
    const unknown = operation?.state === 'UNKNOWN' || input.code === 'OPERATION_PAUSED'
    const [provider] = await tx
      .select({ retryAt: aiProviderAttempt.retryAt })
      .from(aiProviderAttempt)
      .where(
        and(eq(aiProviderAttempt.operationId, input.itemId), eq(aiProviderAttempt.state, 'FAILED')),
      )
      .orderBy(desc(aiProviderAttempt.retryAt))
      .limit(1)
    await tx
      .update(aiTestBatchItem)
      .set({
        state: unknown ? 'UNKNOWN' : 'FAILED',
        failureCode: input.code,
        retryAt:
          unknown || input.code === 'QUOTA_EXHAUSTED'
            ? null
            : new Date(
                Math.max(
                  provider?.retryAt?.getTime() ?? 0,
                  Date.now() + (input.attempt >= 2 ? 120_000 : 30_000),
                ),
              ),
      })
      .where(
        and(
          eq(aiTestBatchItem.id, input.itemId),
          eq(aiTestBatchItem.batchId, input.id),
          eq(aiTestBatchItem.attempt, input.attempt),
          sql`${aiTestBatchItem.state} in ('QUEUED', 'RUNNING')`,
        ),
      )
  })
}
