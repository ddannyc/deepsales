import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { cancelActiveAiResponseRuns } from './ai-responses'
import type { Database } from './database'
import {
  aiMemberConfig,
  aiResponseRun,
  channel,
  channelIdentity,
  conversation,
  conversationAssignment,
  humanMemberAvailability,
  member,
  memberChannelAccess,
  message,
  workspace,
  workspaceUserAccess,
} from './schema'

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0]
type CommandBase = {
  workspaceId: string
  conversationId: string
  actingUserId: string
  now?: Date
}

export type AssignmentErrorCode =
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'INVALID_REQUEST'
  | 'ALREADY_ASSIGNED'
  | 'CONVERSATION_CLOSED'
  | 'TRANSFER_CONFIRMATION_REQUIRED'
  | 'INVALID_TARGET'

export class AssignmentError extends Error {
  constructor(
    readonly code: AssignmentErrorCode,
    message: string = code,
  ) {
    super(message)
  }
}

export type AssignmentCommand =
  | { type: 'AUTO_ROUTE'; workspaceId: string; conversationId: string; now?: Date }
  | {
      type: 'AI_HANDOFF'
      workspaceId: string
      conversationId: string
      memberId: string
      runId: string
      reason:
        | 'CUSTOMER_REQUEST'
        | 'NO_KNOWLEDGE'
        | 'NEGATIVE_SENTIMENT'
        | 'UNABLE_TO_ANSWER'
        | 'KEYWORD'
        | 'UNSUPPORTED_ATTACHMENT'
        | 'PROVIDER_FAILURE'
      noticeText?: string | null
      runState?: 'HANDOFF' | 'FAILED'
      failureCode?: string
      failureMessage?: string
      markRuntimeUnhealthy?: boolean
      now?: Date
    }
  | (CommandBase & { type: 'TAKEOVER' })
  | (CommandBase & { type: 'TRANSFER'; targetMemberId: string; confirmOverride?: boolean })
  | (CommandBase & { type: 'UNASSIGN' })
  | (CommandBase & { type: 'MEMBER_DISABLED'; memberId: string })
  | (CommandBase & { type: 'CLOSE' })

export type AssignmentResult = {
  conversationId: string
  assignmentId: string | null
  fromMemberId: string | null
  toMemberId: string | null
  aiResponseRunId: string | null
  messageId: string | null
  changed: boolean
}

type CurrentConversation = {
  id: string
  status: 'OPEN' | 'CLOSED'
  assigneeMemberId: string | null
  assigneeType: 'HUMAN' | 'AI' | null
  assigneeWorkspaceId: string | null
  channelId: string
  routingConstraint: 'ANY_MEMBER' | 'HUMAN_ONLY'
  latestMessageAt: Date | null
  lastOutboundMessageAt: Date | null
  lastCustomerMessageId: string | null
}

export const AI_DEBOUNCE_MS = 2_000

export async function executeAssignment(tx: Transaction, command: AssignmentCommand) {
  if (command.type === 'AUTO_ROUTE') return executeAutoAssignment(tx, command)
  const now = command.now ?? new Date()

  if (command.type === 'CLOSE') {
    const [reference] = await tx
      .select({ channelIdentityId: conversation.channelIdentityId })
      .from(conversation)
      .where(
        and(
          eq(conversation.id, command.conversationId),
          eq(conversation.workspaceId, command.workspaceId),
        ),
      )
      .limit(1)
    if (!reference) throw new AssignmentError('NOT_FOUND', 'Conversation not found')
    await tx.execute(
      sql`select id from ${channelIdentity} where id = ${reference.channelIdentityId} for update`,
    )
    await tx.execute(
      sql`select id from ${conversation} where id = ${command.conversationId} and workspace_id = ${command.workspaceId} for update`,
    )
  } else {
    const workspaceLock = await tx.execute(
      sql`select id from ${workspace} where id = ${command.workspaceId} for update`,
    )
    if (!workspaceLock.rows.length) throw new AssignmentError('NOT_FOUND', 'Workspace not found')
    await lockConversation(tx, command)
  }

  const [current] = await tx
    .select({
      id: conversation.id,
      status: conversation.status,
      assigneeMemberId: conversation.assigneeMemberId,
      assigneeType: member.type,
      assigneeWorkspaceId: member.workspaceId,
      channelId: channel.id,
      routingConstraint: conversation.routingConstraint,
      latestMessageAt: conversation.latestMessageAt,
      lastOutboundMessageAt: conversation.lastOutboundMessageAt,
      lastCustomerMessageId: conversation.lastCustomerMessageId,
    })
    .from(conversation)
    .innerJoin(channelIdentity, eq(channelIdentity.id, conversation.channelIdentityId))
    .innerJoin(channel, eq(channel.id, channelIdentity.channelId))
    .leftJoin(member, eq(member.id, conversation.assigneeMemberId))
    .where(
      and(
        eq(conversation.id, command.conversationId),
        eq(conversation.workspaceId, command.workspaceId),
      ),
    )
    .limit(1)
  if (!current) throw new AssignmentError('NOT_FOUND', 'Conversation not found')
  if (command.type === 'AI_HANDOFF') {
    if (current.status !== 'OPEN') return unchanged(current, current.assigneeMemberId)
    return executeAiHandoff(tx, command, current, now)
  }
  if (current.status !== 'OPEN') {
    throw new AssignmentError('CONVERSATION_CLOSED', 'Conversation is closed')
  }

  const [actor] = await tx
    .select({
      id: member.id,
      type: member.type,
      status: member.status,
      role: workspaceUserAccess.role,
    })
    .from(member)
    .innerJoin(workspaceUserAccess, eq(workspaceUserAccess.id, member.workspaceUserAccessId))
    .where(
      and(
        eq(member.workspaceId, command.workspaceId),
        eq(workspaceUserAccess.userId, command.actingUserId),
      ),
    )
    .limit(1)
  if (actor?.type !== 'HUMAN' || actor.status !== 'ACTIVE') {
    throw new AssignmentError('FORBIDDEN', 'An active human member is required')
  }

  const targetMemberId = command.type === 'TRANSFER' ? command.targetMemberId : null
  const involvedMemberIds = [
    actor.id,
    current.assigneeMemberId,
    targetMemberId,
    command.type === 'MEMBER_DISABLED' ? command.memberId : null,
  ].filter((id): id is string => Boolean(id))
  if (involvedMemberIds.length) {
    await tx
      .select({ id: member.id })
      .from(member)
      .where(
        and(eq(member.workspaceId, command.workspaceId), inArray(member.id, involvedMemberIds)),
      )
      .orderBy(asc(member.id))
      .for('update')
  }

  const [lockedActor] = await tx
    .select({ type: member.type, status: member.status })
    .from(member)
    .where(eq(member.id, actor.id))
    .limit(1)
  if (lockedActor?.type !== 'HUMAN' || lockedActor.status !== 'ACTIVE') {
    throw new AssignmentError('FORBIDDEN', 'An active human member is required')
  }

  if (command.type === 'TAKEOVER') {
    const [access] = await tx
      .select({ memberId: memberChannelAccess.memberId })
      .from(memberChannelAccess)
      .where(
        and(
          eq(memberChannelAccess.memberId, actor.id),
          eq(memberChannelAccess.channelId, current.channelId),
        ),
      )
      .limit(1)
    if (!access) throw new AssignmentError('FORBIDDEN', 'Channel access is required')
    if (current.assigneeMemberId === actor.id) {
      return unchanged(current, actor.id)
    }
    if (
      current.assigneeMemberId &&
      (current.assigneeType !== 'AI' || current.assigneeWorkspaceId !== command.workspaceId)
    ) {
      throw new AssignmentError('ALREADY_ASSIGNED', 'Conversation is already assigned')
    }
    await cancelAiRunsOnOwnershipChange(tx, current, now)
    const assignmentId = await recordAssignment(tx, {
      conversationId: current.id,
      fromMemberId: current.assigneeMemberId,
      toMemberId: actor.id,
      reason: 'TAKEOVER',
      actingMemberId: actor.id,
      createdAt: now,
    })
    await tx
      .update(conversation)
      .set({
        assigneeMemberId: actor.id,
        queueReason: null,
        routingQueuedAt: null,
        updatedAt: now,
      })
      .where(eq(conversation.id, current.id))
    return changed(current, assignmentId, actor.id)
  }

  if (command.type === 'TRANSFER') {
    if (!current.assigneeMemberId || current.assigneeType !== 'HUMAN') {
      throw new AssignmentError(
        'INVALID_REQUEST',
        'Only human-owned conversations can be transferred',
      )
    }
    if (!['OWNER', 'ADMIN'].includes(actor.role) && current.assigneeMemberId !== actor.id) {
      throw new AssignmentError('FORBIDDEN', 'Only the current human owner may transfer')
    }
    if (current.assigneeMemberId === command.targetMemberId) {
      return unchanged(current, current.assigneeMemberId)
    }
    const target = await assertTransferTarget(tx, command, current)
    const assignmentId = await recordAssignment(tx, {
      conversationId: current.id,
      fromMemberId: current.assigneeMemberId,
      toMemberId: target.id,
      reason: 'MANUAL_TRANSFER',
      actingMemberId: actor.id,
      createdAt: now,
    })
    await tx
      .update(conversation)
      .set({
        assigneeMemberId: target.id,
        queueReason: null,
        routingConstraint: target.type === 'AI' ? 'ANY_MEMBER' : current.routingConstraint,
        routingQueuedAt: null,
        updatedAt: now,
      })
      .where(eq(conversation.id, current.id))
    const aiResponseRunId =
      target.type === 'AI'
        ? await ensureAiResponseRun(tx, {
            conversationId: current.id,
            memberId: target.id,
            now,
          })
        : null
    return changed(current, assignmentId, target.id, aiResponseRunId)
  }

  if (command.type === 'MEMBER_DISABLED' && current.assigneeMemberId !== command.memberId) {
    return unchanged(current, current.assigneeMemberId)
  }

  if (!['OWNER', 'ADMIN'].includes(actor.role) && current.assigneeMemberId !== actor.id) {
    throw new AssignmentError(
      'FORBIDDEN',
      'Only the current human owner may change this conversation',
    )
  }

  if (command.type === 'UNASSIGN' || command.type === 'MEMBER_DISABLED') {
    const reason = command.type === 'UNASSIGN' ? 'MANUAL_UNASSIGN' : 'MEMBER_DISABLED'
    await cancelAiRunsOnOwnershipChange(tx, current, now)
    const assignmentId = await recordAssignment(tx, {
      conversationId: current.id,
      fromMemberId: current.assigneeMemberId,
      toMemberId: null,
      reason,
      actingMemberId: actor.id,
      createdAt: now,
    })
    await tx
      .update(conversation)
      .set({
        assigneeMemberId: null,
        queueReason: reason,
        routingQueuedAt: now,
        updatedAt: now,
      })
      .where(eq(conversation.id, current.id))
    return changed(current, assignmentId, null)
  }

  await cancelAiRunsOnOwnershipChange(tx, current, now)
  const assignmentId = await recordAssignment(tx, {
    conversationId: current.id,
    fromMemberId: current.assigneeMemberId,
    toMemberId: null,
    reason: 'CLOSE',
    actingMemberId: actor.id,
    createdAt: now,
  })
  await tx
    .update(conversation)
    .set({
      status: 'CLOSED',
      assigneeMemberId: null,
      queueReason: null,
      routingConstraint: 'ANY_MEMBER',
      routingQueuedAt: null,
      closedAt: now,
      closedByMemberId: actor.id,
      updatedAt: now,
    })
    .where(eq(conversation.id, current.id))
  return changed(current, assignmentId, null)
}

export async function takeOverConversation(
  db: Database,
  input: { workspaceId: string; conversationId: string; actingUserId: string; now?: Date },
) {
  return db.transaction((tx) => executeAssignment(tx, { type: 'TAKEOVER', ...input }))
}

export async function handoffAiConversation(
  db: Database,
  input: Omit<Extract<AssignmentCommand, { type: 'AI_HANDOFF' }>, 'type'>,
) {
  return db.transaction((tx) => executeAssignment(tx, { type: 'AI_HANDOFF', ...input }))
}

export async function transferConversation(
  db: Database,
  input: {
    workspaceId: string
    conversationId: string
    actingUserId: string
    targetMemberId: string
    confirmOverride?: boolean
    now?: Date
  },
) {
  return db.transaction((tx) => executeAssignment(tx, { type: 'TRANSFER', ...input }))
}

export async function unassignConversation(
  db: Database,
  input: { workspaceId: string; conversationId: string; actingUserId: string; now?: Date },
) {
  return db.transaction((tx) => executeAssignment(tx, { type: 'UNASSIGN', ...input }))
}

export async function closeConversation(
  db: Database,
  input: { workspaceId: string; conversationId: string; actingUserId: string; now?: Date },
) {
  return db.transaction((tx) => executeAssignment(tx, { type: 'CLOSE', ...input }))
}

export async function requeueMemberConversation(
  tx: Transaction,
  input: {
    workspaceId: string
    conversationId: string
    memberId: string
    actingUserId: string
    now?: Date
  },
) {
  return executeAssignment(tx, { type: 'MEMBER_DISABLED', ...input })
}

export type AutoAssignInput = {
  workspaceId: string
  conversationId: string
  now?: Date
}

export async function autoAssignConversation(db: Database, input: AutoAssignInput) {
  return db.transaction((tx) => executeAssignment(tx, { type: 'AUTO_ROUTE', ...input }))
}

export async function listQueuedConversationIds(
  db: Database,
  input: { workspaceId?: string; limit?: number } = {},
) {
  return db.transaction(async (tx) => {
    return tx
      .select({ conversationId: conversation.id, workspaceId: conversation.workspaceId })
      .from(conversation)
      .where(
        and(
          input.workspaceId ? eq(conversation.workspaceId, input.workspaceId) : undefined,
          eq(conversation.status, 'OPEN'),
          sql`${conversation.assigneeMemberId} is null`,
        ),
      )
      .orderBy(asc(conversation.routingQueuedAt), asc(conversation.id))
      .limit(Math.min(Math.max(input.limit ?? 100, 1), 100))
      .for('update', { skipLocked: true })
  })
}

export async function listQueuedAiResponseRunIds(db: Database, limit = 100, memberId?: string) {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({ runId: aiResponseRun.id })
      .from(aiResponseRun)
      .where(
        and(
          eq(aiResponseRun.state, 'QUEUED'),
          memberId ? eq(aiResponseRun.memberId, memberId) : undefined,
        ),
      )
      .orderBy(asc(aiResponseRun.scheduledFor), asc(aiResponseRun.id))
      .limit(Math.min(Math.max(limit, 1), 100))
      .for('update', { skipLocked: true })
    return rows.map(({ runId }) => runId)
  })
}

async function executeAutoAssignment(tx: Transaction, input: AutoAssignInput) {
  const now = input.now ?? new Date()
  // ponytail: one workspace lock is the V1 throughput ceiling; split locks only after measured contention.
  const workspaceLock = await tx.execute(
    sql`select id from ${workspace} where id = ${input.workspaceId} for update`,
  )
  if (!workspaceLock.rows.length) throw new AssignmentError('NOT_FOUND', 'Workspace not found')
  await lockConversation(tx, input)

  const current = await selectCurrentConversation(tx, input.workspaceId, input.conversationId)
  if (!current) throw new AssignmentError('NOT_FOUND', 'Conversation not found')
  if (current.status !== 'OPEN') return unchanged(current, current.assigneeMemberId)
  if (current.assigneeMemberId) return unchanged(current, current.assigneeMemberId)

  let candidates = await findEligibleCandidates(tx, input.workspaceId, current.channelId)
  if (candidates.length) {
    await tx
      .select({ id: member.id })
      .from(member)
      .where(
        and(
          eq(member.workspaceId, input.workspaceId),
          inArray(
            member.id,
            candidates.map(({ id }) => id),
          ),
        ),
      )
      .orderBy(asc(member.id))
      .for('update')
    candidates = await findEligibleCandidates(tx, input.workspaceId, current.channelId)
  }

  const candidate = await rankCandidate(
    tx,
    input.workspaceId,
    current.routingConstraint,
    candidates,
  )
  if (!candidate) return unchanged(current, null)

  const assignmentId = await recordAssignment(tx, {
    conversationId: current.id,
    fromMemberId: null,
    toMemberId: candidate.id,
    reason: 'AUTO_ROUTE',
    actingMemberId: null,
    createdAt: now,
  })
  await tx
    .update(conversation)
    .set({
      assigneeMemberId: candidate.id,
      queueReason: null,
      routingQueuedAt: null,
      updatedAt: now,
    })
    .where(eq(conversation.id, current.id))
  await tx
    .update(member)
    .set({ lastAutoAssignedAt: now, updatedAt: now })
    .where(eq(member.id, candidate.id))

  const aiResponseRunId =
    candidate.type === 'AI'
      ? await ensureAiResponseRun(tx, { conversationId: current.id, memberId: candidate.id, now })
      : null
  return changed(current, assignmentId, candidate.id, aiResponseRunId)
}

async function executeAiHandoff(
  tx: Transaction,
  command: Extract<AssignmentCommand, { type: 'AI_HANDOFF' }>,
  current: CurrentConversation,
  now: Date,
): Promise<AssignmentResult> {
  const involvedMemberIds = [...new Set([current.assigneeMemberId, command.memberId])]
    .filter((id): id is string => Boolean(id))
    .sort()
  if (involvedMemberIds.length) {
    await tx
      .select({ id: member.id })
      .from(member)
      .where(
        and(eq(member.workspaceId, command.workspaceId), inArray(member.id, involvedMemberIds)),
      )
      .orderBy(asc(member.id))
      .for('update')
  }

  if (current.assigneeMemberId !== command.memberId || current.assigneeType !== 'AI') {
    return unchanged(current, current.assigneeMemberId)
  }

  const [run] = await tx
    .select({
      memberId: aiResponseRun.memberId,
      state: aiResponseRun.state,
      inputLastMessageId: aiResponseRun.inputLastMessageId,
    })
    .from(aiResponseRun)
    .where(and(eq(aiResponseRun.id, command.runId), eq(aiResponseRun.conversationId, current.id)))
    .for('update')
    .limit(1)
  if (!run || run.memberId !== command.memberId || !['QUEUED', 'GENERATING'].includes(run.state)) {
    return unchanged(current, current.assigneeMemberId)
  }
  if (current.lastCustomerMessageId !== run.inputLastMessageId) {
    await tx
      .update(aiResponseRun)
      .set({
        state: 'CANCELLED',
        cancellationReason: 'NEW_CUSTOMER_MESSAGE',
        completedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(aiResponseRun.id, command.runId),
          inArray(aiResponseRun.state, ['QUEUED', 'GENERATING']),
        ),
      )
    return unchanged(current, current.assigneeMemberId)
  }

  const noticeText = command.noticeText?.trim() ?? ''
  if (noticeText.length > 2_000) {
    throw new AssignmentError('INVALID_REQUEST', 'Handoff notice is too long')
  }

  const assignmentId = await recordAssignment(tx, {
    conversationId: current.id,
    fromMemberId: current.assigneeMemberId,
    toMemberId: null,
    reason: 'AI_HANDOFF',
    actingMemberId: null,
    createdAt: now,
  })
  let messageId: string | null = null
  if (noticeText) {
    const [created] = await tx
      .insert(message)
      .values({
        conversationId: current.id,
        channelId: current.channelId,
        direction: 'OUTBOUND',
        senderType: 'MEMBER',
        senderMemberId: command.memberId,
        messageType: 'TEXT',
        text: noticeText,
        deliveryState: 'PENDING',
        createdAt: sql`clock_timestamp()`,
        updatedAt: now,
      })
      .returning({ id: message.id })
    messageId = created?.id ?? null
  }

  await tx
    .update(conversation)
    .set({
      assigneeMemberId: null,
      queueReason: 'AI_HANDOFF',
      routingConstraint: 'HUMAN_ONLY',
      routingQueuedAt: now,
      latestMessageAt: noticeText ? later(current.latestMessageAt, now) : current.latestMessageAt,
      lastOutboundMessageAt: noticeText ? now : current.lastOutboundMessageAt,
      updatedAt: now,
    })
    .where(eq(conversation.id, current.id))

  await tx
    .update(aiResponseRun)
    .set({
      state: command.runState ?? 'HANDOFF',
      outputMessageId: messageId,
      completedAt: now,
      failureCode: (command.failureCode ?? command.reason).slice(0, 100),
      failureMessage: command.failureMessage?.slice(0, 500) ?? null,
      updatedAt: now,
    })
    .where(
      and(
        eq(aiResponseRun.id, command.runId),
        inArray(aiResponseRun.state, ['QUEUED', 'GENERATING']),
      ),
    )

  if (command.markRuntimeUnhealthy) {
    await tx
      .update(aiMemberConfig)
      .set({
        runtimeStatus: 'UNHEALTHY',
        runtimeError: (command.failureCode ?? 'AI_RUNTIME_ERROR').slice(0, 500),
        updatedAt: now,
      })
      .where(eq(aiMemberConfig.memberId, command.memberId))
  }

  return changed(current, assignmentId, null, null, messageId)
}

async function selectCurrentConversation(
  tx: Transaction,
  workspaceId: string,
  conversationId: string,
) {
  const [current] = await tx
    .select({
      id: conversation.id,
      status: conversation.status,
      assigneeMemberId: conversation.assigneeMemberId,
      assigneeType: member.type,
      assigneeWorkspaceId: member.workspaceId,
      channelId: channel.id,
      routingConstraint: conversation.routingConstraint,
      latestMessageAt: conversation.latestMessageAt,
      lastOutboundMessageAt: conversation.lastOutboundMessageAt,
      lastCustomerMessageId: conversation.lastCustomerMessageId,
    })
    .from(conversation)
    .innerJoin(channelIdentity, eq(channelIdentity.id, conversation.channelIdentityId))
    .innerJoin(channel, eq(channel.id, channelIdentity.channelId))
    .leftJoin(member, eq(member.id, conversation.assigneeMemberId))
    .where(and(eq(conversation.id, conversationId), eq(conversation.workspaceId, workspaceId)))
    .limit(1)
  return current
}

async function findEligibleCandidates(tx: Transaction, workspaceId: string, channelId: string) {
  return tx
    .select({
      id: member.id,
      type: member.type,
      maxActiveConversations: member.maxActiveConversations,
      lastAutoAssignedAt: member.lastAutoAssignedAt,
    })
    .from(member)
    .innerJoin(memberChannelAccess, eq(memberChannelAccess.memberId, member.id))
    .leftJoin(humanMemberAvailability, eq(humanMemberAvailability.memberId, member.id))
    .leftJoin(aiMemberConfig, eq(aiMemberConfig.memberId, member.id))
    .where(
      and(
        eq(member.workspaceId, workspaceId),
        eq(member.status, 'ACTIVE'),
        eq(member.autoAssignmentEnabled, true),
        eq(memberChannelAccess.channelId, channelId),
        sql`(
          (${member.type} = 'HUMAN' and ${humanMemberAvailability.available} = true)
          or
          (${member.type} = 'AI' and ${aiMemberConfig.runtimeStatus} = 'USABLE')
        )`,
      ),
    )
}

async function rankCandidate(
  tx: Transaction,
  workspaceId: string,
  routingConstraint: 'ANY_MEMBER' | 'HUMAN_ONLY',
  candidates: Awaited<ReturnType<typeof findEligibleCandidates>>,
) {
  const allowed = candidates.filter(
    ({ type }) => routingConstraint === 'ANY_MEMBER' || type === 'HUMAN',
  )
  if (!allowed.length) return null

  const loads = await tx
    .select({
      memberId: conversation.assigneeMemberId,
      count: sql<number>`count(*)::int`,
    })
    .from(conversation)
    .where(
      and(
        eq(conversation.workspaceId, workspaceId),
        eq(conversation.status, 'OPEN'),
        inArray(
          conversation.assigneeMemberId,
          allowed.map(({ id }) => id),
        ),
      ),
    )
    .groupBy(conversation.assigneeMemberId)
  const loadByMemberId = new Map(loads.map(({ memberId, count }) => [memberId, Number(count)]))
  const available = allowed.filter(
    ({ id, maxActiveConversations }) => (loadByMemberId.get(id) ?? 0) < maxActiveConversations,
  )
  const typeCandidates = available.filter(({ type }) => type === 'AI')
  const selectedPool =
    routingConstraint === 'ANY_MEMBER' && typeCandidates.length
      ? typeCandidates
      : available.filter(({ type }) => type === 'HUMAN')
  selectedPool.sort((left, right) => {
    const leftRatio = (loadByMemberId.get(left.id) ?? 0) / left.maxActiveConversations
    const rightRatio = (loadByMemberId.get(right.id) ?? 0) / right.maxActiveConversations
    if (leftRatio !== rightRatio) return leftRatio - rightRatio
    if (!left.lastAutoAssignedAt && right.lastAutoAssignedAt) return -1
    if (left.lastAutoAssignedAt && !right.lastAutoAssignedAt) return 1
    if (left.lastAutoAssignedAt && right.lastAutoAssignedAt) {
      const byTime = left.lastAutoAssignedAt.getTime() - right.lastAutoAssignedAt.getTime()
      if (byTime) return byTime
    }
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
  })
  return selectedPool[0] ?? null
}

export async function ensureAiResponseRun(
  tx: Transaction,
  input: { conversationId: string; memberId: string; now: Date },
) {
  await tx.execute(
    sql`select id from ${conversation} where id = ${input.conversationId} for update`,
  )
  const messages = await tx
    .select({ id: message.id, direction: message.direction, senderType: message.senderType })
    .from(message)
    .where(eq(message.conversationId, input.conversationId))
    .orderBy(asc(message.createdAt), asc(message.id))
  let lastMemberOutbound = -1
  for (const [index, item] of messages.entries()) {
    if (item.direction === 'OUTBOUND' && item.senderType === 'MEMBER') lastMemberOutbound = index
  }
  const unanswered = messages
    .slice(lastMemberOutbound + 1)
    .filter((item) => item.direction === 'INBOUND' && item.senderType === 'CUSTOMER')
  const first = unanswered[0]
  const last = unanswered.at(-1)
  if (!first || !last) return null

  async function schedule(runId: string, startedAt: Date) {
    // Read after the run lock or insert's member FK lock serializes with publication.
    const [config] = await tx
      .select({ snapshot: aiMemberConfig.publishedSnapshot })
      .from(aiMemberConfig)
      .where(eq(aiMemberConfig.memberId, input.memberId))
    const waitMs = config?.snapshot?.replyWaitEnabled === false ? 0 : AI_DEBOUNCE_MS
    await tx
      .update(aiResponseRun)
      .set({
        scheduledFor: new Date(
          Math.min(input.now.getTime() + waitMs, startedAt.getTime() + 30_000),
        ),
      })
      .where(eq(aiResponseRun.id, runId))
  }
  const [active] = await tx
    .select({
      id: aiResponseRun.id,
      state: aiResponseRun.state,
      memberId: aiResponseRun.memberId,
      inputLastMessageId: aiResponseRun.inputLastMessageId,
      createdAt: aiResponseRun.createdAt,
      configSnapshot: aiResponseRun.configSnapshot,
    })
    .from(aiResponseRun)
    .where(
      and(
        eq(aiResponseRun.conversationId, input.conversationId),
        inArray(aiResponseRun.state, ['QUEUED', 'GENERATING']),
      ),
    )
    .for('update')
    .limit(1)
  if (active) {
    if (active.memberId === input.memberId && active.state === 'QUEUED' && !active.configSnapshot) {
      if (active.inputLastMessageId === last.id) return active.id
      await tx
        .update(aiResponseRun)
        .set({
          memberId: input.memberId,
          inputFirstMessageId: first.id,
          inputLastMessageId: last.id,
          updatedAt: input.now,
        })
        .where(eq(aiResponseRun.id, active.id))
      await schedule(active.id, active.createdAt)
      return active.id
    }
    if (active.memberId === input.memberId && active.inputLastMessageId === last.id) {
      return active.id
    }
    await cancelActiveAiResponseRuns(tx, {
      conversationId: input.conversationId,
      reason: active.memberId === input.memberId ? 'NEW_CUSTOMER_MESSAGE' : 'OWNERSHIP_CHANGED',
      now: input.now,
    })
  }

  const [created] = await tx
    .insert(aiResponseRun)
    .values({
      conversationId: input.conversationId,
      memberId: input.memberId,
      state: 'QUEUED',
      inputFirstMessageId: first.id,
      inputLastMessageId: last.id,
      scheduledFor: input.now,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .returning({ id: aiResponseRun.id })
  if (!created) throw new AssignmentError('INVALID_REQUEST', 'AI response run was not created')
  await schedule(created.id, input.now)
  return created.id
}

async function lockConversation(
  tx: Transaction,
  command: Pick<CommandBase, 'workspaceId' | 'conversationId'>,
) {
  const conversationLock = await tx.execute(
    sql`select id from ${conversation} where id = ${command.conversationId} and workspace_id = ${command.workspaceId} for update`,
  )
  if (!conversationLock.rows.length) {
    throw new AssignmentError('NOT_FOUND', 'Conversation not found')
  }
}

async function cancelAiRunsOnOwnershipChange(
  tx: Transaction,
  current: Pick<CurrentConversation, 'id' | 'assigneeType'>,
  now: Date,
) {
  if (current.assigneeType !== 'AI') return
  await cancelActiveAiResponseRuns(tx, {
    conversationId: current.id,
    reason: 'OWNERSHIP_CHANGED',
    now,
  })
}

async function assertTransferTarget(
  tx: Transaction,
  command: Extract<AssignmentCommand, { type: 'TRANSFER' }>,
  current: CurrentConversation,
) {
  const [target] = await tx
    .select({
      id: member.id,
      type: member.type,
      status: member.status,
      maxActiveConversations: member.maxActiveConversations,
      available: humanMemberAvailability.available,
      runtimeStatus: aiMemberConfig.runtimeStatus,
    })
    .from(member)
    .leftJoin(humanMemberAvailability, eq(humanMemberAvailability.memberId, member.id))
    .leftJoin(aiMemberConfig, eq(aiMemberConfig.memberId, member.id))
    .where(and(eq(member.id, command.targetMemberId), eq(member.workspaceId, command.workspaceId)))
    .limit(1)
  if (target?.status !== 'ACTIVE') {
    throw new AssignmentError('INVALID_TARGET', 'Target member is not active')
  }

  const [access] = await tx
    .select({ memberId: memberChannelAccess.memberId })
    .from(memberChannelAccess)
    .where(
      and(
        eq(memberChannelAccess.memberId, target.id),
        eq(memberChannelAccess.channelId, current.channelId),
      ),
    )
    .limit(1)
  if (!access) throw new AssignmentError('INVALID_TARGET', 'Target channel access is required')

  if (target.type === 'AI') {
    if (target.runtimeStatus !== 'USABLE') {
      throw new AssignmentError('INVALID_TARGET', 'AI member is not published and usable')
    }
  }
  if (target.type !== 'HUMAN' && target.type !== 'AI') {
    throw new AssignmentError('INVALID_TARGET', 'Invalid target member')
  }

  const [load] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(conversation)
    .where(
      and(
        eq(conversation.workspaceId, command.workspaceId),
        eq(conversation.status, 'OPEN'),
        eq(conversation.assigneeMemberId, target.id),
      ),
    )
  const atCapacity = Number(load?.count ?? 0) >= target.maxActiveConversations
  const unavailable = target.type === 'HUMAN' && target.available === false
  if ((atCapacity || unavailable) && !command.confirmOverride) {
    throw new AssignmentError(
      'TRANSFER_CONFIRMATION_REQUIRED',
      atCapacity
        ? 'Target is at capacity; confirm to transfer'
        : 'Target is temporarily unavailable; confirm to transfer',
    )
  }
  return target
}

async function recordAssignment(
  tx: Transaction,
  input: {
    conversationId: string
    fromMemberId: string | null
    toMemberId: string | null
    reason:
      | 'AUTO_ROUTE'
      | 'TAKEOVER'
      | 'MANUAL_TRANSFER'
      | 'MANUAL_UNASSIGN'
      | 'AI_HANDOFF'
      | 'MEMBER_DISABLED'
      | 'CLOSE'
    actingMemberId: string | null
    createdAt: Date
  },
) {
  if (input.fromMemberId === input.toMemberId) return null
  const [assignment] = await tx
    .insert(conversationAssignment)
    .values(input)
    .returning({ id: conversationAssignment.id })
  if (!assignment) throw new AssignmentError('INVALID_REQUEST', 'Assignment was not created')
  return assignment.id
}

function unchanged(current: CurrentConversation, memberId: string | null): AssignmentResult {
  return {
    conversationId: current.id,
    assignmentId: null,
    fromMemberId: memberId,
    toMemberId: memberId,
    aiResponseRunId: null,
    messageId: null,
    changed: false,
  }
}

function changed(
  current: CurrentConversation,
  assignmentId: string | null,
  toMemberId: string | null,
  aiResponseRunId: string | null = null,
  messageId: string | null = null,
): AssignmentResult {
  return {
    conversationId: current.id,
    assignmentId,
    fromMemberId: current.assigneeMemberId,
    toMemberId,
    aiResponseRunId,
    messageId,
    changed: true,
  }
}

function later(first: Date | null, second: Date) {
  return !first || second.getTime() > first.getTime() ? second : first
}
