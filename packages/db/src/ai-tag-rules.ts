import { and, asc, eq, sql } from 'drizzle-orm'
import { AiMemberError, assertAiManager } from './ai-members'
import { memoryChannelsAllowed } from './customer-memory'
import type { Database } from './database'
import {
  type AiTagCollection,
  aiTagRule,
  channelIdentity,
  conversation,
  customer,
  customerTag,
  customerTagDefinition,
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
export async function listAiTagRules(db: Handle, input: Identity) {
  await assertTarget(db, input)
  return db
    .select()
    .from(aiTagRule)
    .where(
      and(eq(aiTagRule.workspaceId, input.workspaceId), eq(aiTagRule.memberId, input.memberId)),
    )
    .orderBy(asc(aiTagRule.id))
}
export async function saveAiTagRule(
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
      .from(customerTagDefinition)
      .where(
        and(
          eq(customerTagDefinition.id, input.definitionId),
          eq(customerTagDefinition.workspaceId, input.workspaceId),
        ),
      )
    if (!definition) throw new AiMemberError('INVALID_CONFIGURATION')
    const rules = await listAiTagRules(tx, input)
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
      ? await tx.update(aiTagRule).set(data).where(eq(aiTagRule.id, old.id)).returning()
      : await tx
          .insert(aiTagRule)
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
export async function deleteAiTagRule(
  db: Database,
  input: Identity & { id: string; revision: number },
) {
  await db.transaction(async (tx) => {
    await tx.execute(sql`select id from ${workspace} where id = ${input.workspaceId} for update`)
    await assertTarget(tx, input)
    const removed = await tx
      .delete(aiTagRule)
      .where(
        and(
          eq(aiTagRule.id, input.id),
          eq(aiTagRule.workspaceId, input.workspaceId),
          eq(aiTagRule.memberId, input.memberId),
          eq(aiTagRule.revision, input.revision),
        ),
      )
      .returning()
    if (!removed.length) throw new AiMemberError('INVALID_REQUEST')
  })
}
export async function readAiTagRules(db: Handle, workspaceId: string, memberId: string) {
  return db
    .select({ rule: aiTagRule, definition: customerTagDefinition })
    .from(aiTagRule)
    .innerJoin(customerTagDefinition, eq(customerTagDefinition.id, aiTagRule.definitionId))
    .where(
      and(
        eq(aiTagRule.workspaceId, workspaceId),
        eq(aiTagRule.memberId, memberId),
        eq(aiTagRule.enabled, true),
        eq(customerTagDefinition.workspaceId, workspaceId),
      ),
    )
    .orderBy(asc(aiTagRule.id))
}

export async function readAiTestTagRules(
  db: Handle,
  workspaceId: string,
  memberId: string,
): Promise<AiTagCollection['rules']> {
  return (await readAiTagRules(db, workspaceId, memberId)).map(({ rule, definition }) => ({
    id: rule.id,
    definitionId: definition.id,
    revision: rule.revision,
    name: definition.name,
    level: definition.level,
    instructions: rule.instructions,
  }))
}
export async function readAiTagCollection(
  db: Handle,
  input: {
    workspaceId: string
    memberId: string
    customerId: string
    conversationId: string
    channelId: string
  },
): Promise<AiTagCollection> {
  const [person] = await db
    .select({ revision: customer.tagRevision })
    .from(customer)
    .where(and(eq(customer.id, input.customerId), eq(customer.workspaceId, input.workspaceId)))
  const [thread] = await db
    .select({ revision: conversation.tagRevision })
    .from(conversation)
    .where(
      and(
        eq(conversation.id, input.conversationId),
        eq(conversation.workspaceId, input.workspaceId),
      ),
    )
  const identities = await db
    .select({ id: channelIdentity.channelId })
    .from(channelIdentity)
    .where(
      and(
        eq(channelIdentity.customerId, input.customerId),
        eq(channelIdentity.workspaceId, input.workspaceId),
      ),
    )
  const rules: AiTagCollection['rules'] = []
  for (const rule of await readAiTestTagRules(db, input.workspaceId, input.memberId)) {
    const allowed = await memoryChannelsAllowed(
      db,
      input.workspaceId,
      input.memberId,
      rule.level === 'CUSTOMER' ? identities.map((i) => i.id) : [input.channelId],
    )
    if (allowed) rules.push(rule)
  }
  return {
    customerId: input.customerId,
    customerRevision: person?.revision ?? 0,
    conversationRevision: thread?.revision ?? 0,
    rules,
  }
}
export function sameAiTagRules(a: AiTagCollection, b: AiTagCollection) {
  return (
    a.customerId === b.customerId &&
    a.rules.length === b.rules.length &&
    a.rules.every((r) =>
      b.rules.some((v) => v.id === r.id && v.revision === r.revision && v.name === r.name),
    )
  )
}
export async function applyAiTags(
  tx: Transaction,
  input: {
    workspaceId: string
    memberId: string
    customerId: string
    conversationId: string
    channelId: string
    collection: AiTagCollection
    values: string[]
  },
) {
  if (
    input.collection.customerId !== input.customerId ||
    new Set(input.values).size !== input.values.length ||
    input.values.some((id) => !input.collection.rules.some((r) => r.definitionId === id))
  )
    throw new AiMemberError('INVALID_REQUEST')
  const current = await readAiTagCollection(tx, input)
  for (const id of input.values) {
    const rule = input.collection.rules.find((r) => r.definitionId === id)
    if (
      !rule ||
      (rule.level === 'CUSTOMER'
        ? current.customerRevision !== input.collection.customerRevision
        : current.conversationRevision !== input.collection.conversationRevision)
    )
      continue
    await tx
      .insert(customerTag)
      .values({
        tagId: id,
        customerId: rule.level === 'CUSTOMER' ? input.customerId : null,
        conversationId: rule.level === 'CONVERSATION' ? input.conversationId : null,
        sourceMemberId: input.memberId,
        sourceChannelId: input.channelId,
      })
      .onConflictDoNothing()
  }
}
