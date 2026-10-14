import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { AiMemberError, getAiMemberConfig } from './ai-members'
import {
  assertAiStopReferences,
  EMPTY_AI_STOP_RULES,
  isAiStopPeriod,
  hasAiStopPeriodBetween,
  matchesAiStopCondition,
  normalizeAiStopRules,
} from './ai-stop'
import type { Database } from './database'
import { facebookReplyWindowOpen } from './facebook'
import {
  aiFollowUpRule,
  aiFollowUpEvent,
  aiResponseRun,
  aiOperation,
  aiMemberConfig,
  channelIdentity,
  conversation,
  message,
  member,
  memberChannelAccess,
  channel,
  workspace,
  type AiStopCondition,
} from './schema'

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0]
type Identity = { workspaceId: string; memberId: string; actingUserId: string }
type Rule = typeof aiFollowUpRule.$inferSelect
export type FollowUpRuleInput = Identity & {
  id: string
  revision?: number
  name: string
  enabled: boolean
  timer: 'LAST_AI_REPLY' | 'AI_ASSIGNMENT'
  delaySeconds: number
  instructions: string
  groups: AiStopCondition[][]
}

export async function listAiFollowUpRules(db: Database, input: Identity) {
  await getAiMemberConfig(db, input)
  const rules = await db
    .select()
    .from(aiFollowUpRule)
    .where(
      and(
        eq(aiFollowUpRule.workspaceId, input.workspaceId),
        eq(aiFollowUpRule.memberId, input.memberId),
        isNull(aiFollowUpRule.deletedAt),
      ),
    )
    .orderBy(asc(aiFollowUpRule.createdAt), asc(aiFollowUpRule.id))
  const events = await db
    .select({
      id: aiFollowUpEvent.id,
      ruleId: aiFollowUpEvent.ruleId,
      conversationId: aiFollowUpEvent.conversationId,
      triggeredAt: aiFollowUpEvent.triggeredAt,
      dueAt: aiFollowUpEvent.dueAt,
      state: aiResponseRun.state,
      failureCode: aiResponseRun.failureCode,
      operationState: aiOperation.state,
      outputMessageId: aiResponseRun.outputMessageId,
      deliveryState: message.deliveryState,
      deliveryFailureCode: message.failureCode,
    })
    .from(aiFollowUpEvent)
    .innerJoin(aiFollowUpRule, eq(aiFollowUpRule.id, aiFollowUpEvent.ruleId))
    .innerJoin(aiResponseRun, eq(aiResponseRun.id, aiFollowUpEvent.id))
    .leftJoin(aiOperation, eq(aiOperation.id, aiFollowUpEvent.id))
    .leftJoin(message, eq(message.id, aiResponseRun.outputMessageId))
    .where(
      and(
        eq(aiFollowUpRule.workspaceId, input.workspaceId),
        eq(aiFollowUpRule.memberId, input.memberId),
      ),
    )
    .orderBy(desc(aiFollowUpEvent.triggeredAt))
    .limit(100)
  return { rules, events }
}

export async function saveAiFollowUpRule(db: Database, input: FollowUpRuleInput) {
  if (
    !input.name.trim() ||
    input.name.length > 100 ||
    input.instructions.length > 4000 ||
    !Number.isInteger(input.delaySeconds) ||
    input.delaySeconds < 1 ||
    input.delaySeconds > 2592000 ||
    !['LAST_AI_REPLY', 'AI_ASSIGNMENT'].includes(input.timer) ||
    typeof input.enabled !== 'boolean'
  )
    throw new AiMemberError('INVALID_REQUEST')
  let groups: AiStopCondition[][]
  try {
    groups = normalizeAiStopRules({ ...EMPTY_AI_STOP_RULES, groups: input.groups }).groups
    if (groups.flat().some((c) => c.kind === 'REPLIES')) throw new Error()
  } catch {
    throw new AiMemberError('INVALID_REQUEST')
  }
  return db.transaction(async (tx) => {
    await getAiMemberConfig(tx, input)
    await tx.execute(sql`select id from ${workspace} where id = ${input.workspaceId} for update`)
    try {
      await assertAiStopReferences(tx, input.workspaceId, { ...EMPTY_AI_STOP_RULES, groups })
    } catch {
      throw new AiMemberError('INVALID_CONFIGURATION')
    }
    const [old] = await tx
      .select()
      .from(aiFollowUpRule)
      .where(eq(aiFollowUpRule.id, input.id))
      .for('update')
    if (
      old &&
      (old.workspaceId !== input.workspaceId ||
        old.memberId !== input.memberId ||
        old.deletedAt ||
        old.revision !== input.revision)
    )
      throw new AiMemberError('INVALID_REQUEST')
    if (!old && input.revision !== undefined) throw new AiMemberError('INVALID_REQUEST')
    const values = {
      name: input.name.trim(),
      enabled: input.enabled,
      timer: input.timer,
      delaySeconds: input.delaySeconds,
      instructions: input.instructions.trim(),
      groups,
      revision: (old?.revision ?? 0) + 1,
      effectiveAt: new Date(),
      updatedAt: new Date(),
    }
    const [rule] = old
      ? await tx.update(aiFollowUpRule).set(values).where(eq(aiFollowUpRule.id, old.id)).returning()
      : await tx
          .insert(aiFollowUpRule)
          .values({
            ...values,
            id: input.id,
            workspaceId: input.workspaceId,
            memberId: input.memberId,
          })
          .returning()
    await cancelRuleEvents(tx, input.id)
    return rule
  })
}
export async function deleteAiFollowUpRule(
  db: Database,
  input: Identity & { id: string; revision: number },
) {
  return db.transaction(async (tx) => {
    await getAiMemberConfig(tx, input)
    await tx.execute(sql`select id from ${workspace} where id = ${input.workspaceId} for update`)
    const [rule] = await tx
      .update(aiFollowUpRule)
      .set({ deletedAt: new Date(), enabled: false, revision: input.revision + 1 })
      .where(
        and(
          eq(aiFollowUpRule.id, input.id),
          eq(aiFollowUpRule.workspaceId, input.workspaceId),
          eq(aiFollowUpRule.memberId, input.memberId),
          eq(aiFollowUpRule.revision, input.revision),
          isNull(aiFollowUpRule.deletedAt),
        ),
      )
      .returning()
    if (!rule) throw new AiMemberError('INVALID_REQUEST')
    await cancelRuleEvents(tx, input.id)
  })
}
async function cancelRuleEvents(tx: Tx, ruleId: string) {
  await tx
    .update(aiResponseRun)
    .set({
      state: 'CANCELLED',
      failureCode: 'FOLLOW_UP_RULE_CHANGED',
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        inArray(
          aiResponseRun.id,
          tx
            .select({ id: aiFollowUpEvent.id })
            .from(aiFollowUpEvent)
            .where(eq(aiFollowUpEvent.ruleId, ruleId)),
        ),
        inArray(aiResponseRun.state, ['QUEUED', 'GENERATING']),
      ),
    )
}

async function anchor(tx: Database | Tx, rule: Rule, conversationId: string) {
  const result = await tx.execute<{ id: string; at: string }>(
    rule.timer === 'LAST_AI_REPLY'
      ? sql`
    select m.id, m.delivery_completed_at::text as at from message m join conversation c on c.id = m.conversation_id join message i on i.id = c.last_customer_message_id
    where c.id = ${conversationId} and m.direction = 'OUTBOUND' and m.sender_type = 'MEMBER' and m.sender_member_id = c.assignee_member_id and m.delivery_state = 'SENT'
      and m.delivery_completed_at >= ${rule.effectiveAt} and m.created_at > i.created_at
      and m.created_at >= (select max(a.created_at) from conversation_assignment a where a.conversation_id = c.id)
    order by m.delivery_completed_at desc, m.id desc limit 1`
      : sql`
    select a.id, a.created_at::text as at from conversation_assignment a join conversation c on c.id = a.conversation_id join message i on i.id = c.last_customer_message_id
    where c.id = ${conversationId} and a.to_member_id = c.assignee_member_id and a.created_at >= ${rule.effectiveAt} and a.created_at > i.created_at
    order by a.created_at desc, a.id desc limit 1`,
  )
  return result.rows[0] ?? null
}

async function eligible(tx: Tx, rule: Rule, conversationId: string, now: Date) {
  const [current] = await tx
    .select({
      conversation,
      customerId: channelIdentity.customerId,
      identityId: channelIdentity.id,
      channelId: channelIdentity.channelId,
      snapshot: aiMemberConfig.publishedSnapshot,
    })
    .from(conversation)
    .innerJoin(channelIdentity, eq(channelIdentity.id, conversation.channelIdentityId))
    .innerJoin(
      member,
      and(
        eq(member.id, conversation.assigneeMemberId),
        eq(member.type, 'AI'),
        eq(member.status, 'ACTIVE'),
      ),
    )
    .innerJoin(
      memberChannelAccess,
      and(
        eq(memberChannelAccess.memberId, member.id),
        eq(memberChannelAccess.channelId, channelIdentity.channelId),
      ),
    )
    .innerJoin(
      channel,
      and(eq(channel.id, channelIdentity.channelId), eq(channel.status, 'ACTIVE')),
    )
    .innerJoin(
      aiMemberConfig,
      and(eq(aiMemberConfig.memberId, member.id), eq(aiMemberConfig.runtimeStatus, 'USABLE')),
    )
    .where(
      and(
        eq(conversation.id, conversationId),
        eq(conversation.workspaceId, rule.workspaceId),
        eq(conversation.assigneeMemberId, rule.memberId),
        eq(conversation.status, 'OPEN'),
      ),
    )
    .limit(1)
  if (
    !current ||
    !rule.enabled ||
    rule.deletedAt ||
    !current.snapshot ||
    !current.conversation.lastCustomerMessageId ||
    current.conversation.aiStopState ||
    !(await facebookReplyWindowOpen(tx, current.identityId, now))
  )
    return null
  const [pending] = await tx
    .select({ id: message.id })
    .from(message)
    .where(
      and(
        eq(message.conversationId, conversationId),
        eq(message.direction, 'OUTBOUND'),
        sql`(${message.deliveryState} = 'PENDING' or ${message.failureCode} = 'AMBIGUOUS_DELIVERY')`,
      ),
    )
    .limit(1)
  if (pending) return null
  const context = {
    workspaceId: rule.workspaceId,
    memberId: rule.memberId,
    conversationId,
    customerId: current.customerId,
  }
  try {
    await assertAiStopReferences(tx, rule.workspaceId, {
      ...EMPTY_AI_STOP_RULES,
      groups: rule.groups,
    })
    const stop = current.snapshot.stopRules ?? EMPTY_AI_STOP_RULES
    await assertAiStopReferences(tx, rule.workspaceId, stop)
    if (
      isAiStopPeriod(stop, current.snapshot.timeZone ?? 'UTC', now) ||
      (await matchesAiStopCondition(tx, context, stop))
    )
      return null
    if (
      rule.groups.length &&
      !(await matchesAiStopCondition(tx, context, { ...EMPTY_AI_STOP_RULES, groups: rule.groups }))
    )
      return null
  } catch {
    return null
  }
  const found = await anchor(tx, rule, conversationId)
  if (!found) return null
  if (
    hasAiStopPeriodBetween(
      current.snapshot.stopRules ?? EMPTY_AI_STOP_RULES,
      current.snapshot.timeZone ?? 'UTC',
      new Date(found.at),
      now,
    )
  )
    return null

  return {
    ...current,
    anchor: found,
    dueAt: new Date(new Date(found.at).getTime() + rule.delaySeconds * 1000),
  }
}

export async function listDueAiFollowUpConversations(
  db: Database,
  now = new Date(),
  after?: string,
) {
  const rows = await db.execute<{ conversationId: string }>(sql`
    select distinct c.id as "conversationId" from ai_follow_up_rule r join conversation c on c.assignee_member_id = r.member_id
    join message i on i.id = c.last_customer_message_id
    join lateral (
      select a.id, a.at from (
        select m.id, m.delivery_completed_at as at from message m where r.timer = 'LAST_AI_REPLY' and m.conversation_id = c.id and m.sender_member_id = c.assignee_member_id and m.direction = 'OUTBOUND' and m.sender_type = 'MEMBER' and m.delivery_state = 'SENT' and m.created_at > i.created_at and m.created_at >= (select max(x.created_at) from conversation_assignment x where x.conversation_id = c.id)
        union all select x.id, x.created_at as at from conversation_assignment x where r.timer = 'AI_ASSIGNMENT' and x.conversation_id = c.id and x.to_member_id = c.assignee_member_id and x.created_at > i.created_at
      ) a order by a.at desc, a.id desc limit 1
    ) anchor on anchor.at >= r.effective_at
    where r.enabled and r.deleted_at is null and c.status = 'OPEN' and c.ai_stop_state is null and anchor.at + r.delay_seconds * interval '1 second' <= ${now}
      and (${after ?? null}::uuid is null or c.id > ${after ?? null}::uuid)
      and not exists (select 1 from ai_follow_up_event e where e.rule_id = r.id and e.conversation_id = c.id)
      and not exists (select 1 from ai_response_run a where a.conversation_id = c.id and a.state in ('QUEUED','GENERATING'))
      and not exists (select 1 from message m where m.conversation_id = c.id and m.direction = 'OUTBOUND' and (m.delivery_state = 'PENDING' or m.failure_code = 'AMBIGUOUS_DELIVERY'))
      order by c.id limit 101`)
  const conversations = rows.rows.slice(0, 100).map((r) => r.conversationId)
  return { conversations, nextCursor: rows.rows.length > 100 ? conversations.at(-1) : undefined }
}

export async function startAiFollowUp(db: Database, conversationId: string, now = new Date()) {
  const [reference] = await db
    .select({ workspaceId: conversation.workspaceId })
    .from(conversation)
    .where(eq(conversation.id, conversationId))
  if (!reference) return null
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select id from ${workspace} where id = ${reference.workspaceId} for update`,
    )
    await tx.execute(sql`select id from ${conversation} where id = ${conversationId} for update`)
    const [busy] = await tx
      .select({ id: aiResponseRun.id })
      .from(aiResponseRun)
      .where(
        and(
          eq(aiResponseRun.conversationId, conversationId),
          inArray(aiResponseRun.state, ['QUEUED', 'GENERATING']),
        ),
      )
    if (busy) return null
    const [pending] = await tx
      .select({ id: message.id })
      .from(message)
      .where(
        and(
          eq(message.conversationId, conversationId),
          eq(message.direction, 'OUTBOUND'),
          sql`(${message.deliveryState} = 'PENDING' or ${message.failureCode} = 'AMBIGUOUS_DELIVERY')`,
        ),
      )
      .limit(1)
    if (pending) return null
    const rules = await tx
      .select()
      .from(aiFollowUpRule)
      .where(
        and(
          eq(aiFollowUpRule.workspaceId, reference.workspaceId),
          eq(aiFollowUpRule.enabled, true),
          isNull(aiFollowUpRule.deletedAt),
        ),
      )
    const candidates = []
    for (const rule of rules) {
      const [used] = await tx
        .select({ id: aiFollowUpEvent.id })
        .from(aiFollowUpEvent)
        .where(
          and(
            eq(aiFollowUpEvent.ruleId, rule.id),
            eq(aiFollowUpEvent.conversationId, conversationId),
          ),
        )
      if (used) continue
      const candidate = await eligible(tx, rule, conversationId, now)
      if (candidate && candidate.dueAt <= now) candidates.push({ rule, candidate })
    }
    candidates.sort(
      (a, b) =>
        a.candidate.dueAt.getTime() - b.candidate.dueAt.getTime() ||
        a.rule.createdAt.getTime() - b.rule.createdAt.getTime() ||
        a.rule.id.localeCompare(b.rule.id),
    )
    const selected = candidates[0]
    if (!selected) return null
    const { rule, candidate } = selected
    const id = crypto.randomUUID()
    await tx.insert(aiResponseRun).values({
      id,
      conversationId,
      memberId: rule.memberId,
      inputFirstMessageId: candidate.conversation.lastCustomerMessageId as string,
      inputLastMessageId: candidate.conversation.lastCustomerMessageId as string,
      scheduledFor: now,
    })
    await tx.insert(aiFollowUpEvent).values({
      id,
      ruleId: rule.id,
      conversationId,
      ruleRevision: rule.revision,
      anchorId: candidate.anchor.id,
      anchorAt: new Date(candidate.anchor.at),
      dueAt: candidate.dueAt,
      triggeredAt: now,
    })
    return id
  })
}

export async function readAiFollowUpAuthorization(tx: Tx, runId: string, now: Date) {
  const [event] = await tx
    .select({ event: aiFollowUpEvent, rule: aiFollowUpRule })
    .from(aiFollowUpEvent)
    .innerJoin(aiFollowUpRule, eq(aiFollowUpRule.id, aiFollowUpEvent.ruleId))
    .where(eq(aiFollowUpEvent.id, runId))
  if (!event) return { valid: true, followUp: null }
  const current = await eligible(tx, event.rule, event.event.conversationId, now)
  if (
    !current ||
    event.rule.revision !== event.event.ruleRevision ||
    current.anchor.id !== event.event.anchorId ||
    current.dueAt > now
  )
    return { valid: false, followUp: null }
  return {
    valid: true,
    followUp: { id: event.event.id, ruleId: event.rule.id, instructions: event.rule.instructions },
  }
}

export async function previewAiFollowUpAudience(
  db: Database,
  input: Identity & { groups: AiStopCondition[][] },
) {
  return db.transaction(async (tx) => {
    await getAiMemberConfig(tx, input)
    await tx.execute(sql`select id from ${workspace} where id = ${input.workspaceId} for update`)
    let groups: AiStopCondition[][]
    try {
      groups = normalizeAiStopRules({ ...EMPTY_AI_STOP_RULES, groups: input.groups }).groups
      if (groups.flat().some((c) => c.kind === 'REPLIES')) throw new Error()
      await assertAiStopReferences(tx, input.workspaceId, { ...EMPTY_AI_STOP_RULES, groups })
    } catch {
      throw new AiMemberError('INVALID_CONFIGURATION')
    }
    const current = await tx
      .select({ id: conversation.id, customerId: channelIdentity.customerId })
      .from(conversation)
      .innerJoin(channelIdentity, eq(channelIdentity.id, conversation.channelIdentityId))
      .innerJoin(
        memberChannelAccess,
        and(
          eq(memberChannelAccess.memberId, input.memberId),
          eq(memberChannelAccess.channelId, channelIdentity.channelId),
        ),
      )
      .where(
        and(
          eq(conversation.workspaceId, input.workspaceId),
          eq(conversation.assigneeMemberId, input.memberId),
          eq(conversation.status, 'OPEN'),
        ),
      )
      .orderBy(asc(conversation.id))
      .limit(100)
    const matches = []
    for (const row of current)
      if (
        !groups.length ||
        (await matchesAiStopCondition(
          tx,
          {
            workspaceId: input.workspaceId,
            conversationId: row.id,
            customerId: row.customerId,
            memberId: input.memberId,
          },
          { ...EMPTY_AI_STOP_RULES, groups },
        ))
      )
        matches.push({ conversationId: row.id })
    return { matches, scanned: current.length, limit: 100 }
  })
}
