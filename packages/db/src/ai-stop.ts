import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import type { Database } from './database'
import {
  aiResponseRun,
  channel,
  customerPropertyDefinition,
  customerPropertyValue,
  customerTag,
  customerTagDefinition,
  mediaAsset,
  memberChannelAccess,
  type AiStopRules,
} from './schema'

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0]
export const EMPTY_AI_STOP_RULES: AiStopRules = {
  groups: [],
  periods: [],
  endingText: '',
  endingMediaAssetId: null,
}

export function normalizeAiStopRules(rules: AiStopRules): AiStopRules {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  const time = /^(?:[01]\d|2[0-3]):[0-5]\d$/
  if (
    !rules ||
    !Array.isArray(rules.groups) ||
    rules.groups.length > 10 ||
    !Array.isArray(rules.periods) ||
    rules.periods.length > 28 ||
    typeof rules.endingText !== 'string' ||
    Array.from(rules.endingText).length > 2000 ||
    (rules.endingMediaAssetId !== null && !uuid.test(rules.endingMediaAssetId))
  )
    throw new Error('Invalid stop rules')
  for (const group of rules.groups) {
    if (!Array.isArray(group) || !group.length || group.length > 10)
      throw new Error('Invalid stop group')
    for (const c of group) {
      if (
        !c ||
        (c.kind === 'REPLIES'
          ? !Number.isInteger(c.minimum) || c.minimum < 0 || c.minimum > 10000
          : c.kind === 'TAG'
            ? !uuid.test(c.tagId)
            : c.kind === 'PROPERTY'
              ? !uuid.test(c.definitionId) ||
                !(
                  (typeof c.value === 'string' && c.value.length <= 2000) ||
                  (typeof c.value === 'number' && Number.isFinite(c.value))
                )
              : true)
      )
        throw new Error('Invalid stop condition')
    }
  }
  if (
    rules.periods.some(
      (p) =>
        !Number.isInteger(p.day) ||
        p.day < 0 ||
        p.day > 6 ||
        !time.test(p.start) ||
        !(time.test(p.end) || p.end === '24:00') ||
        p.start >= p.end,
    )
  )
    throw new Error('Invalid stop period')
  return { ...rules, endingText: rules.endingText.trim() }
}

export async function assertAiStopReferences(
  tx: Transaction,
  workspaceId: string,
  rules: AiStopRules,
) {
  for (const c of rules.groups.flat()) {
    if (c.kind === 'PROPERTY') {
      const [d] = await tx
        .select()
        .from(customerPropertyDefinition)
        .where(
          and(
            eq(customerPropertyDefinition.id, c.definitionId),
            eq(customerPropertyDefinition.workspaceId, workspaceId),
            isNull(customerPropertyDefinition.deletedAt),
          ),
        )
        .for('share')
      if (
        !d ||
        (d.type === 'NUMBER'
          ? typeof c.value !== 'number'
          : typeof c.value !== 'string' ||
            c.value.length > d.maxLength ||
            (d.type === 'OPTION' && !d.options.includes(c.value)))
      )
        throw new Error('Stop property reference needs repair')
    } else if (c.kind === 'TAG') {
      const [d] = await tx
        .select({ id: customerTagDefinition.id })
        .from(customerTagDefinition)
        .where(
          and(
            eq(customerTagDefinition.id, c.tagId),
            eq(customerTagDefinition.workspaceId, workspaceId),
          ),
        )
        .for('share')
      if (!d) throw new Error('Stop tag reference needs repair')
    }
  }
  if (rules.endingMediaAssetId) {
    const [a] = await tx
      .select({ id: mediaAsset.id })
      .from(mediaAsset)
      .where(
        and(
          eq(mediaAsset.id, rules.endingMediaAssetId),
          eq(mediaAsset.workspaceId, workspaceId),
          eq(mediaAsset.kind, 'IMAGE'),
          eq(mediaAsset.inLibrary, true),
          isNull(mediaAsset.deletedAt),
        ),
      )
      .for('share')
    if (!a) throw new Error('Stop ending image needs repair')
  }
}

export function isAiStopPeriod(rules: AiStopRules, timeZone: string, at: Date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at)
  const get = (key: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === key)?.value ?? ''
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'))
  const time = `${get('hour')}:${get('minute')}`
  return rules.periods.some((p) => p.day === day && p.start <= time && time < p.end)
}

// Caller holds the workspace and conversation locks used by fact edits and AI commits.
export async function matchesAiStopCondition(
  tx: Transaction,
  input: { workspaceId: string; conversationId: string; memberId: string; customerId: string },
  rules: AiStopRules,
) {
  if (!rules.groups.length) return false
  const access = await tx
    .select({ id: channel.id })
    .from(memberChannelAccess)
    .innerJoin(channel, eq(channel.id, memberChannelAccess.channelId))
    .where(
      and(
        eq(memberChannelAccess.memberId, input.memberId),
        eq(channel.workspaceId, input.workspaceId),
        eq(channel.status, 'ACTIVE'),
      ),
    )
    .for('share', { of: [memberChannelAccess, channel] })
  const channels = access.map((a) => a.id)
  const properties = await tx
    .select({ id: customerPropertyDefinition.id, value: customerPropertyValue.value })
    .from(customerPropertyValue)
    .innerJoin(
      customerPropertyDefinition,
      eq(customerPropertyDefinition.id, customerPropertyValue.definitionId),
    )
    .where(
      and(
        eq(customerPropertyDefinition.workspaceId, input.workspaceId),
        isNull(customerPropertyDefinition.deletedAt),
        inArray(customerPropertyValue.sourceChannelId, channels),
        or(
          and(
            eq(customerPropertyDefinition.level, 'CUSTOMER'),
            eq(customerPropertyValue.customerId, input.customerId),
          ),
          and(
            eq(customerPropertyDefinition.level, 'CONVERSATION'),
            eq(customerPropertyValue.conversationId, input.conversationId),
          ),
        ),
      ),
    )
  const tags = await tx
    .select({ id: customerTagDefinition.id })
    .from(customerTag)
    .innerJoin(customerTagDefinition, eq(customerTagDefinition.id, customerTag.tagId))
    .where(
      and(
        eq(customerTagDefinition.workspaceId, input.workspaceId),
        inArray(customerTag.sourceChannelId, channels),
        or(
          and(
            eq(customerTagDefinition.level, 'CUSTOMER'),
            eq(customerTag.customerId, input.customerId),
          ),
          and(
            eq(customerTagDefinition.level, 'CONVERSATION'),
            eq(customerTag.conversationId, input.conversationId),
          ),
        ),
      ),
    )
  const [replies] = await tx
    .select({
      count: sql<number>`count(*)::int`,
    })
    .from(aiResponseRun)
    .where(
      and(
        eq(aiResponseRun.conversationId, input.conversationId),
        eq(aiResponseRun.state, 'COMPLETED'),
      ),
    )
  return rules.groups.some((group) =>
    group.every((c) =>
      c.kind === 'REPLIES'
        ? replies.count >= c.minimum
        : c.kind === 'TAG'
          ? tags.some((t) => t.id === c.tagId)
          : properties.some((p) => p.id === c.definitionId && p.value === c.value),
    ),
  )
}
