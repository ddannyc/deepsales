import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import { assertAiHandoffReferences, readEnabledAiHandoffRules } from './ai-handoff-rules'
import {
  AiMemberError,
  assertAiManager,
  getAiMemberConfig,
  readAiViewerChannelIds,
} from './ai-members'
import {
  type AiCollectedProperty,
  readAiTestPropertyRules,
  sameAiPropertyRules,
  validateAiCollectedProperties,
} from './ai-property-rules'
import { type AiConversationContextMessage, normalizeAiReplyLanguage } from './ai-responses'
import {
  aiSelectedSkillInstructions,
  aiSkillVariableInstructions,
  selectedAiSkillId,
} from './ai-skills'
import { assertAiStopReferences, EMPTY_AI_STOP_RULES } from './ai-stop'
import { readAiTestTagRules } from './ai-tag-rules'
import { readAiToolSearchChunks } from './ai-tool-actions'
import { checkExternalTestResults } from './ai-external-actions'
import { type AiToolCall, validateAiToolCalls } from './ai-tools'
import { readAiTestVariableInput } from './ai-variable-values'
import type { AiVariableInput } from './ai-variables'
import type { Database } from './database'
import { assertInboxConversationAccess } from './inbox'
import {
  type AiMemberRuntimeSnapshot,
  type AiPropertyCollection,
  type AiTestCustomer,
  aiBudget,
  aiConfigVersion,
  aiFeedback,
  aiOperation,
  aiProviderAttempt,
  aiResponseRun,
  aiTestSession,
  aiToolAction,
  channelIdentity,
  conversation,
  knowledgeBase,
  knowledgeChunk,
  knowledgeDocument,
  mediaAsset,
  message,
  workspace,
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
  db: Database | Transaction,
  input: {
    id: string
    workspaceId: string
    kind:
      | 'FOLLOW_UP'
      | 'LIVE_REPLY'
      | 'TEST'
      | 'KNOWLEDGE_INDEX'
      | 'TRANSLATION'
      | 'SUGGESTION'
      | 'PERSONA'
      | 'CUSTOMER_MEMORY'
    memberId?: string
    configVersionId?: string | null
    now?: Date
    text?: string
    snapshot?: AiMemberRuntimeSnapshot
    testContext?: AiTestContext
    tagRules?: import('./schema').AiTagCollection['rules']
    variableInput?: AiVariableInput
    propertyRules?: AiPropertyCollection['rules']
    handoffContext?: {
      rules: Awaited<ReturnType<typeof readEnabledAiHandoffRules>>
      facts: { properties: { definitionId: string; value: string | number }[]; tags: string[] }
    }
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
      if (input.handoffContext) {
        const output = existing.output as { handoffContext?: { facts: unknown } } | null
        const stored = output?.handoffContext?.facts as
          | typeof input.handoffContext.facts
          | undefined
        const normalize = (facts: typeof input.handoffContext.facts) =>
          JSON.stringify({
            properties: facts.properties
              .map((p) => [p.definitionId, p.value])
              .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
            tags: [...facts.tags].sort(),
          })
        // Legacy tests had no mock facts; retries must retain that empty context.
        if (
          normalize(stored ?? { properties: [], tags: [] }) !==
          normalize(input.handoffContext.facts)
        )
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
        output: input.handoffContext
          ? {
              handoffContext: input.handoffContext,
              testContext: input.testContext,
              propertyRules: input.propertyRules,
              variableInput: input.variableInput,
              tagRules: input.tagRules,
            }
          : undefined,
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

type TestConfiguration = Identity & {
  memberId: string
  source: 'DRAFT' | 'PUBLISHED' | 'VERSION'
  versionId?: string
}

export type AiTestContext = {
  sessionId: string
  generation: number
  customer: AiTestCustomer
  history: AiConversationContextMessage[]
}

const EMPTY_TEST_CUSTOMER: AiTestCustomer = {
  properties: [],
  tags: [],
  source: '',
  language: '',
  memory: '',
}

const customerKey = (value: AiTestCustomer) =>
  JSON.stringify([
    value.source,
    value.language,
    value.memory,
    value.properties
      .map((p) => [p.definitionId, p.value])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    [...value.tags].sort(),
  ])

export async function resolveTestConfiguration(
  db: Database | Transaction,
  input: TestConfiguration,
) {
  const config = await getAiMemberConfig(db, input)
  let snapshot: AiMemberRuntimeSnapshot | null = null
  let versionId: string | null = null
  if (input.source === 'DRAFT' && config.knowledgeBaseId)
    snapshot = {
      stopRules: config.stopRules,
      unparsedFallbackEnabled: config.unparsedFallbackEnabled,
      unparsedFallbackTexts: config.unparsedFallbackTexts,
      splitRepliesEnabled: config.splitRepliesEnabled,
      automaticLanguageEnabled: config.automaticLanguageEnabled,
      timeZone: config.timeZone,
      instructions: config.instructions,
      skills: config.skills,
      responseLanguage: config.responseLanguage,
      knowledgeBaseId: config.knowledgeBaseId,
      handoffOnCustomerRequest: config.handoffOnCustomerRequest,
      handoffOnNoKnowledge: config.handoffOnNoKnowledge,
      handoffOnNegativeSentiment: config.handoffOnNegativeSentiment,
      handoffOnUnableToAnswer: config.handoffOnUnableToAnswer,
      handoffKeywords: config.handoffKeywords,
      adLearningEnabled: config.adLearningEnabled,
      adMappings: config.adMappings,
      naturalToneEnabled: config.naturalToneEnabled,
      memoryEnabled: config.memoryEnabled,
      tagsEnabled: config.tagsEnabled,
      replyWaitEnabled: config.replyWaitEnabled,
    }
  if (input.source === 'PUBLISHED') {
    snapshot = config.publishedSnapshot
    versionId = config.publishedVersionId
  }
  if (input.source === 'VERSION') {
    if (!input.versionId) throw new AiMemberError('INVALID_REQUEST')
    const [version] = await db
      .select()
      .from(aiConfigVersion)
      .where(
        and(eq(aiConfigVersion.id, input.versionId), eq(aiConfigVersion.memberId, input.memberId)),
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
  return { snapshot, versionId }
}

async function validateTestCustomer(
  tx: Transaction,
  workspaceId: string,
  customer: AiTestCustomer,
) {
  if (
    customer.properties.length > 20 ||
    customer.tags.length > 20 ||
    new Set(customer.properties.map((p) => p.definitionId)).size !== customer.properties.length ||
    new Set(customer.tags).size !== customer.tags.length ||
    customer.source.length > 1000 ||
    customer.language.length > 100 ||
    customer.memory.length > 1000 ||
    customer.properties.some((p) => typeof p.value === 'number' && !Number.isFinite(p.value))
  )
    throw new AiMemberError('INVALID_REQUEST')
  try {
    if (customer.language) normalizeAiReplyLanguage(customer.language)
    await assertAiStopReferences(tx, workspaceId, {
      ...EMPTY_AI_STOP_RULES,
      groups: [
        ...customer.properties.map((p) => [
          { kind: 'PROPERTY' as const, definitionId: p.definitionId, value: p.value },
        ]),
        ...customer.tags.map((tagId) => [{ kind: 'TAG' as const, tagId }]),
      ],
    })
  } catch {
    throw new AiMemberError('INVALID_REQUEST')
  }
}

async function lockTestSession(
  tx: Transaction,
  input: Identity & { memberId: string; sessionId: string },
) {
  await assertAiManager(tx, input.workspaceId, input.actingUserId)
  const [session] = await tx
    .select()
    .from(aiTestSession)
    .where(
      and(
        eq(aiTestSession.id, input.sessionId),
        eq(aiTestSession.workspaceId, input.workspaceId),
        eq(aiTestSession.memberId, input.memberId),
        eq(aiTestSession.userId, input.actingUserId),
      ),
    )
    .for('update')
  if (!session) throw new AiMemberError('NOT_FOUND')
  await getAiMemberConfig(tx, input)
  return session
}

export async function createAiTestSession(
  db: Database,
  input: TestConfiguration & { id: string; customer: AiTestCustomer },
) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select id from ${workspace} where id = ${input.workspaceId} for update`)
    const { snapshot, versionId } = await resolveTestConfiguration(tx, input)
    let customer = input.customer
    try {
      customer = {
        ...customer,
        language: customer.language.trim()
          ? normalizeAiReplyLanguage(customer.language.trim())
          : '',
      }
    } catch {
      throw new AiMemberError('INVALID_REQUEST')
    }
    await validateTestCustomer(tx, input.workspaceId, customer)
    const [existing] = await tx.select().from(aiTestSession).where(eq(aiTestSession.id, input.id))
    if (existing) {
      if (
        existing.workspaceId !== input.workspaceId ||
        existing.memberId !== input.memberId ||
        existing.userId !== input.actingUserId ||
        existing.source !== input.source ||
        (input.source === 'VERSION' && existing.configVersionId !== input.versionId) ||
        customerKey(existing.customer) !== customerKey(customer)
      )
        throw new AiMemberError('INVALID_REQUEST')
      return existing
    }
    const [session] = await tx
      .insert(aiTestSession)
      .values({
        id: input.id,
        workspaceId: input.workspaceId,
        memberId: input.memberId,
        userId: input.actingUserId,
        source: input.source,
        snapshot,
        configVersionId: versionId,
        customer,
      })
      .returning()
    return session
  })
}

export async function readAiTestSession(
  db: Database,
  input: Identity & { memberId: string; sessionId: string },
) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select id from ${workspace} where id = ${input.workspaceId} for share`)
    const session = await lockTestSession(tx, input)
    const rows = session.operationIds.length
      ? await tx
          .select()
          .from(aiOperation)
          .where(
            and(
              eq(aiOperation.workspaceId, input.workspaceId),
              inArray(aiOperation.id, session.operationIds),
            ),
          )
      : []
    return {
      session,
      turns: session.operationIds
        .map((id) => rows.find((r) => r.id === id))
        .filter((r) => r !== undefined),
    }
  })
}

export async function clearAiTestSession(
  db: Database,
  input: Identity & { memberId: string; sessionId: string; generation: number },
) {
  await db.transaction(async (tx) => {
    await tx.execute(sql`select id from ${workspace} where id = ${input.workspaceId} for update`)
    const session = await lockTestSession(tx, input)
    if (session.generation !== input.generation) throw new AiMemberError('INVALID_REQUEST')
    if (session.operationIds.length)
      await tx
        .update(aiToolAction)
        .set({ state: 'CANCELLED', failureCode: 'TEST_CLEARED', completedAt: new Date() })
        .where(
          and(
            inArray(aiToolAction.operationId, session.operationIds),
            inArray(aiToolAction.state, ['PENDING', 'RUNNING']),
          ),
        )
    if (session.operationIds.length)
      await tx
        .update(aiOperation)
        .set({ state: 'CANCELLED', failureCode: 'TEST_CLEARED', updatedAt: new Date() })
        .where(
          and(
            inArray(aiOperation.id, session.operationIds),
            sql`${aiOperation.state} in ('RESERVED', 'STARTED', 'UNKNOWN')`,
          ),
        )
    await tx
      .update(aiTestSession)
      .set({ generation: session.generation + 1, customer: EMPTY_TEST_CUSTOMER, operationIds: [] })
      .where(eq(aiTestSession.id, session.id))
  })
  return readAiTestSession(db, input)
}

export async function createAiTest(
  db: Database | Transaction,
  input: TestConfiguration & {
    id: string
    text: string
    sessionId?: string
    generation?: number
    simulatedHandoffFacts?: {
      properties: { definitionId: string; value: string | number }[]
      tags: string[]
    }
    frozenConfiguration?: { snapshot: AiMemberRuntimeSnapshot; versionId: string | null }
  },
) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select id from ${workspace} where id = ${input.workspaceId} for update`)
    if (input.frozenConfiguration) await getAiMemberConfig(tx, input)
    const session = input.sessionId
      ? await lockTestSession(tx, { ...input, sessionId: input.sessionId })
      : null
    if (session && session.generation !== input.generation)
      throw new AiMemberError('INVALID_REQUEST')
    if (
      session &&
      (input.source !== session.source ||
        (session.source === 'VERSION' && input.versionId !== session.configVersionId))
    )
      throw new AiMemberError('INVALID_REQUEST')
    const { snapshot, versionId } = session
      ? { snapshot: session.snapshot, versionId: session.configVersionId }
      : (input.frozenConfiguration ?? (await resolveTestConfiguration(tx, input)))
    if (!input.text.trim() || Array.from(input.text).length > 8_000)
      throw new AiMemberError('INVALID_REQUEST')
    const facts = session?.customer ?? input.simulatedHandoffFacts ?? { properties: [], tags: [] }
    if (
      facts.properties.length > 20 ||
      facts.tags.length > 20 ||
      new Set(facts.properties.map((p) => p.definitionId)).size !== facts.properties.length ||
      new Set(facts.tags).size !== facts.tags.length
    )
      throw new AiMemberError('INVALID_REQUEST')
    const rules = await tx.transaction(async (tx) => {
      await tx.execute(sql`select id from ${workspace} where id = ${input.workspaceId} for share`)
      const rules = await readEnabledAiHandoffRules(tx, input.workspaceId, input.memberId)
      try {
        await assertAiHandoffReferences(tx, input.workspaceId, rules)
        await assertAiStopReferences(tx, input.workspaceId, {
          ...EMPTY_AI_STOP_RULES,
          groups: [
            ...facts.properties.map((p) => [
              { kind: 'PROPERTY' as const, definitionId: p.definitionId, value: p.value },
            ]),
            ...facts.tags.map((tagId) => [{ kind: 'TAG' as const, tagId }]),
          ],
        })
      } catch {
        throw new AiMemberError('INVALID_CONFIGURATION')
      }
      return rules
    })
    let testContext: AiTestContext | undefined
    if (session) {
      await validateTestCustomer(tx, input.workspaceId, session.customer)
      const rows = session.operationIds.length
        ? await tx.select().from(aiOperation).where(inArray(aiOperation.id, session.operationIds))
        : []
      if (
        !session.operationIds.includes(input.id) &&
        rows.some((r) => ['RESERVED', 'STARTED', 'UNKNOWN'].includes(r.state))
      )
        throw new AiUsageError('OPERATION_PAUSED')
      if (!session.operationIds.includes(input.id) && session.operationIds.length >= 50)
        throw new AiMemberError('INVALID_REQUEST', 'Clear the test after 50 turns')
      const history: AiConversationContextMessage[] = []
      for (const id of session.operationIds) {
        const row = rows.find((r) => r.id === id)
        if (row?.state !== 'COMPLETED') continue
        const output = row.output as { kind?: string; decision?: { response?: string } } | null
        if (row.input)
          history.push({
            id: row.id,
            text: row.input,
            direction: 'INBOUND',
            origin: 'CUSTOMER',
            senderMemberId: null,
            createdAt: row.createdAt,
          })
        if (output?.kind === 'ANSWER' && output.decision?.response)
          history.push({
            id: row.id,
            text: output.decision.response,
            direction: 'OUTBOUND',
            origin: 'AI',
            senderMemberId: input.memberId,
            createdAt: row.updatedAt,
          })
      }
      let size = Array.from(input.text).length
      const bounded: AiConversationContextMessage[] = []
      for (const item of history.slice(-48).reverse()) {
        size += Array.from(item.text).length
        if (size > 8000) break
        bounded.unshift(item)
      }
      testContext = {
        sessionId: session.id,
        generation: session.generation,
        customer: session.customer,
        history: bounded,
      }
    }
    const operation = await reserveAiOperation(tx, {
      id: input.id,
      workspaceId: input.workspaceId,
      kind: 'TEST',
      variableInput: await readAiTestVariableInput(tx, {
        workspaceId: input.workspaceId,
        instructions: aiSkillVariableInstructions(snapshot),
        timeZone: snapshot.timeZone ?? 'UTC',
        text: input.text,
        customer: testContext?.customer,
        history: testContext?.history,
      }),
      memberId: input.memberId,
      configVersionId: versionId,
      text: input.text.trim(),
      snapshot,
      handoffContext: { rules, facts },
      propertyRules: await readAiTestPropertyRules(tx, input.workspaceId, input.memberId),
      tagRules: snapshot.tagsEnabled
        ? await readAiTestTagRules(tx, input.workspaceId, input.memberId)
        : [],
      testContext,
    })
    if (session && !session.operationIds.includes(operation.id)) {
      if (!operation.wasCreated) throw new AiMemberError('INVALID_REQUEST')
      await tx
        .update(aiTestSession)
        .set({ operationIds: [...session.operationIds, operation.id] })
        .where(eq(aiTestSession.id, session.id))
    }
    return { operation, created: operation.wasCreated }
  })
}

type TestSearchInput = Identity & {
  memberId: string
  id: string
  ordinal: number
  call: Extract<AiToolCall, { tool: 'search' }>
}

export async function authorizeAiTestTool(
  tx: Transaction,
  input: Omit<TestSearchInput, 'call'> & { call: AiToolCall },
  allowUnknown = false,
) {
  await tx.execute(sql`select id from ${workspace} where id = ${input.workspaceId} for share`)
  const [record] = await tx
    .select()
    .from(aiOperation)
    .where(
      and(
        eq(aiOperation.id, input.id),
        eq(aiOperation.workspaceId, input.workspaceId),
        eq(aiOperation.memberId, input.memberId),
      ),
    )
  if (
    record?.kind !== 'TEST' ||
    !['RESERVED', 'STARTED', ...(allowUnknown ? ['UNKNOWN'] : [])].includes(record.state)
  )
    return null
  try {
    await getAiMemberConfig(tx, input)
  } catch (error) {
    if (error instanceof AiMemberError) return null
    throw error
  }
  validateAiToolCalls(
    record.snapshot
      ? aiSelectedSkillInstructions(record.snapshot, selectedAiSkillId(record.output))
      : '',
    [input.call],
  )
  const context = (record.output as { testContext?: AiTestContext } | null)?.testContext
  if (context) {
    const session = await lockTestSession(tx, { ...input, sessionId: context.sessionId })
    if (session.generation !== context.generation || !session.operationIds.includes(record.id))
      return null
  }
  return record
}

export async function claimAiTestSearchAction(db: Database, input: TestSearchInput) {
  return db.transaction(async (tx) => {
    const record = await authorizeAiTestTool(tx, input)
    if (!record) return null
    if (!Number.isInteger(input.ordinal) || input.ordinal < 0 || input.ordinal > 2)
      throw new AiMemberError('INVALID_REQUEST')
    const [existing] = await tx
      .select()
      .from(aiToolAction)
      .where(and(eq(aiToolAction.operationId, record.id), eq(aiToolAction.ordinal, input.ordinal)))
      .for('update')
    if (
      existing &&
      (existing.tool !== 'search' || existing.arguments.query !== input.call.arguments.query)
    )
      throw new AiMemberError('INVALID_REQUEST')
    if (existing?.state === 'SUCCEEDED')
      return {
        action: existing,
        chunks: await readAiToolSearchChunks(tx, {
          workspaceId: input.workspaceId,
          knowledgeBaseId: record.snapshot?.knowledgeBaseId ?? '',
          ids: existing.result?.chunkIds as string[],
        }),
      }
    if (existing && ['UNKNOWN', 'CANCELLED'].includes(existing.state)) return null
    const [action] = existing
      ? await tx
          .update(aiToolAction)
          .set({ state: 'RUNNING', failureCode: null, startedAt: new Date(), completedAt: null })
          .where(eq(aiToolAction.id, existing.id))
          .returning()
      : await tx
          .insert(aiToolAction)
          .values({
            workspaceId: input.workspaceId,
            memberId: input.memberId,
            operationId: record.id,
            ordinal: input.ordinal,
            tool: 'search',
            arguments: input.call.arguments,
            simulated: true,
            state: 'RUNNING',
            startedAt: new Date(),
          })
          .returning()
    return { action, chunks: null }
  })
}

export async function finishAiTestSearchAction(
  db: Database,
  input: TestSearchInput & { chunkIds?: string[]; failure?: 'FAILED' | 'UNKNOWN' },
) {
  return db.transaction(async (tx) => {
    const record = await authorizeAiTestTool(tx, input, Boolean(input.failure))
    const [action] = await tx
      .select()
      .from(aiToolAction)
      .where(
        and(
          eq(aiToolAction.operationId, input.id),
          eq(aiToolAction.ordinal, input.ordinal),
          eq(aiToolAction.workspaceId, input.workspaceId),
          eq(aiToolAction.memberId, input.memberId),
        ),
      )
      .for('update')
    if (!action) return null
    if (!record || action.state === 'CANCELLED') {
      if (action.state !== 'SUCCEEDED' && action.state !== 'CANCELLED')
        await tx
          .update(aiToolAction)
          .set({
            state: 'CANCELLED',
            failureCode: 'TEST_AUTHORIZATION_CHANGED',
            completedAt: new Date(),
          })
          .where(eq(aiToolAction.id, action.id))
      return null
    }
    if (input.failure) {
      if (action.state !== 'SUCCEEDED')
        await tx
          .update(aiToolAction)
          .set({
            state: input.failure,
            failureCode: input.failure === 'UNKNOWN' ? 'TOOL_RESULT_UNKNOWN' : 'TOOL_SEARCH_FAILED',
            completedAt: new Date(),
          })
          .where(eq(aiToolAction.id, action.id))
      return null
    }
    if (!['RUNNING', 'SUCCEEDED'].includes(action.state)) return null
    const chunks = await readAiToolSearchChunks(tx, {
      workspaceId: input.workspaceId,
      knowledgeBaseId: record.snapshot?.knowledgeBaseId ?? '',
      ids:
        action.state === 'SUCCEEDED'
          ? (action.result?.chunkIds as string[])
          : (input.chunkIds ?? []),
    })
    if (action.state !== 'SUCCEEDED')
      await tx
        .update(aiToolAction)
        .set({
          state: 'SUCCEEDED',
          result: { chunkIds: chunks.map((chunk) => chunk.id) },
          completedAt: new Date(),
        })
        .where(eq(aiToolAction.id, action.id))
    return chunks
  })
}

export async function recordAiTestResult(
  db: Database | Transaction,
  input: {
    id: string
    output: unknown
    chunkIds: string[]
    actions?: { call: AiToolCall; chunkIds?: string[] }[]
    actingUserId?: string
  },
) {
  await db.transaction(async (tx) => {
    const [record] = await tx.select().from(aiOperation).where(eq(aiOperation.id, input.id))
    validateAiToolCalls(
      record?.snapshot
        ? aiSelectedSkillInstructions(record.snapshot, selectedAiSkillId(record.output))
        : '',
      (input.actions ?? []).map((a) => a.call),
    )
    if (record)
      await tx.execute(sql`select id from ${workspace} where id = ${record.workspaceId} for share`)
    if (input.actions?.some((action) => action.call.tool === 'external')) {
      if (!record?.memberId || !input.actingUserId) throw new AiMemberError('INVALID_REQUEST')
      await assertAiManager(tx, record.workspaceId, input.actingUserId)
      if (
        !(await checkExternalTestResults(tx, {
          workspaceId: record.workspaceId,
          memberId: record.memberId,
          actingUserId: input.actingUserId,
          id: record.id,
        }))
      )
        throw new AiMemberError('INVALID_CONFIGURATION')
    }
    const context = (record?.output as { testContext?: AiTestContext } | null)?.testContext
    const propertyRules =
      (record?.output as { propertyRules?: AiPropertyCollection['rules'] } | null)?.propertyRules ??
      []
    const collected =
      (input.output as { decision?: { collectedProperties?: AiCollectedProperty[] } } | null)
        ?.decision?.collectedProperties ?? []
    const tagRules =
      (record?.output as { tagRules?: import('./schema').AiTagCollection['rules'] } | null)
        ?.tagRules ?? []
    const appendedTags =
      (input.output as { decision?: { appendedTags?: string[] } } | null)?.decision?.appendedTags ??
      []
    if (
      new Set(appendedTags).size !== appendedTags.length ||
      appendedTags.some((id) => !tagRules.some((r) => r.definitionId === id))
    )
      throw new AiMemberError('INVALID_REQUEST')
    if (tagRules.length && record?.memberId) {
      const latest = await readAiTestTagRules(tx, record.workspaceId, record.memberId)
      if (
        tagRules.length !== latest.length ||
        tagRules.some((r) => !latest.some((v) => v.id === r.id && v.revision === r.revision))
      )
        throw new AiMemberError('INVALID_CONFIGURATION')
    }
    validateAiCollectedProperties(propertyRules, collected)
    if (record?.memberId) {
      await tx.execute(sql`select id from ${workspace} where id = ${record.workspaceId} for share`)
      if (
        !sameAiPropertyRules(
          { customerId: '', rules: propertyRules },
          {
            customerId: '',
            rules: await readAiTestPropertyRules(tx, record.workspaceId, record.memberId),
          },
        )
      )
        throw new AiMemberError('INVALID_CONFIGURATION')
    }
    if (context && record?.memberId) {
      await tx.execute(sql`select id from ${workspace} where id = ${record.workspaceId} for share`)
      const [session] = await tx
        .select()
        .from(aiTestSession)
        .where(eq(aiTestSession.id, context.sessionId))
        .for('update')
      if (
        !session ||
        session.generation !== context.generation ||
        !session.operationIds.includes(input.id)
      )
        return
      await lockTestSession(tx, {
        workspaceId: record.workspaceId,
        memberId: record.memberId,
        actingUserId: session.userId,
        sessionId: session.id,
      })
      await validateTestCustomer(tx, record.workspaceId, session.customer)
      const handoffContext = (
        record.output as {
          handoffContext?: { rules: Awaited<ReturnType<typeof readEnabledAiHandoffRules>> }
        } | null
      )?.handoffContext
      if (handoffContext) {
        const currentRules = await readEnabledAiHandoffRules(
          tx,
          record.workspaceId,
          record.memberId,
        )
        if (
          currentRules.length !== handoffContext.rules.length ||
          handoffContext.rules.some(
            (rule) =>
              !currentRules.some(
                (current) => current.id === rule.id && current.revision === rule.revision,
              ),
          )
        )
          throw new AiMemberError('INVALID_CONFIGURATION')
        await assertAiHandoffReferences(tx, record.workspaceId, currentRules)
      }
    }
    const updated = await tx
      .update(aiOperation)
      .set({
        output: {
          ...(input.output as object),
          ...(context ? { testContext: context } : {}),
          propertyRules,
          tagRules,
          variableInput: (record?.output as { variableInput?: AiVariableInput } | null)
            ?.variableInput,
          skillSelection: (record?.output as { skillSelection?: unknown } | null)?.skillSelection,
        },
        chunkIds: input.chunkIds,
        state: 'COMPLETED',
        updatedAt: new Date(),
      })
      .where(
        and(eq(aiOperation.id, input.id), sql`${aiOperation.state} in ('RESERVED', 'STARTED')`),
      )
      .returning({ id: aiOperation.id })
    const selection = (
      input.output as { decision?: { languageSelection?: { language: string } } } | null
    )?.decision?.languageSelection
    if (updated.length && record?.memberId && input.actions?.length)
      await tx
        .insert(aiToolAction)
        .values(
          input.actions.map((action, ordinal) => ({
            workspaceId: record.workspaceId,
            memberId: record.memberId as string,
            operationId: record.id,
            ordinal,
            tool: action.call.tool,
            arguments: action.call.arguments,
            simulated: true,
            state: 'SUCCEEDED' as const,
            result: {
              kind: 'SIMULATED',
              ...(action.chunkIds ? { chunkIds: action.chunkIds } : {}),
            },
            startedAt: new Date(),
            completedAt: new Date(),
          })),
        )
        .onConflictDoNothing()
    if (updated.length && context && record?.snapshot?.automaticLanguageEnabled && selection)
      await tx
        .update(aiTestSession)
        .set({
          customer: sql`jsonb_set(${aiTestSession.customer}, '{language}', ${JSON.stringify(selection.language)}::jsonb)`,
        })
        .where(eq(aiTestSession.id, context.sessionId))
    if (updated.length && context && (collected.length || appendedTags.length)) {
      const [session] = await tx
        .select()
        .from(aiTestSession)
        .where(eq(aiTestSession.id, context.sessionId))
      const properties = [
        ...session.customer.properties.filter(
          (p) => !collected.some((v) => v.definitionId === p.definitionId),
        ),
        ...collected,
      ]
      const tags = [...new Set([...session.customer.tags, ...appendedTags])]
      await validateTestCustomer(tx, record?.workspaceId ?? '', {
        ...session.customer,
        properties,
        tags,
      })
      await tx
        .update(aiTestSession)
        .set({ customer: { ...session.customer, properties, tags } })
        .where(eq(aiTestSession.id, session.id))
    }
  })
}

export async function getAiDiagnostics(db: Database, input: Identity & { id: string }) {
  await assertAiManager(db, input.workspaceId, input.actingUserId)
  const [run] = await db
    .select({ run: aiResponseRun, channelId: channelIdentity.channelId })
    .from(aiResponseRun)
    .innerJoin(conversation, eq(conversation.id, aiResponseRun.conversationId))
    .innerJoin(channelIdentity, eq(channelIdentity.id, conversation.channelIdentityId))
    .where(and(eq(aiResponseRun.id, input.id), eq(conversation.workspaceId, input.workspaceId)))
    .limit(1)
  const [operation] = await db
    .select()
    .from(aiOperation)
    .where(and(eq(aiOperation.id, input.id), eq(aiOperation.workspaceId, input.workspaceId)))
  if (!run && operation?.kind !== 'TEST') throw new AiMemberError('NOT_FOUND')
  if (
    run &&
    !(await readAiViewerChannelIds(db, { ...input, memberId: run.run.memberId })).includes(
      run.channelId,
    )
  )
    throw new AiMemberError('NOT_FOUND')
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
          mediaAssetId: knowledgeDocument.mediaAssetId,
          mediaTitle: mediaAsset.title,
          mediaDeletedAt: mediaAsset.deletedAt,
        })
        .from(knowledgeChunk)
        .innerJoin(knowledgeDocument, eq(knowledgeDocument.id, knowledgeChunk.knowledgeDocumentId))
        .leftJoin(
          mediaAsset,
          and(
            eq(mediaAsset.id, knowledgeDocument.mediaAssetId),
            eq(mediaAsset.workspaceId, input.workspaceId),
          ),
        )
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
  const segments = run?.run.outputMessageId
    ? await db
        .select({ id: message.id, text: message.text, deliveryState: message.deliveryState })
        .from(message)
        .where(
          and(
            sql`(${message.id} = ${run.run.outputMessageId} or ${message.replyGroupId} = ${run.run.id})`,
            eq(message.conversationId, run.run.conversationId),
          ),
        )
        .orderBy(asc(message.createdAt), asc(message.id))
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
    : ((operation?.output as { testContext?: AiTestContext } | null)?.testContext?.history ?? [])
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
  const actions = await db
    .select({
      id: aiToolAction.id,
      tool: aiToolAction.tool,
      definitionRevision: aiToolAction.definitionRevision,
      state: aiToolAction.state,
      simulated: aiToolAction.simulated,
      failureCode: aiToolAction.failureCode,
      startedAt: aiToolAction.startedAt,
      completedAt: aiToolAction.completedAt,
    })
    .from(aiToolAction)
    .where(
      and(eq(aiToolAction.operationId, input.id), eq(aiToolAction.workspaceId, input.workspaceId)),
    )
    .orderBy(asc(aiToolAction.ordinal))
  return {
    run: run
      ? {
          ...run.run,
          customerMemoryInput: undefined,
          variableInput: undefined,
          variableInputVersion: run.run.variableInput
            ? {
                version: run.run.variableInput.version,
                capturedAt: run.run.variableInput.capturedAt,
              }
            : null,
          customerMemoryRevision: run.run.customerMemoryInput?.revision ?? null,
        }
      : null,
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
    output: segments[0]
      ? {
          ...segments[0],
          text: segments.map((part) => part.text ?? '').join(''),
          deliveryState: segments.some((part) => part.deliveryState === 'FAILED')
            ? 'FAILED'
            : segments.every((part) => part.deliveryState === 'SENT')
              ? 'SENT'
              : 'PENDING',
        }
      : null,
    segments,
    chunks,
    missingChunkIds: chunkIds.filter((id) => !chunks.some((c) => c.id === id)),
    attempts,
    actions,
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
    .innerJoin(
      message,
      and(eq(message.id, input.messageId), eq(message.conversationId, conversation.id)),
    )
    .where(
      and(
        eq(conversation.workspaceId, input.workspaceId),
        sql`(${aiResponseRun.outputMessageId} = ${input.messageId} or ${aiResponseRun.id} = ${message.replyGroupId})`,
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
    select sender, count(*)::integer as replies,
      count(*) filter (where sent)::integer as sent,
      count(*) filter (where failed)::integer as failed
    from (
    select m.type as sender, coalesce(msg.reply_group_id, msg.id) as reply_id,
      bool_and(msg.delivery_state = 'SENT') as sent,
      bool_or(msg.delivery_state = 'FAILED') as failed
    from message msg join conversation c on c.id = msg.conversation_id join member m on m.id = msg.sender_member_id
    where c.workspace_id = ${input.workspaceId} and msg.direction = 'OUTBOUND'
      ${input.memberId ? sql`and m.id = ${input.memberId}::uuid` : sql``}
      ${input.versionId ? sql`and exists (select 1 from ai_response_run r where (r.output_message_id = msg.id or r.id = msg.reply_group_id) and r.config_version_id = ${input.versionId}::uuid)` : sql``}
    group by m.type, coalesce(msg.reply_group_id, msg.id)
    having min(msg.created_at) >= ${input.from} and min(msg.created_at) < ${input.to}
    ) logical_replies group by sender order by sender`)
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
  const channels = await readAiViewerChannelIds(db, input)
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
        join channel_identity on channel_identity.id = c.channel_identity_id
      where c.workspace_id = ${input.workspaceId} and r.member_id = ${input.memberId}
        and ${inArray(channelIdentity.channelId, channels)}
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
    runs: page.filter((r) => r.kind === 'LIVE_REPLY' || r.kind === 'FOLLOW_UP'),
    tests: page.filter((r) => r.kind === 'TEST'),
    nextCursor:
      result.rows.length > 100 && last ? { createdAt: last.createdAt, id: last.id } : null,
  }
}
