import { and, asc, eq, sql } from 'drizzle-orm'
import type { Database } from './database'
import { AiMemberError, assertAiManager } from './ai-members'
import {
  assertAiStopReferences,
  EMPTY_AI_STOP_RULES,
  normalizeAiStopRules,
  readAiConditionFacts,
  matchesAiCondition,
} from './ai-stop'
import { aiHandoffRule, member, workspace, type AiHandoffCondition } from './schema'

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0]
type Identity = { workspaceId: string; memberId: string; actingUserId: string }
export type AiHandoffEvaluation = {
  rules: { id: string; revision: number }[]
  matchedRuleId: string | null
}

async function assertTarget(db: Database | Transaction, input: Identity) {
  await assertAiManager(db, input.workspaceId, input.actingUserId)
  const [target] = await db
    .select({ id: member.id })
    .from(member)
    .where(
      and(
        eq(member.id, input.memberId),
        eq(member.workspaceId, input.workspaceId),
        eq(member.type, 'AI'),
      ),
    )
  if (!target) throw new AiMemberError('NOT_FOUND')
}

export async function listAiHandoffRules(db: Database, input: Identity) {
  await assertTarget(db, input)
  return db
    .select()
    .from(aiHandoffRule)
    .where(
      and(
        eq(aiHandoffRule.workspaceId, input.workspaceId),
        eq(aiHandoffRule.memberId, input.memberId),
      ),
    )
    .orderBy(asc(aiHandoffRule.createdAt), asc(aiHandoffRule.id))
}

export async function readEnabledAiHandoffRules(
  db: Database | Transaction,
  workspaceId: string,
  memberId: string,
) {
  return db
    .select()
    .from(aiHandoffRule)
    .where(
      and(
        eq(aiHandoffRule.workspaceId, workspaceId),
        eq(aiHandoffRule.memberId, memberId),
        eq(aiHandoffRule.enabled, true),
      ),
    )
    .orderBy(asc(aiHandoffRule.createdAt), asc(aiHandoffRule.id))
}

export async function assertAiHandoffReferences(
  tx: Transaction,
  workspaceId: string,
  rules: { condition: AiHandoffCondition }[],
) {
  await assertAiStopReferences(tx, workspaceId, {
    ...EMPTY_AI_STOP_RULES,
    groups: rules
      .filter((r) => r.condition.kind !== 'SEMANTIC')
      .map((r) => [r.condition as Exclude<AiHandoffCondition, { kind: 'SEMANTIC' }>]),
  })
}

export async function saveAiHandoffRule(
  db: Database,
  input: Identity & {
    id?: string
    revision?: number
    name: string
    enabled: boolean
    condition: AiHandoffCondition
  },
) {
  const name = input.name.trim()
  let condition = input.condition
  if (!name || name.length > 100 || typeof input.enabled !== 'boolean')
    throw new AiMemberError('INVALID_REQUEST')
  if (condition?.kind === 'SEMANTIC') {
    if (
      typeof condition.text !== 'string' ||
      !condition.text.trim() ||
      Array.from(condition.text).length > 2000
    )
      throw new AiMemberError('INVALID_REQUEST')
    condition = { kind: 'SEMANTIC', text: condition.text.trim() }
  } else {
    if (!condition || !['PROPERTY', 'TAG'].includes(condition.kind))
      throw new AiMemberError('INVALID_REQUEST')
    try {
      normalizeAiStopRules({
        ...EMPTY_AI_STOP_RULES,
        groups: [[condition as Exclude<AiHandoffCondition, { kind: 'SEMANTIC' }>]],
      })
    } catch {
      throw new AiMemberError('INVALID_REQUEST')
    }
  }
  return db.transaction(async (tx) => {
    await tx.execute(sql`select id from ${workspace} where id = ${input.workspaceId} for update`)
    await assertTarget(tx, input)
    if (input.enabled) {
      try {
        await assertAiHandoffReferences(tx, input.workspaceId, [{ condition }])
      } catch {
        throw new AiMemberError('INVALID_CONFIGURATION')
      }
    }
    if (input.id) {
      const [updated] = await tx
        .update(aiHandoffRule)
        .set({
          name,
          enabled: input.enabled,
          condition,
          revision: sql`${aiHandoffRule.revision} + 1`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(aiHandoffRule.id, input.id),
            eq(aiHandoffRule.workspaceId, input.workspaceId),
            eq(aiHandoffRule.memberId, input.memberId),
            eq(aiHandoffRule.revision, input.revision ?? 0),
          ),
        )
        .returning()
      if (!updated) throw new AiMemberError('INVALID_REQUEST', 'Rule changed; reload before saving')
      return updated
    }
    const rules = await tx
      .select({ id: aiHandoffRule.id })
      .from(aiHandoffRule)
      .where(
        and(
          eq(aiHandoffRule.workspaceId, input.workspaceId),
          eq(aiHandoffRule.memberId, input.memberId),
        ),
      )
    if (rules.length >= 20) throw new AiMemberError('INVALID_REQUEST', 'At most 20 handoff rules')
    const [created] = await tx
      .insert(aiHandoffRule)
      .values({
        workspaceId: input.workspaceId,
        memberId: input.memberId,
        name,
        enabled: input.enabled,
        condition,
      })
      .returning()
    return created
  })
}

export async function deleteAiHandoffRule(
  db: Database,
  input: Identity & { id: string; revision: number },
) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select id from ${workspace} where id = ${input.workspaceId} for update`)
    await assertTarget(tx, input)
    const [deleted] = await tx
      .delete(aiHandoffRule)
      .where(
        and(
          eq(aiHandoffRule.id, input.id),
          eq(aiHandoffRule.workspaceId, input.workspaceId),
          eq(aiHandoffRule.memberId, input.memberId),
          eq(aiHandoffRule.revision, input.revision),
        ),
      )
      .returning({ id: aiHandoffRule.id })
    if (!deleted) throw new AiMemberError('INVALID_REQUEST', 'Rule changed; reload before deleting')
  })
}

export async function matchAiHandoffRule(
  tx: Transaction,
  input: Parameters<typeof readAiConditionFacts>[1],
  rules: Awaited<ReturnType<typeof readEnabledAiHandoffRules>>,
) {
  await assertAiHandoffReferences(tx, input.workspaceId, rules)
  const deterministic = rules.filter((r) => r.condition.kind !== 'SEMANTIC')
  if (!deterministic.length) return undefined
  const facts = await readAiConditionFacts(tx, input)
  return deterministic.find(
    (r) => r.condition.kind !== 'SEMANTIC' && matchesAiCondition(r.condition, facts),
  )
}
