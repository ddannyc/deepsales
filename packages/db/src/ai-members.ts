import { and, desc, eq, sql } from 'drizzle-orm'
import type { Database } from './database'
import {
  aiMemberConfig,
  aiConfigVersion,
  channel,
  knowledgeBase,
  member,
  memberChannelAccess,
  workspace,
  workspaceUserAccess,
  type AiMemberRuntimeSnapshot,
  type AdMapping,
} from './schema'

const MAX_INSTRUCTIONS_CODE_POINTS = 20_000
const MAX_RESPONSE_LANGUAGE_CODE_POINTS = 100
const MAX_HANDOFF_KEYWORDS = 100
const MAX_HANDOFF_KEYWORD_CODE_POINTS = 100

export type AiMemberErrorCode =
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'INVALID_REQUEST'
  | 'INVALID_CONFIGURATION'

export class AiMemberError extends Error {
  constructor(
    readonly code: AiMemberErrorCode,
    message: string = code,
  ) {
    super(message)
  }
}

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0]
type QueryHandle = Database | Transaction

export type AiMemberConfig = {
  memberId: string
  memberDisplayName: string | null
  memberStatus: 'ACTIVE' | 'DISABLED'
  instructions: string
  responseLanguage: string
  knowledgeBaseId: string | null
  handoffOnCustomerRequest: boolean
  handoffOnNoKnowledge: boolean
  handoffOnNegativeSentiment: boolean
  handoffOnUnableToAnswer: boolean
  handoffKeywords: string[]
  adLearningEnabled: boolean
  adMappings: AdMapping[]
  publishedSnapshot: AiMemberRuntimeSnapshot | null
  publishedAt: Date | null
  publishedVersionId: string | null
  runtimeStatus: 'UNPUBLISHED' | 'USABLE' | 'UNHEALTHY'
  runtimeError: string | null
}

export type UpdateAiMemberConfigInput = {
  workspaceId: string
  memberId: string
  actingUserId: string
  instructions?: string
  responseLanguage?: string
  knowledgeBaseId?: string | null
  handoffOnCustomerRequest?: boolean
  handoffOnNoKnowledge?: boolean
  handoffOnNegativeSentiment?: boolean
  handoffOnUnableToAnswer?: boolean
  handoffKeywords?: string[]
  adLearningEnabled?: boolean
  adMappings?: AdMapping[]
}

export async function getAiMemberConfig(
  db: Database,
  input: { workspaceId: string; memberId: string; actingUserId: string },
) {
  return db.transaction(async (tx) => {
    await assertManager(tx, input.workspaceId, input.actingUserId)
    return selectAiMemberConfig(tx, input.workspaceId, input.memberId)
  })
}

export async function updateAiMemberConfig(db: Database, input: UpdateAiMemberConfigInput) {
  const draft = normalizeDraft(input)
  return db.transaction(async (tx) => {
    await assertManager(tx, input.workspaceId, input.actingUserId)
    await tx.execute(sql`select id from ${workspace} where id = ${input.workspaceId} for update`)
    const target = await lockAiMember(tx, input.workspaceId, input.memberId)
    if (draft.knowledgeBaseId !== undefined && draft.knowledgeBaseId !== null) {
      await assertKnowledgeBase(tx, input.workspaceId, draft.knowledgeBaseId)
    }

    const [existing] = await tx
      .select({ memberId: aiMemberConfig.memberId })
      .from(aiMemberConfig)
      .where(eq(aiMemberConfig.memberId, target.id))
      .for('update')
      .limit(1)
    if (existing) {
      await tx
        .update(aiMemberConfig)
        .set({ ...draft, updatedAt: new Date() })
        .where(eq(aiMemberConfig.memberId, target.id))
    } else {
      await tx.insert(aiMemberConfig).values({
        memberId: target.id,
        instructions: draft.instructions ?? '',
        responseLanguage: draft.responseLanguage ?? '',
        knowledgeBaseId: draft.knowledgeBaseId ?? null,
        handoffOnCustomerRequest: draft.handoffOnCustomerRequest ?? true,
        handoffOnNoKnowledge: draft.handoffOnNoKnowledge ?? true,
        handoffOnNegativeSentiment: draft.handoffOnNegativeSentiment ?? true,
        handoffOnUnableToAnswer: draft.handoffOnUnableToAnswer ?? true,
        handoffKeywords: draft.handoffKeywords ?? [],
        adLearningEnabled: draft.adLearningEnabled ?? false,
        adMappings: draft.adMappings ?? [],
      })
    }
    return selectAiMemberConfig(tx, input.workspaceId, input.memberId)
  })
}

export async function publishAiMemberConfig(
  db: Database,
  input: {
    workspaceId: string
    memberId: string
    actingUserId: string
    providerConfigured: boolean
    now?: Date
  },
) {
  const now = input.now ?? new Date()
  return db.transaction(async (tx) => {
    await assertManager(tx, input.workspaceId, input.actingUserId)
    const target = await lockAiMember(tx, input.workspaceId, input.memberId)
    const [stored] = await tx
      .select()
      .from(aiMemberConfig)
      .where(eq(aiMemberConfig.memberId, target.id))
      .for('update')
      .limit(1)
    const config = stored ?? defaultConfig(target.id)

    if (target.status !== 'ACTIVE') {
      throw invalidConfiguration('AI member must be active')
    }
    if (!input.providerConfigured) {
      throw invalidConfiguration('AI provider configuration is unavailable')
    }
    const [access] = await tx
      .select({ memberId: memberChannelAccess.memberId })
      .from(memberChannelAccess)
      .innerJoin(channel, eq(channel.id, memberChannelAccess.channelId))
      .where(
        and(
          eq(memberChannelAccess.memberId, target.id),
          eq(channel.workspaceId, input.workspaceId),
        ),
      )
      .limit(1)
    if (!access) throw invalidConfiguration('AI member needs channel access')
    if (!config.knowledgeBaseId) throw invalidConfiguration('Knowledge base is required')
    await assertKnowledgeBase(tx, input.workspaceId, config.knowledgeBaseId)
    if (!config.instructions.trim()) throw invalidConfiguration('Instructions are required')
    if (!config.responseLanguage.trim()) {
      throw invalidConfiguration('Response language is required')
    }

    const snapshot: AiMemberRuntimeSnapshot = {
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
    const [version] = await tx
      .insert(aiConfigVersion)
      .values({
        memberId: target.id,
        snapshot,
        publishedAt: now,
      })
      .returning({ id: aiConfigVersion.id })
    if (!version) throw new Error('Version was not created')
    if (stored) {
      await tx
        .update(aiMemberConfig)
        .set({
          publishedSnapshot: snapshot,
          publishedAt: now,
          publishedVersionId: version.id,
          runtimeStatus: 'USABLE',
          runtimeError: null,
          updatedAt: now,
        })
        .where(eq(aiMemberConfig.memberId, target.id))
    } else {
      await tx.insert(aiMemberConfig).values({
        ...config,
        publishedSnapshot: snapshot,
        publishedAt: now,
        publishedVersionId: version.id,
        runtimeStatus: 'USABLE',
        runtimeError: null,
        updatedAt: now,
      })
    }
    return selectAiMemberConfig(tx, input.workspaceId, input.memberId)
  })
}

async function selectAiMemberConfig(
  db: QueryHandle,
  workspaceId: string,
  memberId: string,
): Promise<AiMemberConfig> {
  const [row] = await db
    .select({
      memberId: member.id,
      memberType: member.type,
      memberDisplayName: member.displayName,
      memberStatus: member.status,
      configMemberId: aiMemberConfig.memberId,
      instructions: aiMemberConfig.instructions,
      responseLanguage: aiMemberConfig.responseLanguage,
      knowledgeBaseId: aiMemberConfig.knowledgeBaseId,
      handoffOnCustomerRequest: aiMemberConfig.handoffOnCustomerRequest,
      handoffOnNoKnowledge: aiMemberConfig.handoffOnNoKnowledge,
      handoffOnNegativeSentiment: aiMemberConfig.handoffOnNegativeSentiment,
      handoffOnUnableToAnswer: aiMemberConfig.handoffOnUnableToAnswer,
      handoffKeywords: aiMemberConfig.handoffKeywords,
      adLearningEnabled: aiMemberConfig.adLearningEnabled,
      adMappings: aiMemberConfig.adMappings,
      publishedSnapshot: aiMemberConfig.publishedSnapshot,
      publishedAt: aiMemberConfig.publishedAt,
      publishedVersionId: aiMemberConfig.publishedVersionId,
      runtimeStatus: aiMemberConfig.runtimeStatus,
      runtimeError: aiMemberConfig.runtimeError,
    })
    .from(member)
    .leftJoin(aiMemberConfig, eq(aiMemberConfig.memberId, member.id))
    .where(and(eq(member.id, memberId), eq(member.workspaceId, workspaceId)))
    .limit(1)
  if (row?.memberType !== 'AI') throw new AiMemberError('NOT_FOUND', 'AI member not found')
  return {
    memberId: row.memberId,
    memberDisplayName: row.memberDisplayName,
    memberStatus: row.memberStatus,
    instructions: row.instructions ?? '',
    responseLanguage: row.responseLanguage ?? '',
    knowledgeBaseId: row.knowledgeBaseId ?? null,
    handoffOnCustomerRequest: row.handoffOnCustomerRequest ?? true,
    handoffOnNoKnowledge: row.handoffOnNoKnowledge ?? true,
    handoffOnNegativeSentiment: row.handoffOnNegativeSentiment ?? true,
    handoffOnUnableToAnswer: row.handoffOnUnableToAnswer ?? true,
    handoffKeywords: row.handoffKeywords ?? [],
    adLearningEnabled: row.adLearningEnabled ?? false,
    adMappings: row.adMappings ?? [],
    publishedSnapshot: row.publishedSnapshot ?? null,
    publishedAt: row.publishedAt ?? null,
    publishedVersionId: row.publishedVersionId ?? null,
    runtimeStatus: row.runtimeStatus ?? 'UNPUBLISHED',
    runtimeError: row.runtimeError ?? null,
  }
}

async function lockAiMember(tx: Transaction, workspaceId: string, memberId: string) {
  const [target] = await tx
    .select({ id: member.id, type: member.type, status: member.status })
    .from(member)
    .where(and(eq(member.id, memberId), eq(member.workspaceId, workspaceId)))
    .for('update')
    .limit(1)
  if (target?.type !== 'AI') throw new AiMemberError('NOT_FOUND', 'AI member not found')
  return target
}

async function assertKnowledgeBase(tx: Transaction, workspaceId: string, knowledgeBaseId: string) {
  const [base] = await tx
    .select({ id: knowledgeBase.id })
    .from(knowledgeBase)
    .where(and(eq(knowledgeBase.id, knowledgeBaseId), eq(knowledgeBase.workspaceId, workspaceId)))
    .limit(1)
  if (!base) throw new AiMemberError('INVALID_CONFIGURATION', 'Knowledge base is not in workspace')
}

export async function assertAiManager(tx: QueryHandle, workspaceId: string, userId: string) {
  const [access] = await tx
    .select({ role: workspaceUserAccess.role })
    .from(workspaceUserAccess)
    .innerJoin(member, eq(member.workspaceUserAccessId, workspaceUserAccess.id))
    .where(
      and(
        eq(workspaceUserAccess.workspaceId, workspaceId),
        eq(workspaceUserAccess.userId, userId),
        eq(member.status, 'ACTIVE'),
      ),
    )
    .limit(1)
  if (!access || access.role === 'AGENT') {
    throw new AiMemberError('FORBIDDEN', 'Manager access required')
  }
}

const assertManager = assertAiManager

export async function listAiConfigVersions(
  db: Database,
  input: {
    workspaceId: string
    memberId: string
    actingUserId: string
  },
) {
  await getAiMemberConfig(db, input)
  const versions = await db
    .select()
    .from(aiConfigVersion)
    .where(eq(aiConfigVersion.memberId, input.memberId))
    .orderBy(desc(aiConfigVersion.publishedAt), desc(aiConfigVersion.id))
  const bases = await db
    .select({ id: knowledgeBase.id })
    .from(knowledgeBase)
    .where(eq(knowledgeBase.workspaceId, input.workspaceId))
  return versions.map((version) => ({
    ...version,
    invalidReferences: bases.some(({ id }) => id === version.snapshot.knowledgeBaseId)
      ? []
      : ['knowledgeBaseId'],
  }))
}

export async function restoreAiConfigVersion(
  db: Database,
  input: {
    workspaceId: string
    memberId: string
    actingUserId: string
    versionId: string
  },
) {
  return db.transaction(async (tx) => {
    await assertManager(tx, input.workspaceId, input.actingUserId)
    await tx.execute(sql`select id from ${workspace} where id = ${input.workspaceId} for update`)
    await lockAiMember(tx, input.workspaceId, input.memberId)
    const [version] = await tx
      .select()
      .from(aiConfigVersion)
      .where(
        and(eq(aiConfigVersion.id, input.versionId), eq(aiConfigVersion.memberId, input.memberId)),
      )
      .limit(1)
    if (!version) throw new AiMemberError('NOT_FOUND')
    const [base] = await tx
      .select({ id: knowledgeBase.id })
      .from(knowledgeBase)
      .where(
        and(
          eq(knowledgeBase.id, version.snapshot.knowledgeBaseId),
          eq(knowledgeBase.workspaceId, input.workspaceId),
        ),
      )
      .limit(1)
    await tx
      .update(aiMemberConfig)
      .set({
        ...version.snapshot,
        adLearningEnabled: version.snapshot.adLearningEnabled ?? false,
        adMappings: version.snapshot.adMappings ?? [],
        knowledgeBaseId: base?.id ?? null,
        updatedAt: new Date(),
      })
      .where(eq(aiMemberConfig.memberId, input.memberId))
    return selectAiMemberConfig(tx, input.workspaceId, input.memberId)
  })
}

function normalizeDraft(input: UpdateAiMemberConfigInput) {
  const instructions =
    input.instructions === undefined
      ? undefined
      : cleanText(input.instructions, MAX_INSTRUCTIONS_CODE_POINTS, 'Instructions')
  const responseLanguage =
    input.responseLanguage === undefined
      ? undefined
      : cleanText(input.responseLanguage, MAX_RESPONSE_LANGUAGE_CODE_POINTS, 'Response language')
  const handoffKeywords =
    input.handoffKeywords === undefined ? undefined : normalizeKeywords(input.handoffKeywords)
  return {
    instructions,
    responseLanguage,
    knowledgeBaseId: input.knowledgeBaseId,
    handoffOnCustomerRequest: input.handoffOnCustomerRequest,
    handoffOnNoKnowledge: input.handoffOnNoKnowledge,
    handoffOnNegativeSentiment: input.handoffOnNegativeSentiment,
    handoffOnUnableToAnswer: input.handoffOnUnableToAnswer,
    handoffKeywords,
    adLearningEnabled: input.adLearningEnabled,
    adMappings: input.adMappings === undefined ? undefined : normalizeAdMappings(input.adMappings),
  }
}

function normalizeKeywords(values: string[]) {
  if (!Array.isArray(values) || values.length > MAX_HANDOFF_KEYWORDS) {
    throw new AiMemberError('INVALID_REQUEST', 'Too many handoff keywords')
  }
  const result: string[] = []
  for (const value of values) {
    if (typeof value !== 'string')
      throw new AiMemberError('INVALID_REQUEST', 'Invalid handoff keyword')
    const normalized = value.normalize('NFKC').trim().toLowerCase()
    if (!normalized) continue
    if (Array.from(normalized).length > MAX_HANDOFF_KEYWORD_CODE_POINTS) {
      throw new AiMemberError('INVALID_REQUEST', 'Handoff keyword is too long')
    }
    if (!result.includes(normalized)) result.push(normalized)
  }
  return result
}

function cleanText(value: string, maxCodePoints: number, label: string) {
  if (typeof value !== 'string') throw new AiMemberError('INVALID_REQUEST', `${label} is invalid`)
  const cleaned = value.trim()
  if (Array.from(cleaned).length > maxCodePoints) {
    throw new AiMemberError('INVALID_REQUEST', `${label} is too long`)
  }
  return cleaned
}

function defaultConfig(memberId: string) {
  return {
    memberId,
    instructions: '',
    responseLanguage: '',
    knowledgeBaseId: null,
    handoffOnCustomerRequest: true,
    handoffOnNoKnowledge: true,
    handoffOnNegativeSentiment: true,
    handoffOnUnableToAnswer: true,
    handoffKeywords: [],
    adLearningEnabled: false,
    adMappings: [],
    publishedSnapshot: null,
    publishedAt: null,
    runtimeStatus: 'UNPUBLISHED' as const,
    runtimeError: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  }
}

function invalidConfiguration(message: string) {
  return new AiMemberError('INVALID_CONFIGURATION', message)
}

export function normalizeAdMappings(items: unknown): AdMapping[] {
  if (!Array.isArray(items) || items.length > 100) throw new AiMemberError('INVALID_REQUEST')
  const ids = new Set<string>()
  return items.map((item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item))
      throw new AiMemberError('INVALID_REQUEST')
    const entry = item as Record<string, unknown>
    if (
      typeof entry.adId !== 'string' ||
      typeof entry.content !== 'string' ||
      Object.keys(entry).some((key) => key !== 'adId' && key !== 'content')
    )
      throw new AiMemberError('INVALID_REQUEST')
    const adId = entry.adId.trim()
    const content = entry.content.trim()
    if (
      !/^\d{1,200}$/.test(adId) ||
      ids.has(adId) ||
      !content ||
      Array.from(content).length > 2000
    ) {
      throw new AiMemberError('INVALID_REQUEST')
    }
    ids.add(adId)
    return { adId, content }
  })
}
