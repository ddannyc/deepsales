import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { type AiVariableInput, instructionVariableKeys } from './ai-variables'
import { memoryChannelsAllowed } from './customer-memory'
import type { Database } from './database'
import {
  type AiTestCustomer,
  aiResponseRun,
  channelIdentity,
  conversation,
  customer,
  customerPropertyDefinition,
  customerPropertyHistory,
  customerPropertyValue,
  customerTag,
  customerTagDefinition,
} from './schema'

type Handle = Database | Parameters<Parameters<Database['transaction']>[0]>[0]

// Callers use the same workspace/conversation locks as fact edits and reply commits.
export async function readAiVariableInput(
  db: Handle,
  input: {
    workspaceId: string
    viewerMemberId?: string
    conversationId: string
    memberId: string
    instructions: string
    timeZone: string
    context: string
    now?: Date
  },
): Promise<AiVariableInput> {
  const allowed = async (sources: string[]) =>
    (await memoryChannelsAllowed(db, input.workspaceId, input.memberId, sources)) &&
    (!input.viewerMemberId ||
      (await memoryChannelsAllowed(db, input.workspaceId, input.viewerMemberId, sources)))
  const keys = instructionVariableKeys(input.instructions)
  const now = input.now ?? new Date()
  const result: AiVariableInput = { version: 1, capturedAt: now.toISOString(), values: {} }
  if (!keys.length) return result
  const [target] = await db
    .select({ identity: channelIdentity, thread: conversation })
    .from(conversation)
    .innerJoin(channelIdentity, eq(channelIdentity.id, conversation.channelIdentityId))
    .where(
      and(
        eq(conversation.id, input.conversationId),
        eq(conversation.workspaceId, input.workspaceId),
        eq(channelIdentity.workspaceId, input.workspaceId),
      ),
    )
  if (!target || !(await allowed([target.identity.channelId])))
    throw new Error('Variable access revoked')
  const [person] = await db
    .select()
    .from(customer)
    .where(
      and(eq(customer.id, target.identity.customerId), eq(customer.workspaceId, input.workspaceId)),
    )
  if (!person) throw new Error('Variable customer unavailable')
  const identities = await db
    .select({ id: channelIdentity.channelId })
    .from(channelIdentity)
    .where(
      and(
        eq(channelIdentity.customerId, person.id),
        eq(channelIdentity.workspaceId, input.workspaceId),
      ),
    )
  const profileSources = [
    ...new Set([...identities.map((i) => i.id), ...person.profileSourceChannelIds]),
  ]
  const shared = await allowed(profileSources)
  result.source = {
    customerId: person.id,
    channelIds: [target.identity.channelId],
    profileRevision: person.profileRevision,
    customerTagRevision: person.tagRevision,
    conversationTagRevision: target.thread.tagRevision,
    properties: [],
  }
  for (const key of keys) {
    let value: AiVariableInput['values'][typeof key] = null
    if (key === 'system.now')
      value = new Intl.DateTimeFormat('sv-SE', {
        timeZone: input.timeZone,
        dateStyle: 'short',
        timeStyle: 'long',
      }).format(now)
    else if (key === 'system.timeZone') value = input.timeZone
    else if (key === 'conversation.context') value = input.context
    else if (key === 'conversation.replyCount') {
      const [count] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(aiResponseRun)
        .where(
          and(
            eq(aiResponseRun.conversationId, input.conversationId),
            eq(aiResponseRun.state, 'COMPLETED'),
          ),
        )
      value = count.n
    } else if (
      ['customer.name', 'customer.email', 'customer.phone', 'customer.language'].includes(key)
    ) {
      if (shared) {
        value =
          key === 'customer.name'
            ? person.displayName
            : key === 'customer.email'
              ? person.email
              : key === 'customer.phone'
                ? person.phone
                : person.preferredLanguage
        result.source.channelIds = [...new Set([...result.source.channelIds, ...profileSources])]
      }
    } else {
      const customerLevel = key.startsWith('customer.')
      if (customerLevel && !shared) {
        result.values[key] = null
        continue
      }
      if (key.endsWith('.properties')) {
        const values = await db
          .select({ value: customerPropertyValue, definition: customerPropertyDefinition })
          .from(customerPropertyValue)
          .innerJoin(
            customerPropertyDefinition,
            eq(customerPropertyDefinition.id, customerPropertyValue.definitionId),
          )
          .where(
            and(
              eq(customerPropertyDefinition.workspaceId, input.workspaceId),
              isNull(customerPropertyDefinition.deletedAt),
              customerLevel
                ? eq(customerPropertyValue.customerId, person.id)
                : eq(customerPropertyValue.conversationId, input.conversationId),
            ),
          )
          .orderBy(asc(customerPropertyDefinition.id))
          .limit(20)
        const authorized: { name: string; value: string | number | null }[] = []
        for (const item of values) {
          const history = await db
            .select({ id: customerPropertyHistory.sourceChannelId })
            .from(customerPropertyHistory)
            .where(eq(customerPropertyHistory.valueId, item.value.id))
          const sources = [
            item.value.sourceChannelId,
            ...history.map((h) => h.id),
            ...(customerLevel ? profileSources : []),
          ]
          if (!(await allowed(sources))) continue
          authorized.push({ name: item.definition.name, value: item.value.value })
          result.source.properties.push({
            id: item.value.id,
            revision: item.value.revision,
            definitionRevision: item.definition.revision,
          })
          result.source.channelIds = [...new Set([...result.source.channelIds, ...sources])]
        }
        value = authorized
      } else if (key.endsWith('.tags')) {
        const tags = await db
          .select({ name: customerTagDefinition.name, source: customerTag.sourceChannelId })
          .from(customerTag)
          .innerJoin(customerTagDefinition, eq(customerTagDefinition.id, customerTag.tagId))
          .where(
            and(
              eq(customerTagDefinition.workspaceId, input.workspaceId),
              customerLevel
                ? eq(customerTag.customerId, person.id)
                : eq(customerTag.conversationId, input.conversationId),
            ),
          )
          .orderBy(asc(customerTagDefinition.id))
          .limit(50)
        const authorized: string[] = []
        for (const tag of tags) {
          if (!(await allowed([tag.source]))) continue
          authorized.push(tag.name)
          result.source.channelIds = [
            ...new Set([
              ...result.source.channelIds,
              tag.source,
              ...(customerLevel ? profileSources : []),
            ]),
          ]
        }
        value = authorized
      }
    }
    result.values[key] = value
  }
  if (result.source) result.source.channelIds.sort()
  return result
}

export async function readAiTestVariableInput(
  db: Handle,
  input: {
    workspaceId: string
    instructions: string
    timeZone: string
    text: string
    customer?: AiTestCustomer
    history?: { text: string; direction: string }[]
    now?: Date
  },
): Promise<AiVariableInput> {
  const now = input.now ?? new Date()
  const result: AiVariableInput = { version: 1, capturedAt: now.toISOString(), values: {} }
  const simulated = input.customer
  const properties = simulated?.properties.length
    ? await db
        .select()
        .from(customerPropertyDefinition)
        .where(
          and(
            eq(customerPropertyDefinition.workspaceId, input.workspaceId),
            isNull(customerPropertyDefinition.deletedAt),
            inArray(
              customerPropertyDefinition.id,
              simulated.properties.map((p) => p.definitionId),
            ),
          ),
        )
        .orderBy(asc(customerPropertyDefinition.id))
        .limit(20)
    : []
  const tags = simulated?.tags.length
    ? await db
        .select()
        .from(customerTagDefinition)
        .where(
          and(
            eq(customerTagDefinition.workspaceId, input.workspaceId),
            inArray(customerTagDefinition.id, simulated.tags),
          ),
        )
        .orderBy(asc(customerTagDefinition.id))
        .limit(50)
    : []
  for (const key of instructionVariableKeys(input.instructions)) {
    result.values[key] =
      key === 'system.now'
        ? new Intl.DateTimeFormat('sv-SE', {
            timeZone: input.timeZone,
            dateStyle: 'short',
            timeStyle: 'long',
          }).format(now)
        : key === 'system.timeZone'
          ? input.timeZone
          : key === 'conversation.context'
            ? [...(input.history ?? []).map((m) => m.text), input.text].join('\n')
            : key === 'conversation.replyCount'
              ? (input.history ?? []).filter((m) => m.direction === 'OUTBOUND').length
              : key === 'customer.language'
                ? simulated?.language || null
                : key.endsWith('.properties')
                  ? properties
                      .filter(
                        (p) =>
                          p.level === (key.startsWith('customer.') ? 'CUSTOMER' : 'CONVERSATION'),
                      )
                      .map((p) => ({
                        name: p.name,
                        value:
                          simulated?.properties.find((v) => v.definitionId === p.id)?.value ?? null,
                      }))
                  : key.endsWith('.tags')
                    ? tags
                        .filter(
                          (t) =>
                            t.level === (key.startsWith('customer.') ? 'CUSTOMER' : 'CONVERSATION'),
                        )
                        .map((t) => t.name)
                    : null
  }
  return result
}

export function sameAiVariableSources(a: AiVariableInput, b: AiVariableInput) {
  function ordered(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(ordered)
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, item]) => [key, ordered(item)]),
      )
    return value
  }
  const withoutClock = (value: AiVariableInput) => ({
    source: value.source,
    values: { ...value.values, 'system.now': undefined, 'system.timeZone': undefined },
  })
  return JSON.stringify(ordered(withoutClock(a))) === JSON.stringify(ordered(withoutClock(b)))
}
