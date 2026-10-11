import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import type { Database } from './database'
import { assertAiManager, AiMemberError, getAiMemberConfig } from './ai-members'
import { assertInboxConversationAccess } from './inbox'
import {
  aiBudget,
  aiOperation,
  aiProviderAttempt,
  workspace,
  aiResponseRun,
  conversation,
  message,
  knowledgeChunk,
  knowledgeBase,
  aiFeedback,
  aiConfigVersion,
  type AiMemberRuntimeSnapshot,
} from './schema'

type Identity = { workspaceId: string; actingUserId: string }
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0]

export class AiUsageError extends Error {
  constructor(
    readonly code: 'QUOTA_EXHAUSTED' | 'OPERATION_PAUSED' | 'RETRY_LATER',
    readonly retryAfterMs = 0,
  ) {
    super(code)
  }
}

export function aiUsagePeriod(now = new Date()) {
  return now.toISOString().slice(0, 7)
}

async function budgetTotals(tx: Database | Transaction, workspaceId: string, period: string) {
  const [totals] = await tx
    .select({
      used: sql<number>`count(*) filter (where ${aiOperation.charged})::integer`,
      reserved: sql<number>`count(*) filter (where not ${aiOperation.charged} and ${aiOperation.state} = 'RESERVED')::integer`,
    })
    .from(aiOperation)
    .where(and(eq(aiOperation.workspaceId, workspaceId), eq(aiOperation.period, period)))
  return totals ?? { used: 0, reserved: 0 }
}

export async function getAiBudget(db: Database, input: Identity) {
  await assertAiManager(db, input.workspaceId, input.actingUserId)
  const period = aiUsagePeriod()
  const [budget] = await db
    .select()
    .from(aiBudget)
    .where(eq(aiBudget.workspaceId, input.workspaceId))
  return {
    monthlyLimit: budget?.monthlyLimit ?? null,
    period,
    unit: 'LOGICAL_OPERATION',
    timezone: 'UTC',
    ...(await budgetTotals(db, input.workspaceId, period)),
  }
}

export async function saveAiBudget(
  db: Database,
  input: Identity & { monthlyLimit: number | null },
) {
  if (
    input.monthlyLimit !== null &&
    (!Number.isInteger(input.monthlyLimit) ||
      input.monthlyLimit < 0 ||
      input.monthlyLimit > 2_000_000_000)
  ) {
    throw new AiMemberError('INVALID_REQUEST')
  }
  await db.transaction(async (tx) => {
    await assertAiManager(tx, input.workspaceId, input.actingUserId)
    await tx.execute(sql`select id from ${workspace} where id = ${input.workspaceId} for update`)
    const totals = await budgetTotals(tx, input.workspaceId, aiUsagePeriod())
    if (input.monthlyLimit !== null && input.monthlyLimit < totals.used + totals.reserved) {
      throw new AiMemberError('INVALID_REQUEST', 'Limit is below committed usage')
    }
    await tx
      .insert(aiBudget)
      .values({ workspaceId: input.workspaceId, monthlyLimit: input.monthlyLimit })
      .onConflictDoUpdate({
        target: aiBudget.workspaceId,
        set: { monthlyLimit: input.monthlyLimit },
      })
  })
  return getAiBudget(db, input)
}

export async function reserveAiOperation(
  db: Database,
  input: {
    id: string
    workspaceId: string
    kind: 'LIVE_REPLY' | 'TEST' | 'KNOWLEDGE_INDEX'
    memberId?: string
    configVersionId?: string | null
    now?: Date
    text?: string
    snapshot?: AiMemberRuntimeSnapshot
  },
) {
  const now = input.now ?? new Date()
  return db.transaction(async (tx) => {
    await tx.execute(sql`select id from ${workspace} where id = ${input.workspaceId} for update`)
    const [existing] = await tx.select().from(aiOperation).where(eq(aiOperation.id, input.id))
    if (existing) {
      if (
        existing.workspaceId !== input.workspaceId ||
        existing.kind !== input.kind ||
        existing.memberId !== (input.memberId ?? null) ||
        (input.text !== undefined && existing.input !== input.text)
      ) {
        throw new AiMemberError('INVALID_REQUEST')
      }
      return { ...existing, wasCreated: false }
    }
    // A late caller must reacquire an expired reservation rather than spending it.
    await tx
      .update(aiOperation)
      .set({ state: 'CANCELLED', updatedAt: now })
      .where(
        and(
          eq(aiOperation.workspaceId, input.workspaceId),
          eq(aiOperation.state, 'RESERVED'),
          sql`${aiOperation.updatedAt} < ${new Date(now.getTime() - 5 * 60_000)}`,
        ),
      )
    const period = aiUsagePeriod(now)
    const [budget] = await tx
      .select()
      .from(aiBudget)
      .where(eq(aiBudget.workspaceId, input.workspaceId))
    const totals = await budgetTotals(tx, input.workspaceId, period)
    if (
      budget?.monthlyLimit !== null &&
      budget?.monthlyLimit !== undefined &&
      totals.used + totals.reserved >= budget.monthlyLimit
    ) {
      throw new AiUsageError('QUOTA_EXHAUSTED')
    }
    const [operation] = await tx
      .insert(aiOperation)
      .values({
        id: input.id,
        workspaceId: input.workspaceId,
        kind: input.kind,
        memberId: input.memberId,
        configVersionId: input.configVersionId,
        period,
        input: input.text,
        snapshot: input.snapshot,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
    if (!operation) throw new Error('Reservation was not created')
    return { ...operation, wasCreated: true }
  })
}

export async function beginAiProviderAttempt(
  db: Database,
  input: { operationId: string; stage: string; now?: Date },
) {
  const now = input.now ?? new Date()
  return db.transaction(async (tx) => {
    const [operation] = await tx
      .select()
      .from(aiOperation)
      .where(eq(aiOperation.id, input.operationId))
      .for('update')
    if (!operation || !['RESERVED', 'STARTED'].includes(operation.state))
      throw new AiUsageError('OPERATION_PAUSED')
    if (!operation.charged && operation.period !== aiUsagePeriod(now))
      throw new AiUsageError('OPERATION_PAUSED')
    const attempts = await tx
      .select()
      .from(aiProviderAttempt)
      .where(
        and(
          eq(aiProviderAttempt.operationId, input.operationId),
          eq(aiProviderAttempt.stage, input.stage),
        ),
      )
      .orderBy(desc(aiProviderAttempt.createdAt))
    const last = attempts[0]
    if (last && (last.state !== 'FAILED' || attempts.length >= 3))
      throw new AiUsageError('OPERATION_PAUSED')
    if (last?.retryAt && last.retryAt > now)
      throw new AiUsageError('RETRY_LATER', last.retryAt.getTime() - now.getTime())
    await tx
      .update(aiOperation)
      .set({ charged: true, state: 'STARTED', updatedAt: now })
      .where(eq(aiOperation.id, input.operationId))
    const [attempt] = await tx
      .insert(aiProviderAttempt)
      .values({ operationId: input.operationId, stage: input.stage, createdAt: now })
      .returning()
    if (!attempt) throw new Error('Attempt was not created')
    return attempt
  })
}

export async function finishAiProviderAttempt(
  db: Database,
  input: {
    attemptId: string
    state: 'SUCCESS' | 'FAILED' | 'UNKNOWN'
    httpStatus?: number
    response?: unknown
    retryAfterMs?: number
    now?: Date
  },
) {
  const now = input.now ?? new Date()
  const [attempt] = await db
    .select()
    .from(aiProviderAttempt)
    .where(eq(aiProviderAttempt.id, input.attemptId))
  if (!attempt) return
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::integer` })
    .from(aiProviderAttempt)
    .where(
      and(
        eq(aiProviderAttempt.operationId, attempt.operationId),
        eq(aiProviderAttempt.stage, attempt.stage),
      ),
    )
  await db
    .update(aiProviderAttempt)
    .set({
      state: input.state,
      httpStatus: input.httpStatus,
      response: input.response,
      completedAt: now,
      retryAt:
        input.state === 'FAILED'
          ? new Date(
              now.getTime() + Math.max(count >= 2 ? 120_000 : 30_000, input.retryAfterMs ?? 0),
            )
          : null,
    })
    .where(and(eq(aiProviderAttempt.id, input.attemptId), eq(aiProviderAttempt.state, 'STARTED')))
  if (input.state === 'UNKNOWN')
    await finishAiOperation(db, { operationId: attempt.operationId, state: 'UNKNOWN' })
}

export async function finishAiOperation(
  db: Database,
  input: {
    operationId: string
    state: 'COMPLETED' | 'FAILED' | 'UNKNOWN' | 'CANCELLED'
    failureCode?: string
  },
) {
  await db
    .update(aiOperation)
    .set({ state: input.state, failureCode: input.failureCode, updatedAt: new Date() })
    .where(
      and(
        eq(aiOperation.id, input.operationId),
        sql`${aiOperation.state} in ('RESERVED', 'STARTED')`,
      ),
    )
}

export async function getAiProviderResponse(db: Database, operationId: string, stage: string) {
  const [attempt] = await db
    .select({ response: aiProviderAttempt.response })
    .from(aiProviderAttempt)
    .where(
      and(
        eq(aiProviderAttempt.operationId, operationId),
        eq(aiProviderAttempt.stage, stage),
        eq(aiProviderAttempt.state, 'SUCCESS'),
      ),
    )
    .limit(1)
  return attempt ?? null
}

export async function recoverAiOperations(db: Database, now = new Date()) {
  await db.transaction(async (tx) => {
    await tx
      .update(aiOperation)
      .set({ state: 'CANCELLED', updatedAt: now })
      .where(
        and(
          eq(aiOperation.state, 'RESERVED'),
          sql`${aiOperation.updatedAt} < ${new Date(now.getTime() - 5 * 60_000)}`,
        ),
      )
    const expired = await tx
      .update(aiOperation)
      .set({ state: 'UNKNOWN', failureCode: 'OPERATION_PAUSED', updatedAt: now })
      .where(
        and(
          eq(aiOperation.state, 'STARTED'),
          sql`${aiOperation.updatedAt} < ${new Date(now.getTime() - 5 * 60_000)}`,
        ),
      )
      .returning({ id: aiOperation.id })
    if (expired.length)
      await tx
        .update(aiProviderAttempt)
        .set({ state: 'UNKNOWN', completedAt: now })
        .where(
          and(
            inArray(
              aiProviderAttempt.operationId,
              expired.map(({ id }) => id),
            ),
            eq(aiProviderAttempt.state, 'STARTED'),
          ),
        )
  })
}

export async function createAiTest(
  db: Database,
  input: Identity & {
    id: string
    memberId: string
    source: 'DRAFT' | 'PUBLISHED' | 'VERSION'
    versionId?: string
    text: string
  },
) {
  const config = await getAiMemberConfig(db, input)
  let snapshot: AiMemberRuntimeSnapshot | null = null
  let versionId: string | null = null
  if (input.source === 'DRAFT' && config.knowledgeBaseId)
    snapshot = {
      instructions: config.instructions,
      responseLanguage: config.responseLanguage,
      knowledgeBaseId: config.knowledgeBaseId,
      handoffOnCustomerRequest: config.handoffOnCustomerRequest,
      handoffOnNoKnowledge: config.handoffOnNoKnowledge,
      handoffOnNegativeSentiment: config.handoffOnNegativeSentiment,
      handoffOnUnableToAnswer: config.handoffOnUnableToAnswer,
      handoffKeywords: config.handoffKeywords,
      adLearningEnabled: config.adLearningEnabled,
      adMappings: config.adMappings,
    }
  if (input.source === 'PUBLISHED') {
    snapshot = config.publishedSnapshot
    versionId = config.publishedVersionId
  }
  if (input.source === 'VERSION') {
    const [version] = await db
      .select()
      .from(aiConfigVersion)
      .where(
        and(
          eq(aiConfigVersion.id, input.versionId ?? input.id),
          eq(aiConfigVersion.memberId, input.memberId),
        ),
      )
      .limit(1)
    snapshot = version?.snapshot ?? null
    versionId = version?.id ?? null
  }
  if (!snapshot?.instructions.trim() || !snapshot.responseLanguage.trim())
    throw new AiMemberError('INVALID_CONFIGURATION')
  const [base] = await db
    .select({ id: knowledgeBase.id })
    .from(knowledgeBase)
    .where(
      and(
        eq(knowledgeBase.id, snapshot.knowledgeBaseId),
        eq(knowledgeBase.workspaceId, input.workspaceId),
      ),
    )
    .limit(1)
  if (!base) throw new AiMemberError('INVALID_CONFIGURATION')
  if (!input.text.trim() || Array.from(input.text).length > 8_000)
    throw new AiMemberError('INVALID_REQUEST')
  const operation = await reserveAiOperation(db, {
    id: input.id,
    workspaceId: input.workspaceId,
    kind: 'TEST',
    memberId: input.memberId,
    configVersionId: versionId,
    text: input.text.trim(),
    snapshot,
  })
  return { operation, created: operation.wasCreated }
}

export async function recordAiTestResult(
  db: Database,
  input: { id: string; output: unknown; chunkIds: string[] },
) {
  await db
    .update(aiOperation)
    .set({
      output: input.output,
      chunkIds: input.chunkIds,
      state: 'COMPLETED',
      updatedAt: new Date(),
    })
    .where(and(eq(aiOperation.id, input.id), sql`${aiOperation.state} in ('RESERVED', 'STARTED')`))
}

export async function getAiDiagnostics(db: Database, input: Identity & { id: string }) {
  await assertAiManager(db, input.workspaceId, input.actingUserId)
  const [run] = await db
    .select({ run: aiResponseRun })
    .from(aiResponseRun)
    .innerJoin(conversation, eq(conversation.id, aiResponseRun.conversationId))
    .where(and(eq(aiResponseRun.id, input.id), eq(conversation.workspaceId, input.workspaceId)))
    .limit(1)
  const [operation] = await db
    .select()
    .from(aiOperation)
    .where(and(eq(aiOperation.id, input.id), eq(aiOperation.workspaceId, input.workspaceId)))
  if (!run && operation?.kind !== 'TEST') throw new AiMemberError('NOT_FOUND')
  if (run)
    await assertInboxConversationAccess(db, {
      workspaceId: input.workspaceId,
      userId: input.actingUserId,
      conversationId: run.run.conversationId,
    })
  const chunkIds = run?.run.retrievedChunkIds ?? operation?.chunkIds ?? []
  const chunks = chunkIds.length
    ? await db
        .select({
          id: knowledgeChunk.id,
          text: knowledgeChunk.text,
          documentId: knowledgeChunk.knowledgeDocumentId,
        })
        .from(knowledgeChunk)
        .where(
          and(
            eq(knowledgeChunk.workspaceId, input.workspaceId),
            inArray(knowledgeChunk.id, chunkIds),
          ),
        )
    : []
  const inputs = run
    ? await db
        .select({ id: message.id, text: message.text, createdAt: message.createdAt })
        .from(message)
        .where(
          and(
            eq(message.conversationId, run.run.conversationId),
            sql`
      (${message.createdAt}, ${message.id}) >= (select created_at, id from message where id = ${run.run.inputFirstMessageId})
      and (${message.createdAt}, ${message.id}) <= (select created_at, id from message where id = ${run.run.inputLastMessageId})
      and ${message.direction} = 'INBOUND'`,
          ),
        )
        .orderBy(asc(message.createdAt), asc(message.id))
    : []
  const [output] = run?.run.outputMessageId
    ? await db
        .select({ id: message.id, text: message.text, deliveryState: message.deliveryState })
        .from(message)
        .where(
          and(
            eq(message.id, run.run.outputMessageId),
            eq(message.conversationId, run.run.conversationId),
          ),
        )
    : []
  const attempts = await db
    .select({
      id: aiProviderAttempt.id,
      stage: aiProviderAttempt.stage,
      state: aiProviderAttempt.state,
      httpStatus: aiProviderAttempt.httpStatus,
      createdAt: aiProviderAttempt.createdAt,
    })
    .from(aiProviderAttempt)
    .where(eq(aiProviderAttempt.operationId, input.id))
    .orderBy(asc(aiProviderAttempt.createdAt))
  const history = run?.run.contextMessageIds?.length
    ? await db
        .select({ id: message.id, text: message.text, direction: message.direction })
        .from(message)
        .where(
          and(
            eq(message.conversationId, run.run.conversationId),
            inArray(message.id, run.run.contextMessageIds),
          ),
        )
    : []
  const feedback = await db
    .select({
      id: aiFeedback.id,
      category: aiFeedback.category,
      note: aiFeedback.note,
      createdAt: aiFeedback.createdAt,
    })
    .from(aiFeedback)
    .where(
      and(
        eq(aiFeedback.workspaceId, input.workspaceId),
        run ? eq(aiFeedback.runId, input.id) : eq(aiFeedback.operationId, input.id),
      ),
    )
  return {
    run: run?.run ?? null,
    operation: operation
      ? {
          id: operation.id,
          kind: operation.kind,
          state: operation.state,
          charged: operation.charged,
          failureCode: operation.failureCode,
          input: operation.input,
          output: operation.output,
          snapshot: operation.snapshot,
          configVersionId: operation.configVersionId,
        }
      : null,
    inputs,
    history: run?.run.contextMessageIds?.flatMap((id) => history.filter((m) => m.id === id)) ?? [],
    output: output ?? null,
    chunks,
    missingChunkIds: chunkIds.filter((id) => !chunks.some((c) => c.id === id)),
    attempts,
    feedback,
  }
}

export async function addAiFeedback(
  db: Database,
  input: Identity & { id: string; category: string; note: string },
) {
  if (!['KNOWLEDGE', 'MODEL', 'OTHER'].includes(input.category) || input.note.length > 2_000)
    throw new AiMemberError('INVALID_REQUEST')
  const diagnostics = await getAiDiagnostics(db, input)
  await db.insert(aiFeedback).values({
    workspaceId: input.workspaceId,
    userId: input.actingUserId,
    runId: diagnostics.run ? input.id : null,
    operationId: diagnostics.run ? null : input.id,
    category: input.category,
    note: input.note.trim(),
  })
  return getAiDiagnostics(db, input)
}

export async function aiOperationForMessage(db: Database, input: Identity & { messageId: string }) {
  await assertAiManager(db, input.workspaceId, input.actingUserId)
  const [run] = await db
    .select({ id: aiResponseRun.id })
    .from(aiResponseRun)
    .innerJoin(conversation, eq(conversation.id, aiResponseRun.conversationId))
    .where(
      and(
        eq(conversation.workspaceId, input.workspaceId),
        eq(aiResponseRun.outputMessageId, input.messageId),
      ),
    )
    .limit(1)
  if (!run) throw new AiMemberError('NOT_FOUND')
  return getAiDiagnostics(db, { ...input, id: run.id })
}

export async function getAiAnalytics(
  db: Database,
  input: Identity & {
    from: Date
    to: Date
    timezone: string
    memberId?: string
    versionId?: string
  },
) {
  await assertAiManager(db, input.workspaceId, input.actingUserId)
  if (
    !Number.isFinite(input.from.getTime()) ||
    !Number.isFinite(input.to.getTime()) ||
    input.from >= input.to ||
    input.to.getTime() - input.from.getTime() > 366 * 86_400_000
  )
    throw new AiMemberError('INVALID_REQUEST')
  try {
    new Intl.DateTimeFormat('en', { timeZone: input.timezone }).format()
  } catch {
    throw new AiMemberError('INVALID_REQUEST')
  }
  const versions = input.versionId ? sql`and r.config_version_id = ${input.versionId}::uuid` : sql``
  const members = input.memberId ? sql`and r.member_id = ${input.memberId}::uuid` : sql``
  const runs = await db.execute(sql`
    select to_char(r.created_at at time zone ${input.timezone}, 'YYYY-MM-DD') as day, r.state, count(*)::integer as count
    from ai_response_run r join conversation c on c.id = r.conversation_id
    where c.workspace_id = ${input.workspaceId} and r.created_at >= ${input.from} and r.created_at < ${input.to}
    ${members} ${versions} group by day, r.state order by day, r.state`)
  const usage = await db.execute(sql`
    select o.kind, o.state, count(*)::integer as operations,
      count(*) filter (where o.charged)::integer as charged,
      (select count(*)::integer from ai_provider_attempt a where a.operation_id in (
        select x.id from ai_operation x where x.workspace_id = ${input.workspaceId} and x.kind = o.kind and x.state = o.state
        and x.created_at >= ${input.from} and x.created_at < ${input.to}
        ${input.memberId ? sql`and x.member_id = ${input.memberId}::uuid` : sql``}
        ${input.versionId ? sql`and x.config_version_id = ${input.versionId}::uuid` : sql``}
      )) as provider_attempts
    from ai_operation o where o.workspace_id = ${input.workspaceId}
      and o.created_at >= ${input.from} and o.created_at < ${input.to}
      ${input.memberId ? sql`and o.member_id = ${input.memberId}::uuid` : sql``}
      ${input.versionId ? sql`and o.config_version_id = ${input.versionId}::uuid` : sql``}
    group by o.kind, o.state order by o.kind, o.state`)
  const replies = await db.execute(sql`
    select m.type as sender, count(*)::integer as replies,
      count(*) filter (where msg.delivery_state = 'SENT')::integer as sent,
      count(*) filter (where msg.delivery_state = 'FAILED')::integer as failed
    from message msg join conversation c on c.id = msg.conversation_id join member m on m.id = msg.sender_member_id
    where c.workspace_id = ${input.workspaceId} and msg.direction = 'OUTBOUND'
      and msg.created_at >= ${input.from} and msg.created_at < ${input.to}
      ${input.memberId ? sql`and m.id = ${input.memberId}::uuid` : sql``}
      ${input.versionId ? sql`and exists (select 1 from ai_response_run r where r.output_message_id = msg.id and r.config_version_id = ${input.versionId}::uuid)` : sql``}
    group by m.type order by m.type`)
  return {
    from: input.from,
    to: input.to,
    timezone: input.timezone,
    calculatedAt: new Date(),
    runs: runs.rows,
    usage: usage.rows,
    replies: replies.rows,
    providerCost: null,
  }
}

export async function listAiDiagnostics(
  db: Database,
  input: Identity & { memberId: string; cursor?: { createdAt: string; id: string } },
) {
  await getAiMemberConfig(db, input)
  const result = await db.execute<{
    id: string
    kind: string
    state: string
    createdAt: string
    configVersionId: string | null
    failureCode: string | null
    cancellationReason: string | null
    conversationId: string | null
  }>(sql`
    select id, kind, state, to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "createdAt",
      config_version_id as "configVersionId", failure_code as "failureCode",
      cancellation_reason as "cancellationReason", conversation_id as "conversationId"
    from (
      select r.id, 'LIVE_REPLY' as kind, r.state::text, r.created_at, r.config_version_id,
        r.failure_code, r.cancellation_reason::text, r.conversation_id
      from ai_response_run r join conversation c on c.id = r.conversation_id
      where c.workspace_id = ${input.workspaceId} and r.member_id = ${input.memberId}
      union all
      select o.id, o.kind, o.state, o.created_at, o.config_version_id, o.failure_code, null, null::uuid
      from ai_operation o where o.workspace_id = ${input.workspaceId} and o.member_id = ${input.memberId} and o.kind = 'TEST'
    ) records
    ${input.cursor ? sql`where (created_at, id) < (${input.cursor.createdAt}::timestamptz, ${input.cursor.id}::uuid)` : sql``}
    order by created_at desc, id desc limit 101
  `)
  const page = result.rows.slice(0, 100)
  const last = page.at(-1)
  return {
    runs: page.filter((r) => r.kind === 'LIVE_REPLY'),
    tests: page.filter((r) => r.kind === 'TEST'),
    nextCursor:
      result.rows.length > 100 && last ? { createdAt: last.createdAt, id: last.id } : null,
  }
}
