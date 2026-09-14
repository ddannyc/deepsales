import { and, eq, sql } from 'drizzle-orm'
import type { Database } from './database'
import {
  channel,
  channelIdentity,
  conversation,
  conversationAssignment,
  member,
  memberChannelAccess,
  workspace,
  workspaceUserAccess,
} from './schema'

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0]

export type AssignmentErrorCode =
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'INVALID_REQUEST'
  | 'ALREADY_ASSIGNED'
  | 'CONVERSATION_CLOSED'

export class AssignmentError extends Error {
  constructor(
    readonly code: AssignmentErrorCode,
    message: string = code,
  ) {
    super(message)
  }
}

export type AssignmentCommand = {
  type: 'TAKEOVER'
  workspaceId: string
  conversationId: string
  actingUserId: string
  now?: Date
}

export async function executeAssignment(tx: Transaction, command: AssignmentCommand) {
  if (command.type !== 'TAKEOVER') throw new AssignmentError('INVALID_REQUEST')

  const now = command.now ?? new Date()
  const workspaceLock = await tx.execute(
    sql`select id from ${workspace} where id = ${command.workspaceId} for update`,
  )
  if (!workspaceLock.rows.length) throw new AssignmentError('NOT_FOUND', 'Workspace not found')

  const conversationLock = await tx.execute(
    sql`select id from ${conversation} where id = ${command.conversationId} and workspace_id = ${command.workspaceId} for update`,
  )
  if (!conversationLock.rows.length) {
    throw new AssignmentError('NOT_FOUND', 'Conversation not found')
  }

  const actorLock = await tx.execute(
    sql`select m.id
        from ${member} m
        inner join ${workspaceUserAccess} a on a.id = m.workspace_user_access_id
        where m.workspace_id = ${command.workspaceId} and a.user_id = ${command.actingUserId}
        for update`,
  )
  if (!actorLock.rows.length) throw new AssignmentError('FORBIDDEN', 'Human member access required')

  const [actor] = await tx
    .select({ id: member.id, type: member.type, status: member.status })
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
    .where(eq(conversation.id, command.conversationId))
    .limit(1)
  if (!current) throw new AssignmentError('NOT_FOUND', 'Conversation not found')
  if (current.status !== 'OPEN') {
    throw new AssignmentError('CONVERSATION_CLOSED', 'Conversation is closed')
  }

  const [access] = await tx
    .select({ memberId: memberChannelAccess.memberId })
    .from(memberChannelAccess)
    .innerJoin(member, eq(member.id, memberChannelAccess.memberId))
    .where(
      and(
        eq(memberChannelAccess.memberId, actor.id),
        eq(memberChannelAccess.channelId, current.channelId),
        eq(member.workspaceId, command.workspaceId),
      ),
    )
    .limit(1)
  if (!access) throw new AssignmentError('FORBIDDEN', 'Channel access is required')

  if (current.assigneeMemberId === actor.id) {
    return {
      conversationId: current.id,
      assignmentId: null,
      fromMemberId: actor.id,
      toMemberId: actor.id,
      changed: false,
    }
  }
  if (
    current.assigneeMemberId &&
    (current.assigneeType !== 'AI' || current.assigneeWorkspaceId !== command.workspaceId)
  ) {
    throw new AssignmentError('ALREADY_ASSIGNED', 'Conversation is already assigned')
  }

  const [assignment] = await tx
    .insert(conversationAssignment)
    .values({
      conversationId: current.id,
      fromMemberId: current.assigneeMemberId,
      toMemberId: actor.id,
      reason: 'TAKEOVER',
      actingMemberId: actor.id,
      createdAt: now,
    })
    .returning({ id: conversationAssignment.id })
  if (!assignment) throw new AssignmentError('INVALID_REQUEST', 'Assignment was not created')

  await tx
    .update(conversation)
    .set({
      assigneeMemberId: actor.id,
      queueReason: null,
      routingQueuedAt: null,
      updatedAt: now,
    })
    .where(eq(conversation.id, current.id))

  return {
    conversationId: current.id,
    assignmentId: assignment.id,
    fromMemberId: current.assigneeMemberId,
    toMemberId: actor.id,
    changed: true,
  }
}

export async function takeOverConversation(
  db: Database,
  input: { workspaceId: string; conversationId: string; actingUserId: string; now?: Date },
) {
  return db.transaction((tx) => executeAssignment(tx, { type: 'TAKEOVER', ...input }))
}
