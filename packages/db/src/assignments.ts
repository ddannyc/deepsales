import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import type { Database } from './database'
import {
  channel,
  channelIdentity,
  conversation,
  conversationAssignment,
  humanMemberAvailability,
  member,
  memberChannelAccess,
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
  changed: boolean
}

type CurrentConversation = {
  id: string
  status: 'OPEN' | 'CLOSED'
  assigneeMemberId: string | null
  assigneeType: 'HUMAN' | 'AI' | null
  assigneeWorkspaceId: string | null
  channelId: string
}

export async function executeAssignment(tx: Transaction, command: AssignmentCommand) {
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
        routingQueuedAt: null,
        updatedAt: now,
      })
      .where(eq(conversation.id, current.id))
    return changed(current, assignmentId, target.id)
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

async function lockConversation(tx: Transaction, command: CommandBase) {
  const conversationLock = await tx.execute(
    sql`select id from ${conversation} where id = ${command.conversationId} and workspace_id = ${command.workspaceId} for update`,
  )
  if (!conversationLock.rows.length) {
    throw new AssignmentError('NOT_FOUND', 'Conversation not found')
  }
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
    })
    .from(member)
    .leftJoin(humanMemberAvailability, eq(humanMemberAvailability.memberId, member.id))
    .where(and(eq(member.id, command.targetMemberId), eq(member.workspaceId, command.workspaceId)))
    .limit(1)
  if (target?.type !== 'HUMAN' || target.status !== 'ACTIVE') {
    throw new AssignmentError('INVALID_TARGET', 'An active human target is required')
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
  const unavailable = target.available === false
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
    reason: 'TAKEOVER' | 'MANUAL_TRANSFER' | 'MANUAL_UNASSIGN' | 'MEMBER_DISABLED' | 'CLOSE'
    actingMemberId: string
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
    changed: false,
  }
}

function changed(
  current: CurrentConversation,
  assignmentId: string | null,
  toMemberId: string | null,
): AssignmentResult {
  return {
    conversationId: current.id,
    assignmentId,
    fromMemberId: current.assigneeMemberId,
    toMemberId,
    changed: true,
  }
}
