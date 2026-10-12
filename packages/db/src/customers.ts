import { and, desc, eq, isNull, or, sql } from 'drizzle-orm'
import { invalidateCustomerMemory, readCustomerMemory } from './customer-memory'
import type { Database } from './database'
import {
  channel,
  channelIdentity,
  conversation,
  customer,
  customerPropertyDefinition,
  customerPropertyHistory,
  customerPropertyValue,
  customerTag,
  customerTagDefinition,
  member,
  memberChannelAccess,
  workspace,
  workspaceUserAccess,
} from './schema'

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0]
export type CustomerContext = { workspaceId: string; userId: string; conversationId: string }
export class CustomerError extends Error {
  constructor(
    public readonly code: 'FORBIDDEN' | 'NOT_FOUND' | 'CONFLICT' | 'INVALID_REQUEST',
    message: string,
  ) {
    super(message)
  }
}

async function access(
  tx: Transaction,
  input: CustomerContext & { expectedCustomerId?: string },
  write = false,
) {
  await tx
    .select({ id: workspace.id })
    .from(workspace)
    .where(eq(workspace.id, input.workspaceId))
    .for('update')
  const [viewer] = await tx
    .select({ id: member.id, role: workspaceUserAccess.role, displayName: member.displayName })
    .from(workspaceUserAccess)
    .innerJoin(member, eq(member.workspaceUserAccessId, workspaceUserAccess.id))
    .where(
      and(
        eq(workspaceUserAccess.workspaceId, input.workspaceId),
        eq(workspaceUserAccess.userId, input.userId),
        eq(member.status, 'ACTIVE'),
      ),
    )
  if (!viewer) throw new CustomerError('FORBIDDEN', 'Workspace access required')
  const [found] = await tx
    .select({ conversation, identity: channelIdentity })
    .from(conversation)
    .innerJoin(channelIdentity, eq(channelIdentity.id, conversation.channelIdentityId))
    .where(
      and(
        eq(conversation.id, input.conversationId),
        eq(conversation.workspaceId, input.workspaceId),
      ),
    )
  if (!found) throw new CustomerError('NOT_FOUND', 'Conversation not found')
  if (write && found.identity.customerId !== input.expectedCustomerId)
    throw new CustomerError('CONFLICT', 'Identity was relinked; refresh before editing')
  if (viewer.role === 'AGENT') {
    const identities = await tx
      .select({ channelId: channelIdentity.channelId })
      .from(channelIdentity)
      .where(
        and(
          eq(channelIdentity.workspaceId, input.workspaceId),
          eq(channelIdentity.customerId, found.identity.customerId),
        ),
      )
    const allowed = await tx
      .select({ channelId: memberChannelAccess.channelId })
      .from(memberChannelAccess)
      .where(eq(memberChannelAccess.memberId, viewer.id))
    if (
      identities.some((i) => !allowed.some((a) => a.channelId === i.channelId)) ||
      (write &&
        (found.conversation.status !== 'OPEN' || found.conversation.assigneeMemberId !== viewer.id))
    ) {
      throw new CustomerError('FORBIDDEN', 'Customer or conversation access required')
    }
    const [profile] = await tx
      .select({ sources: customer.profileSourceChannelIds })
      .from(customer)
      .where(eq(customer.id, found.identity.customerId))
    const sources = await tx.execute<{ source_channel_id: string }>(sql`
      select source_channel_id from ${customerPropertyValue} where customer_id = ${found.identity.customerId} or conversation_id = ${input.conversationId}
      union select h.source_channel_id from ${customerPropertyHistory} h join ${customerPropertyValue} v on v.id = h.value_id where v.customer_id = ${found.identity.customerId} or v.conversation_id = ${input.conversationId}
      union select source_channel_id from ${customerTag} where customer_id = ${found.identity.customerId} or conversation_id = ${input.conversationId}`)
    if (
      [...(profile?.sources ?? []), ...sources.rows.map((r) => r.source_channel_id)].some(
        (id) => !allowed.some((a) => a.channelId === id),
      )
    )
      throw new CustomerError('FORBIDDEN', 'Shared facts include a restricted channel')
  }
  return { ...found, viewer }
}

export async function getCustomerProfile(db: Database, input: CustomerContext) {
  return db.transaction(async (tx) => {
    const found = await access(tx, input)
    const [profile] = await tx
      .select()
      .from(customer)
      .where(
        and(
          eq(customer.id, found.identity.customerId),
          eq(customer.workspaceId, input.workspaceId),
        ),
      )
    const definitions = await tx
      .select()
      .from(customerPropertyDefinition)
      .where(
        and(
          eq(customerPropertyDefinition.workspaceId, input.workspaceId),
          isNull(customerPropertyDefinition.deletedAt),
        ),
      )
    const target = or(
      eq(customerPropertyValue.customerId, found.identity.customerId),
      eq(customerPropertyValue.conversationId, input.conversationId),
    )
    const values = await tx.select().from(customerPropertyValue).where(target)
    const tagDefinitions = await tx
      .select()
      .from(customerTagDefinition)
      .where(eq(customerTagDefinition.workspaceId, input.workspaceId))
    const tags = await tx
      .select()
      .from(customerTag)
      .where(
        or(
          eq(customerTag.customerId, found.identity.customerId),
          eq(customerTag.conversationId, input.conversationId),
        ),
      )
    const historyPage = await readPropertyHistory(
      tx,
      found.identity.customerId,
      input.conversationId,
    )
    const identities = await tx
      .select({
        id: channelIdentity.id,
        channelId: channel.id,
        channelName: channel.displayName,
        customerId: channelIdentity.customerId,
      })
      .from(channelIdentity)
      .innerJoin(channel, eq(channel.id, channelIdentity.channelId))
      .where(
        and(
          eq(channelIdentity.workspaceId, input.workspaceId),
          eq(channelIdentity.customerId, found.identity.customerId),
        ),
      )
    return {
      customer: profile,
      memory: await readCustomerMemory(tx, {
        workspaceId: input.workspaceId,
        customerId: found.identity.customerId,
        memberId: found.viewer.id,
      }),
      definitions,
      values,
      ...historyPage,
      tagDefinitions,
      tags,
      identities,
      currentIdentityId: found.identity.id,
    }
  })
}

async function readPropertyHistory(
  tx: Transaction,
  customerId: string,
  conversationId: string,
  before?: string,
) {
  const target = or(
    eq(customerPropertyValue.customerId, customerId),
    eq(customerPropertyValue.conversationId, conversationId),
  )
  let cursor: { id: string; createdAt: Date } | undefined
  if (before) {
    ;[cursor] = await tx
      .select({ id: customerPropertyHistory.id, createdAt: customerPropertyHistory.createdAt })
      .from(customerPropertyHistory)
      .innerJoin(
        customerPropertyValue,
        eq(customerPropertyValue.id, customerPropertyHistory.valueId),
      )
      .where(and(target, eq(customerPropertyHistory.id, before)))
    if (!cursor) throw new CustomerError('NOT_FOUND', 'History cursor not found')
  }
  const history = await tx
    .select({
      id: customerPropertyHistory.id,
      valueId: customerPropertyHistory.valueId,
      definitionName: customerPropertyHistory.definitionName,
      value: customerPropertyHistory.value,
      revision: customerPropertyHistory.revision,
      allowAutomaticUpdate: customerPropertyHistory.allowAutomaticUpdate,
      sourceMemberId: customerPropertyHistory.sourceMemberId,
      sourceChannelId: customerPropertyHistory.sourceChannelId,
      sourceName: customerPropertyHistory.sourceName,
      createdAt: customerPropertyHistory.createdAt,
    })
    .from(customerPropertyHistory)
    .innerJoin(customerPropertyValue, eq(customerPropertyValue.id, customerPropertyHistory.valueId))
    .where(
      and(
        target,
        cursor
          ? sql`(${customerPropertyHistory.createdAt}, ${customerPropertyHistory.id}) < (select created_at, id from ${customerPropertyHistory} where id = ${cursor.id})`
          : undefined,
      ),
    )
    .orderBy(desc(customerPropertyHistory.createdAt), desc(customerPropertyHistory.id))
    .limit(101)
  return {
    history: history.slice(0, 100),
    nextHistoryCursor: history.length > 100 ? history[99].id : null,
  }
}

export async function listCustomerPropertyHistory(
  db: Database,
  input: CustomerContext & { before?: string },
) {
  return db.transaction(async (tx) => {
    const found = await access(tx, input)
    return readPropertyHistory(tx, found.identity.customerId, input.conversationId, input.before)
  })
}

export type PropertyDefinitionInput = {
  name: string
  level: 'CUSTOMER' | 'CONVERSATION'
  type: 'TEXT' | 'NUMBER' | 'OPTION'
  options: string[]
  maxLength: number
}

export async function listCustomerLinkTargets(
  db: Database,
  input: CustomerContext & { after?: string },
) {
  return db.transaction(async (tx) => {
    const found = await access(tx, input)
    requireManager(found.viewer)
    const customers = await tx
      .select({ id: customer.id, displayName: customer.displayName })
      .from(customer)
      .where(
        and(
          eq(customer.workspaceId, input.workspaceId),
          sql`${customer.id} <> ${found.identity.customerId}`,
          input.after ? sql`${customer.id} > ${input.after}::uuid` : undefined,
        ),
      )
      .orderBy(customer.id)
      .limit(101)
    return {
      customers: customers.slice(0, 100),
      nextCursor: customers.length > 100 ? customers[99].id : null,
    }
  })
}
export async function changeCustomerIdentity(
  db: Database,
  input: CustomerContext & {
    identityId: string
    targetCustomerId: string | null
    expectedCustomerId: string
    confirmed?: boolean
    preview?: boolean
  },
) {
  return db.transaction(async (tx) => {
    const found = await access(tx, input)
    requireManager(found.viewer)
    const [identity] = await tx
      .select()
      .from(channelIdentity)
      .where(
        and(
          eq(channelIdentity.id, input.identityId),
          eq(channelIdentity.workspaceId, input.workspaceId),
        ),
      )
      .for('update')
    if (!identity || identity.customerId !== found.identity.customerId)
      throw new CustomerError('NOT_FOUND', 'Identity not found')
    if (identity.customerId !== input.expectedCustomerId)
      throw new CustomerError('CONFLICT', 'Identity was relinked; refresh before confirming')
    let target: { id: string; displayName: string | null } | undefined
    if (input.targetCustomerId) {
      ;[target] = await tx
        .select({ id: customer.id, displayName: customer.displayName })
        .from(customer)
        .where(
          and(eq(customer.id, input.targetCustomerId), eq(customer.workspaceId, input.workspaceId)),
        )
      if (!target) throw new CustomerError('NOT_FOUND', 'Target customer not found')
      if (target.id === identity.customerId)
        throw new CustomerError('INVALID_REQUEST', 'Identity is already linked to this customer')
    }
    const [counts] = await tx
      .select({ conversations: sql<number>`count(*)::int` })
      .from(conversation)
      .where(eq(conversation.channelIdentityId, identity.id))
    if (input.preview)
      return {
        impact: {
          identityId: identity.id,
          sourceCustomerId: identity.customerId,
          targetCustomer: target ?? null,
          conversations: counts.conversations,
          sharesCustomerFacts: Boolean(target),
          preservesMessages: true,
          preservesAssignment: true,
          preservesSendEligibility: true,
        },
      }
    if (!input.confirmed)
      throw new CustomerError('INVALID_REQUEST', 'Explicit confirmation required')
    if (!target) {
      ;[target] = await tx
        .insert(customer)
        .values({ workspaceId: input.workspaceId })
        .returning({ id: customer.id, displayName: customer.displayName })
    }
    await invalidateCustomerMemory(tx, {
      workspaceId: input.workspaceId,
      customerId: identity.customerId,
      clear: true,
    })
    await invalidateCustomerMemory(tx, {
      workspaceId: input.workspaceId,
      customerId: target.id,
      clear: false,
    })
    await tx
      .update(channelIdentity)
      .set({ customerId: target.id, updatedAt: new Date() })
      .where(eq(channelIdentity.id, identity.id))
    return { customerId: target.id, identityId: identity.id }
  })
}

export async function clearCustomerMemory(
  db: Database,
  input: CustomerContext & { expectedCustomerId: string; expectedRevision: number },
) {
  return db.transaction(async (tx) => {
    const found = await access(tx, input)
    requireManager(found.viewer)
    if (found.identity.customerId !== input.expectedCustomerId)
      throw new CustomerError('CONFLICT', 'Identity changed')
    const memory = await readCustomerMemory(tx, {
      workspaceId: input.workspaceId,
      customerId: found.identity.customerId,
      memberId: found.viewer.id,
    })
    if (!memory.available)
      throw new CustomerError('FORBIDDEN', 'Memory includes a restricted channel')
    if (memory.revision !== input.expectedRevision)
      throw new CustomerError('CONFLICT', 'Memory changed; refresh before clearing')
    const cleared = await invalidateCustomerMemory(tx, {
      workspaceId: input.workspaceId,
      customerId: found.identity.customerId,
      clear: true,
      expectedRevision: input.expectedRevision,
    })
    if (!cleared) throw new CustomerError('CONFLICT', 'Memory changed; refresh before clearing')
    return { cleared: true }
  })
}

export async function saveCustomerTagDefinition(
  db: Database,
  input: CustomerContext & { name: string; level: 'CUSTOMER' | 'CONVERSATION'; tagId?: string },
) {
  if (
    !input.name.trim() ||
    input.name.length > 100 ||
    !['CUSTOMER', 'CONVERSATION'].includes(input.level)
  )
    throw new CustomerError('INVALID_REQUEST', 'Invalid tag definition')
  return db.transaction(async (tx) => {
    const found = await access(tx, input)
    requireManager(found.viewer)
    const duplicates = await tx
      .select({ id: customerTagDefinition.id })
      .from(customerTagDefinition)
      .where(
        and(
          eq(customerTagDefinition.workspaceId, input.workspaceId),
          eq(customerTagDefinition.level, input.level),
          sql`lower(${customerTagDefinition.name}) = lower(${input.name.trim()})`,
        ),
      )
    if (duplicates.some((d) => d.id !== input.tagId))
      throw new CustomerError('CONFLICT', 'Tag name already exists')
    if (input.tagId) {
      const [old] = await tx
        .select()
        .from(customerTagDefinition)
        .where(
          and(
            eq(customerTagDefinition.id, input.tagId),
            eq(customerTagDefinition.workspaceId, input.workspaceId),
          ),
        )
      if (!old) throw new CustomerError('NOT_FOUND', 'Tag not found')
      if (old.level !== input.level)
        throw new CustomerError('INVALID_REQUEST', 'Tag level is immutable')
      const [tag] = await tx
        .update(customerTagDefinition)
        .set({ name: input.name.trim() })
        .where(eq(customerTagDefinition.id, old.id))
        .returning()
      return { tag }
    }
    const [tag] = await tx
      .insert(customerTagDefinition)
      .values({ workspaceId: input.workspaceId, name: input.name.trim(), level: input.level })
      .returning()
    return { tag }
  })
}
export async function removeCustomerTagDefinition(
  db: Database,
  input: CustomerContext & { tagId: string },
) {
  return db.transaction(async (tx) => {
    const found = await access(tx, input)
    requireManager(found.viewer)
    const deleted = await tx
      .delete(customerTagDefinition)
      .where(
        and(
          eq(customerTagDefinition.id, input.tagId),
          eq(customerTagDefinition.workspaceId, input.workspaceId),
        ),
      )
      .returning({ id: customerTagDefinition.id })
    if (!deleted.length) throw new CustomerError('NOT_FOUND', 'Tag not found')
    return { deleted: true }
  })
}
export async function setCustomerTag(
  db: Database,
  input: CustomerContext & { tagId: string; remove?: boolean; expectedCustomerId: string },
) {
  return db.transaction(async (tx) => {
    const found = await access(tx, input, true)
    const [tag] = await tx
      .select()
      .from(customerTagDefinition)
      .where(
        and(
          eq(customerTagDefinition.id, input.tagId),
          eq(customerTagDefinition.workspaceId, input.workspaceId),
        ),
      )
    if (!tag) throw new CustomerError('NOT_FOUND', 'Tag not found')
    const customerId = tag.level === 'CUSTOMER' ? found.identity.customerId : null
    const conversationId = tag.level === 'CONVERSATION' ? input.conversationId : null
    if (input.remove)
      await tx
        .delete(customerTag)
        .where(
          and(
            eq(customerTag.tagId, tag.id),
            customerId
              ? eq(customerTag.customerId, customerId)
              : eq(customerTag.conversationId, input.conversationId),
          ),
        )
    else
      await tx
        .insert(customerTag)
        .values({
          tagId: tag.id,
          customerId,
          conversationId,
          sourceMemberId: found.viewer.id,
          sourceChannelId: found.identity.channelId,
        })
        .onConflictDoNothing()
    return { saved: true }
  })
}

function validateDefinition(input: PropertyDefinitionInput) {
  if (
    !input.name.trim() ||
    input.name.length > 100 ||
    !['CUSTOMER', 'CONVERSATION'].includes(input.level) ||
    !['TEXT', 'NUMBER', 'OPTION'].includes(input.type) ||
    !Number.isInteger(input.maxLength) ||
    input.maxLength < 1 ||
    input.maxLength > 2000 ||
    input.options.length > 50 ||
    input.options.some((o) => !o.trim() || o.length > 100) ||
    new Set(input.options).size !== input.options.length ||
    (input.type === 'OPTION' && !input.options.length) ||
    (input.type !== 'OPTION' && input.options.length)
  )
    throw new CustomerError('INVALID_REQUEST', 'Invalid property definition')
}
function validateValue(definition: PropertyDefinitionInput, value: string | number | null) {
  if (value === null) return
  if (
    definition.type === 'NUMBER'
      ? typeof value !== 'number' || !Number.isFinite(value)
      : typeof value !== 'string' ||
        value.length > definition.maxLength ||
        (definition.type === 'OPTION' && !definition.options.includes(value))
  )
    throw new CustomerError('INVALID_REQUEST', 'Value does not match property definition')
}
function requireManager(viewer: { role: string }) {
  if (viewer.role === 'AGENT') throw new CustomerError('FORBIDDEN', 'Administrator access required')
}
export async function savePropertyDefinition(
  db: Database,
  input: CustomerContext &
    PropertyDefinitionInput & { definitionId?: string; expectedRevision?: number },
) {
  validateDefinition(input)
  return db.transaction(async (tx) => {
    const found = await access(tx, input)
    requireManager(found.viewer)
    const duplicate = await tx
      .select({ id: customerPropertyDefinition.id })
      .from(customerPropertyDefinition)
      .where(
        and(
          eq(customerPropertyDefinition.workspaceId, input.workspaceId),
          eq(customerPropertyDefinition.level, input.level),
          sql`lower(${customerPropertyDefinition.name}) = lower(${input.name.trim()})`,
          isNull(customerPropertyDefinition.deletedAt),
        ),
      )
    if (duplicate.some((d) => d.id !== input.definitionId))
      throw new CustomerError('CONFLICT', 'Property name already exists')
    if (!input.definitionId) {
      const [definition] = await tx
        .insert(customerPropertyDefinition)
        .values({
          workspaceId: input.workspaceId,
          name: input.name.trim(),
          level: input.level,
          type: input.type,
          options: input.options,
          maxLength: input.maxLength,
        })
        .returning()
      return { definition }
    }
    const [old] = await tx
      .select()
      .from(customerPropertyDefinition)
      .where(
        and(
          eq(customerPropertyDefinition.id, input.definitionId),
          eq(customerPropertyDefinition.workspaceId, input.workspaceId),
          isNull(customerPropertyDefinition.deletedAt),
        ),
      )
    if (!old) throw new CustomerError('NOT_FOUND', 'Property not found')
    if (old.level !== input.level || old.type !== input.type)
      throw new CustomerError('INVALID_REQUEST', 'Property level and type are immutable')
    if (old.revision !== input.expectedRevision)
      throw new CustomerError('CONFLICT', 'Definition was changed; refresh before saving')
    const existing = await tx
      .select({ value: customerPropertyValue.value })
      .from(customerPropertyValue)
      .where(eq(customerPropertyValue.definitionId, old.id))
    for (const v of existing) validateValue(input, v.value)
    const [definition] = await tx
      .update(customerPropertyDefinition)
      .set({
        name: input.name.trim(),
        options: input.options,
        maxLength: input.maxLength,
        revision: old.revision + 1,
      })
      .where(eq(customerPropertyDefinition.id, old.id))
      .returning()
    return { definition }
  })
}
export async function propertyDependencies(
  db: Database,
  input: CustomerContext & { definitionId: string; remove?: boolean },
) {
  return db.transaction(async (tx) => {
    const found = await access(tx, input)
    requireManager(found.viewer)
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
    if (!definition) throw new CustomerError('NOT_FOUND', 'Property not found')
    const [counts] = await tx
      .select({ values: sql<number>`count(*)::int` })
      .from(customerPropertyValue)
      .where(
        and(
          eq(customerPropertyValue.definitionId, input.definitionId),
          sql`${customerPropertyValue.value} is not null`,
        ),
      )
    if (input.remove) {
      if (counts.values)
        throw new CustomerError(
          'CONFLICT',
          'Clear referenced property values before deleting the definition',
        )
      await tx
        .update(customerPropertyDefinition)
        .set({ deletedAt: new Date(), revision: definition.revision + 1 })
        .where(eq(customerPropertyDefinition.id, definition.id))
    }
    return { dependencies: counts }
  })
}
export async function setCustomerProperty(
  db: Database,
  input: CustomerContext & {
    definitionId: string
    expectedCustomerId: string
    expectedRevision: number
    value: string | number | null
    allowAutomaticUpdate: boolean
  },
) {
  return db.transaction(async (tx) => {
    const found = await access(tx, input, true)
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
    if (!definition) throw new CustomerError('NOT_FOUND', 'Property not found')
    validateValue(definition, input.value)
    if (
      !Number.isInteger(input.expectedRevision) ||
      input.expectedRevision < 0 ||
      typeof input.allowAutomaticUpdate !== 'boolean'
    )
      throw new CustomerError('INVALID_REQUEST', 'Invalid property revision or protection')
    const customerId = definition.level === 'CUSTOMER' ? found.identity.customerId : null
    const conversationId = definition.level === 'CONVERSATION' ? input.conversationId : null
    const [old] = await tx
      .select()
      .from(customerPropertyValue)
      .where(
        and(
          eq(customerPropertyValue.definitionId, definition.id),
          customerId
            ? eq(customerPropertyValue.customerId, customerId)
            : eq(customerPropertyValue.conversationId, input.conversationId),
        ),
      )
    if ((old?.revision ?? 0) !== input.expectedRevision)
      throw new CustomerError('CONFLICT', 'Property was changed; refresh before saving')
    const data = {
      value: input.value,
      revision: input.expectedRevision + 1,
      allowAutomaticUpdate: input.allowAutomaticUpdate,
      sourceMemberId: found.viewer.id,
      sourceChannelId: found.identity.channelId,
      updatedAt: new Date(),
    }
    const [value] = old
      ? await tx
          .update(customerPropertyValue)
          .set(data)
          .where(eq(customerPropertyValue.id, old.id))
          .returning()
      : await tx
          .insert(customerPropertyValue)
          .values({ ...data, definitionId: definition.id, customerId, conversationId })
          .returning()
    await tx.insert(customerPropertyHistory).values({
      valueId: value.id,
      definitionName: definition.name,
      value: value.value,
      revision: value.revision,
      allowAutomaticUpdate: value.allowAutomaticUpdate,
      sourceMemberId: value.sourceMemberId,
      sourceName: found.viewer.displayName ?? 'Former member',
      sourceChannelId: value.sourceChannelId,
    })
    return { value }
  })
}

export type CustomerProfilePatch = {
  expectedCustomerId: string
  expectedRevision: number
  displayName?: string | null
  email?: string | null
  phone?: string | null
  preferredLanguage?: string | null
  notes?: string | null
  ownerMemberId?: string | null
}
export async function updateCustomerProfile(
  db: Database,
  input: CustomerContext & CustomerProfilePatch,
) {
  return db.transaction(async (tx) => {
    const found = await access(tx, input, true)
    const { expectedRevision, displayName, email, phone, preferredLanguage, notes, ownerMemberId } =
      input
    for (const [value, limit] of [
      [displayName, 100],
      [email, 254],
      [phone, 50],
      [preferredLanguage, 100],
      [notes, 2000],
    ] as const) {
      if (value != null && (typeof value !== 'string' || value.length > limit))
        throw new CustomerError('INVALID_REQUEST', 'Invalid customer field')
    }
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0)
      throw new CustomerError('INVALID_REQUEST', 'Invalid revision')
    if (ownerMemberId) {
      const [owner] = await tx
        .select({ id: member.id })
        .from(member)
        .where(
          and(
            eq(member.id, ownerMemberId),
            eq(member.workspaceId, input.workspaceId),
            eq(member.type, 'HUMAN'),
            eq(member.status, 'ACTIVE'),
          ),
        )
      if (!owner) throw new CustomerError('INVALID_REQUEST', 'Active human owner required')
    }
    const [profile] = await tx
      .select({ sources: customer.profileSourceChannelIds })
      .from(customer)
      .where(eq(customer.id, found.identity.customerId))
    const [saved] = await tx
      .update(customer)
      .set({
        displayName,
        email,
        phone,
        preferredLanguage,
        notes,
        ownerMemberId,
        profileSourceChannelIds: [...new Set([...profile.sources, found.identity.channelId])],
        profileRevision: sql`${customer.profileRevision} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(customer.id, found.identity.customerId),
          eq(customer.workspaceId, input.workspaceId),
          eq(customer.profileRevision, expectedRevision),
        ),
      )
      .returning()
    if (!saved) throw new CustomerError('CONFLICT', 'Customer was changed; refresh before saving')
    return { customer: saved }
  })
}
