import { and, asc, eq, isNull, sql } from 'drizzle-orm'
import { AiMemberError, assertAiManager } from './ai-members'
import { memoryChannelsAllowed } from './customer-memory'
import { validatePropertyValue } from './customers'
import type { Database } from './database'
import {
  type AiPropertyCollection,
  aiPropertyRule,
  channelIdentity,
  customerPropertyDefinition,
  customerPropertyHistory,
  customerPropertyValue,
  member,
  workspace,
} from './schema'

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0]
type Handle = Database | Transaction
type Identity = { workspaceId: string; memberId: string; actingUserId: string }
async function assertTarget(db: Handle, input: Identity) {
  await assertAiManager(db, input.workspaceId, input.actingUserId)
  const [target] = await db
    .select()
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
export async function listAiPropertyRules(db: Handle, input: Identity) {
  await assertTarget(db, input)
  return db
    .select()
    .from(aiPropertyRule)
    .where(
      and(
        eq(aiPropertyRule.workspaceId, input.workspaceId),
        eq(aiPropertyRule.memberId, input.memberId),
      ),
    )
    .orderBy(asc(aiPropertyRule.id))
}
export async function saveAiPropertyRule(
  db: Database,
  input: Identity & {
    id: string
    definitionId: string
    instructions: string
    enabled: boolean
    revision?: number
  },
) {
  if (
    !input.instructions.trim() ||
    input.instructions.length > 2000 ||
    typeof input.enabled !== 'boolean'
  )
    throw new AiMemberError('INVALID_REQUEST')
  return db.transaction(async (tx) => {
    await tx.execute(sql`select id from ${workspace} where id = ${input.workspaceId} for update`)
    await assertTarget(tx, input)
    const [definition] = await tx
      .select()
      .from(customerPropertyDefinition)
      .where(
        and(
          eq(customerPropertyDefinition.id, input.definitionId),
          eq(customerPropertyDefinition.workspaceId, input.workspaceId),
          isNull(customerPropertyDefinition.deletedAt),
        ),
      )
    if (!definition) throw new AiMemberError('INVALID_CONFIGURATION')
    const rules = await listAiPropertyRules(tx, input)
    const old = rules.find((r) => r.id === input.id)
    if (
      rules.some((r) => r.definitionId === input.definitionId && r.id !== input.id) ||
      (old ? old.revision !== input.revision : input.revision !== undefined) ||
      (!old && rules.length >= 20)
    )
      throw new AiMemberError('INVALID_REQUEST')
    const data = {
      definitionId: input.definitionId,
      instructions: input.instructions.trim(),
      enabled: input.enabled,
      revision: (old?.revision ?? 0) + 1,
    }
    const [rule] = old
      ? await tx.update(aiPropertyRule).set(data).where(eq(aiPropertyRule.id, old.id)).returning()
      : await tx
          .insert(aiPropertyRule)
          .values({
            ...data,
            id: input.id,
            workspaceId: input.workspaceId,
            memberId: input.memberId,
          })
          .returning()
    return rule
  })
}
export async function deleteAiPropertyRule(
  db: Database,
  input: Identity & { id: string; revision: number },
) {
  await db.transaction(async (tx) => {
    await tx.execute(sql`select id from ${workspace} where id = ${input.workspaceId} for update`)
    await assertTarget(tx, input)
    const removed = await tx
      .delete(aiPropertyRule)
      .where(
        and(
          eq(aiPropertyRule.id, input.id),
          eq(aiPropertyRule.workspaceId, input.workspaceId),
          eq(aiPropertyRule.memberId, input.memberId),
          eq(aiPropertyRule.revision, input.revision),
        ),
      )
      .returning()
    if (!removed.length) throw new AiMemberError('INVALID_REQUEST')
  })
}
export async function readAiPropertyRules(db: Handle, workspaceId: string, memberId: string) {
  return db
    .select({ rule: aiPropertyRule, definition: customerPropertyDefinition })
    .from(aiPropertyRule)
    .innerJoin(
      customerPropertyDefinition,
      eq(customerPropertyDefinition.id, aiPropertyRule.definitionId),
    )
    .where(
      and(
        eq(aiPropertyRule.workspaceId, workspaceId),
        eq(aiPropertyRule.memberId, memberId),
        eq(aiPropertyRule.enabled, true),
        eq(customerPropertyDefinition.workspaceId, workspaceId),
        isNull(customerPropertyDefinition.deletedAt),
      ),
    )
    .orderBy(asc(aiPropertyRule.id))
}

export async function readAiTestPropertyRules(
  db: Handle,
  workspaceId: string,
  memberId: string,
): Promise<AiPropertyCollection['rules']> {
  return (await readAiPropertyRules(db, workspaceId, memberId)).map(({ rule, definition }) => ({
    id: rule.id,
    revision: rule.revision,
    definitionId: definition.id,
    definitionRevision: definition.revision,
    name: definition.name,
    level: definition.level,
    type: definition.type,
    options: definition.options,
    maxLength: definition.maxLength,
    instructions: rule.instructions,
    valueRevision: 0,
  }))
}
export async function readAiPropertyCollection(
  db: Handle,
  input: {
    workspaceId: string
    memberId: string
    customerId: string
    conversationId: string
    channelId: string
  },
): Promise<AiPropertyCollection> {
  const rules: AiPropertyCollection['rules'] = []
  const identities = await db
    .select({ id: channelIdentity.channelId })
    .from(channelIdentity)
    .where(
      and(
        eq(channelIdentity.workspaceId, input.workspaceId),
        eq(channelIdentity.customerId, input.customerId),
      ),
    )
  for (const { rule, definition } of await readAiPropertyRules(
    db,
    input.workspaceId,
    input.memberId,
  )) {
    const [value] = await db
      .select()
      .from(customerPropertyValue)
      .where(
        and(
          eq(customerPropertyValue.definitionId, definition.id),
          definition.level === 'CUSTOMER'
            ? eq(customerPropertyValue.customerId, input.customerId)
            : eq(customerPropertyValue.conversationId, input.conversationId),
        ),
      )
    const history = value
      ? await db
          .select({ id: customerPropertyHistory.sourceChannelId })
          .from(customerPropertyHistory)
          .where(eq(customerPropertyHistory.valueId, value.id))
      : []
    const sources = [
      ...(definition.level === 'CUSTOMER' ? identities.map((i) => i.id) : [input.channelId]),
      ...(value ? [value.sourceChannelId] : []),
      ...history.map((h) => h.id),
    ]
    if (
      !(await memoryChannelsAllowed(db, input.workspaceId, input.memberId, [...new Set(sources)]))
    )
      continue
    rules.push({
      id: rule.id,
      revision: rule.revision,
      definitionId: definition.id,
      definitionRevision: definition.revision,
      name: definition.name,
      level: definition.level,
      type: definition.type,
      options: definition.options,
      maxLength: definition.maxLength,
      instructions: rule.instructions,
      valueRevision: value?.revision ?? 0,
    })
  }
  return { customerId: input.customerId, rules }
}
export function sameAiPropertyRules(a: AiPropertyCollection, b: AiPropertyCollection) {
  return (
    a.customerId === b.customerId &&
    a.rules.length === b.rules.length &&
    a.rules.every((r) =>
      b.rules.some(
        (v) =>
          v.id === r.id &&
          v.revision === r.revision &&
          v.definitionRevision === r.definitionRevision,
      ),
    )
  )
}
export type AiCollectedProperty = { definitionId: string; value: string | number }
export function validateAiCollectedProperties(
  rules: AiPropertyCollection['rules'],
  values: AiCollectedProperty[],
) {
  if (values.length > 20 || new Set(values.map((v) => v.definitionId)).size !== values.length)
    throw new AiMemberError('INVALID_REQUEST')
  for (const item of values) {
    const rule = rules.find((r) => r.definitionId === item.definitionId)
    if (!rule || item.value === null) throw new AiMemberError('INVALID_REQUEST')
    validatePropertyValue(rule, item.value)
  }
}
export async function applyAiCollectedProperties(
  tx: Transaction,
  input: {
    workspaceId: string
    memberId: string
    customerId: string
    conversationId: string
    channelId: string
    collection: AiPropertyCollection
    values: AiCollectedProperty[]
  },
) {
  validateAiCollectedProperties(input.collection.rules, input.values)
  const [source] = await tx
    .select({ name: member.displayName })
    .from(member)
    .where(eq(member.id, input.memberId))
  for (const item of input.values) {
    const rule = input.collection.rules.find((r) => r.definitionId === item.definitionId)
    if (!rule) throw new AiMemberError('INVALID_REQUEST')
    const [old] = await tx
      .select()
      .from(customerPropertyValue)
      .where(
        and(
          eq(customerPropertyValue.definitionId, item.definitionId),
          rule.level === 'CUSTOMER'
            ? eq(customerPropertyValue.customerId, input.customerId)
            : eq(customerPropertyValue.conversationId, input.conversationId),
        ),
      )
    if (
      (old?.revision ?? 0) !== rule.valueRevision ||
      (old && !old.allowAutomaticUpdate) ||
      old?.value === item.value
    )
      continue
    const data = {
      value: item.value,
      revision: (old?.revision ?? 0) + 1,
      allowAutomaticUpdate: true,
      sourceMemberId: input.memberId,
      sourceChannelId: input.channelId,
      updatedAt: new Date(),
    }
    const [saved] = old
      ? await tx
          .update(customerPropertyValue)
          .set(data)
          .where(eq(customerPropertyValue.id, old.id))
          .returning()
      : await tx
          .insert(customerPropertyValue)
          .values({
            ...data,
            definitionId: rule.definitionId,
            customerId: rule.level === 'CUSTOMER' ? input.customerId : null,
            conversationId: rule.level === 'CONVERSATION' ? input.conversationId : null,
          })
          .returning()
    await tx.insert(customerPropertyHistory).values({
      valueId: saved.id,
      definitionName: rule.name,
      value: saved.value,
      revision: saved.revision,
      allowAutomaticUpdate: saved.allowAutomaticUpdate,
      sourceMemberId: input.memberId,
      sourceName: source?.name ?? 'Former member',
      sourceChannelId: input.channelId,
    })
  }
}
