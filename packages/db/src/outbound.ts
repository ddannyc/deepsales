import { and, asc, desc, eq, isNotNull, isNull, lte, sql } from 'drizzle-orm'
import type { Database } from './database'
import {
  channelIdentity,
  conversation,
  deliveryAttempt,
  member,
  memberChannelAccess,
  mediaAsset,
  messageAttachment,
  message,
  workspaceUserAccess,
} from './schema'

export const MAX_OUTBOUND_TEXT_LENGTH = 2_000
export const OUTBOUND_CLAIM_TIMEOUT_MS = 5 * 60 * 1_000

export type ReplyErrorCode =
  | 'RETRY_LATER'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'INVALID_REQUEST'
  | 'CONVERSATION_CLOSED'
  | 'REPLY_WINDOW_CLOSED'
  | 'RETRY_NOT_READY'
  | 'RETRY_LIMIT_REACHED'

export class ReplyError extends Error {
  constructor(
    readonly code: ReplyErrorCode,
    message: string = code,
    readonly retryAfterMs = 0,
  ) {
    super(message)
  }
}

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0]
export type HumanReplyInput = {
  workspaceId: string
  conversationId: string
  actingUserId: string
  text?: string
  assetId?: string
  clientKey?: string
  now?: Date
}
type ReplyWindowCheck = (tx: Transaction, channelIdentityId: string, now: Date) => Promise<boolean>

export async function createHumanReply(
  db: Database,
  input: HumanReplyInput,
  isReplyWindowOpen: ReplyWindowCheck,
) {
  const text = input.text?.trim() ?? ''
  if (Boolean(text) === Boolean(input.assetId) || (input.assetId && !input.clientKey))
    throw new ReplyError('INVALID_REQUEST', 'Provide text or one media asset')
  if (text.length > MAX_OUTBOUND_TEXT_LENGTH) {
    throw new ReplyError('INVALID_REQUEST', 'Text is too long')
  }

  const now = input.now ?? new Date()
  return db.transaction(async (tx) => {
    const conversationLock = await tx.execute(
      sql`select id
          from ${conversation}
          where id = ${input.conversationId} and workspace_id = ${input.workspaceId}
          for update`,
    )
    if (!conversationLock.rows.length) throw new ReplyError('NOT_FOUND', 'Conversation not found')

    const [viewer] = await tx
      .select({ memberId: member.id, type: member.type, status: member.status })
      .from(member)
      .innerJoin(workspaceUserAccess, eq(workspaceUserAccess.id, member.workspaceUserAccessId))
      .where(
        and(
          eq(member.workspaceId, input.workspaceId),
          eq(workspaceUserAccess.userId, input.actingUserId),
        ),
      )
      .limit(1)
    if (viewer?.type !== 'HUMAN' || viewer.status !== 'ACTIVE') {
      throw new ReplyError('FORBIDDEN', 'An active human member is required')
    }

    const [current] = await tx
      .select({
        id: conversation.id,
        status: conversation.status,
        assigneeMemberId: conversation.assigneeMemberId,
        channelIdentityId: conversation.channelIdentityId,
        channelId: channelIdentity.channelId,
        latestMessageAt: conversation.latestMessageAt,
      })
      .from(conversation)
      .innerJoin(channelIdentity, eq(channelIdentity.id, conversation.channelIdentityId))
      .where(eq(conversation.id, input.conversationId))
      .limit(1)
    if (!current) throw new ReplyError('NOT_FOUND', 'Conversation not found')
    const [channelAccess] = await tx
      .select({ id: memberChannelAccess.memberId })
      .from(memberChannelAccess)
      .where(
        and(
          eq(memberChannelAccess.memberId, viewer.memberId),
          eq(memberChannelAccess.channelId, current.channelId),
        ),
      )
    if (!channelAccess) throw new ReplyError('FORBIDDEN', 'Channel access required')

    if (input.clientKey) {
      const [existing] = await tx
        .select()
        .from(message)
        .where(
          and(
            eq(message.conversationId, input.conversationId),
            eq(message.senderMemberId, viewer.memberId),
            eq(message.clientKey, input.clientKey),
          ),
        )
      if (existing) {
        const [attachment] = await tx
          .select({ assetId: messageAttachment.assetId })
          .from(messageAttachment)
          .where(eq(messageAttachment.messageId, existing.id))
        if ((existing.text ?? '') !== text || (attachment?.assetId ?? undefined) !== input.assetId)
          throw new ReplyError('INVALID_REQUEST', 'Retry key already used')
        return { message: existing }
      }
    }

    if (current.status !== 'OPEN') {
      throw new ReplyError('CONVERSATION_CLOSED', 'Conversation is closed')
    }
    if (current.assigneeMemberId !== viewer.memberId) {
      throw new ReplyError('FORBIDDEN', 'Only the current human assignee may reply')
    }

    if (!(await isReplyWindowOpen(tx, current.channelIdentityId, now))) {
      throw new ReplyError('REPLY_WINDOW_CLOSED', 'Messenger reply window is closed')
    }

    const [asset] = input.assetId
      ? await tx
          .select()
          .from(mediaAsset)
          .where(
            and(
              eq(mediaAsset.id, input.assetId),
              eq(mediaAsset.workspaceId, input.workspaceId),
              isNull(mediaAsset.deletedAt),
            ),
          )
          .for('share')
      : []
    if (input.assetId && !asset) throw new ReplyError('NOT_FOUND', 'Media asset is unavailable')
    const [created] = await tx
      .insert(message)
      .values({
        conversationId: current.id,
        channelId: current.channelId,
        direction: 'OUTBOUND',
        senderType: 'MEMBER',
        senderMemberId: viewer.memberId,
        messageType: asset ? 'ATTACHMENT' : 'TEXT',
        text: asset ? null : text,
        clientKey: input.clientKey,
        deliveryState: 'PENDING',
        createdAt: sql`clock_timestamp()`,
        updatedAt: now,
      })
      .returning()
    if (!created) throw new ReplyError('INVALID_REQUEST', 'Message was not created')
    if (asset)
      await tx.insert(messageAttachment).values({
        messageId: created.id,
        assetId: asset.id,
        kind: asset.kind,
        filename: asset.filename,
        mimeType: asset.mimeType,
        byteSize: asset.byteSize,
        storageKey: asset.storageKey,
        storageState: 'READY',
      })

    await tx
      .update(conversation)
      .set({
        latestMessageAt: later(current.latestMessageAt, now),
        lastOutboundMessageAt: now,
        updatedAt: now,
      })
      .where(eq(conversation.id, current.id))

    return { message: created }
  })
}

export async function claimOutboundMessage(
  db: Database,
  input: { messageId: string; now?: Date; claimTimeoutMs?: number },
) {
  const now = input.now ?? new Date()
  const timeout = input.claimTimeoutMs ?? OUTBOUND_CLAIM_TIMEOUT_MS
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({
        id: message.id,
        deliveryState: message.deliveryState,
        deliveryStartedAt: message.deliveryStartedAt,
        replyGroupId: message.replyGroupId,
        replySegmentIndex: message.replySegmentIndex,
      })
      .from(message)
      .where(and(eq(message.id, input.messageId), eq(message.direction, 'OUTBOUND')))
      .for('update')
      .limit(1)
    if (!current) return null

    if (current.deliveryState !== 'PENDING' || current.deliveryStartedAt) {
      if (
        current.deliveryState === 'PENDING' &&
        current.deliveryStartedAt &&
        current.deliveryStartedAt.getTime() <= now.getTime() - timeout
      ) {
        await failClaimedMessage(
          tx,
          current.id,
          now,
          'AMBIGUOUS_DELIVERY',
          'Delivery result was ambiguous',
        )
      }
      return null
    }

    if (current.replyGroupId && current.replySegmentIndex && current.replySegmentIndex > 1) {
      const [previous] = await tx
        .select({ state: message.deliveryState, completedAt: message.deliveryCompletedAt })
        .from(message)
        .where(
          and(
            eq(message.replyGroupId, current.replyGroupId),
            eq(message.replySegmentIndex, current.replySegmentIndex - 1),
          ),
        )
      if (previous?.state === 'FAILED' || !previous) {
        await tx
          .update(message)
          .set({
            deliveryState: 'FAILED',
            failureCode: 'REPLY_SEGMENT_BLOCKED',
            failureMessage: 'Previous reply segment failed; sending is paused',
            deliveryCompletedAt: now,
            updatedAt: now,
          })
          .where(eq(message.id, current.id))
        return null
      }
      const delay = previous.completedAt
        ? previous.completedAt.getTime() + 1000 - now.getTime()
        : 1000
      if (previous.state !== 'SENT' || delay > 0)
        throw new ReplyError('RETRY_LATER', 'Previous reply segment is pending', Math.max(1, delay))
    }
    const [claimed] = await tx
      .update(message)
      .set({ deliveryStartedAt: now, updatedAt: now })
      .where(
        and(
          eq(message.id, current.id),
          eq(message.deliveryState, 'PENDING'),
          isNull(message.deliveryStartedAt),
        ),
      )
      .returning({ id: message.id })
    if (!claimed) return null

    const [lastAttempt] = await tx
      .select({ attemptNumber: deliveryAttempt.attemptNumber })
      .from(deliveryAttempt)
      .where(eq(deliveryAttempt.messageId, current.id))
      .orderBy(desc(deliveryAttempt.attemptNumber))
      .limit(1)

    const [attempt] = await tx
      .insert(deliveryAttempt)
      .values({
        messageId: current.id,
        attemptNumber: (lastAttempt?.attemptNumber ?? 0) + 1,
        startedAt: now,
      })
      .returning({
        id: deliveryAttempt.id,
        attemptNumber: deliveryAttempt.attemptNumber,
      })
    if (!attempt) throw new ReplyError('INVALID_REQUEST', 'Delivery attempt was not created')

    const [delivery] = await tx
      .select({
        id: message.id,
        conversationId: message.conversationId,
        workspaceId: conversation.workspaceId,
        channelId: message.channelId,
        text: message.text,
        messageType: message.messageType,
        deliveryStartedAt: message.deliveryStartedAt,
      })
      .from(message)
      .innerJoin(conversation, eq(conversation.id, message.conversationId))
      .where(eq(message.id, current.id))
      .limit(1)
    if (!delivery) throw new ReplyError('NOT_FOUND', 'Message was not found')
    return { ...delivery, attemptId: attempt.id, attemptNumber: attempt.attemptNumber }
  })
}

export async function releaseOutboundMessage(
  db: Database,
  input: {
    messageId: string
    attemptId: string
    attempt?: {
      httpStatus?: number | null
      code?: number | null
      subcode?: number | null
      type?: string | null
      message?: string | null
    }
    now?: Date
  },
) {
  const now = input.now ?? new Date()
  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(message)
      .set({ deliveryStartedAt: null, updatedAt: now })
      .where(
        and(
          eq(message.id, input.messageId),
          eq(message.direction, 'OUTBOUND'),
          eq(message.deliveryState, 'PENDING'),
          isNotNull(message.deliveryStartedAt),
        ),
      )
      .returning({ id: message.id })
    if (!updated) return null

    await tx
      .update(deliveryAttempt)
      .set({
        httpStatus: input.attempt?.httpStatus ?? null,
        code: input.attempt?.code ?? null,
        subcode: input.attempt?.subcode ?? null,
        type: input.attempt?.type ?? null,
        message: input.attempt?.message?.slice(0, 500) ?? null,
        completedAt: now,
      })
      .where(
        and(
          eq(deliveryAttempt.id, input.attemptId),
          eq(deliveryAttempt.messageId, input.messageId),
          isNull(deliveryAttempt.completedAt),
        ),
      )
    return updated
  })
}

export async function recoverStaleOutboundMessages(
  db: Database,
  input: { now?: Date; limit?: number } = {},
) {
  const now = input.now ?? new Date()
  const cutoff = new Date(now.getTime() - OUTBOUND_CLAIM_TIMEOUT_MS)
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 100)
  return db.transaction(async (tx) => {
    const stale = await tx
      .select({ id: message.id, workspaceId: conversation.workspaceId })
      .from(message)
      .innerJoin(conversation, eq(conversation.id, message.conversationId))
      .where(
        and(
          eq(message.direction, 'OUTBOUND'),
          eq(message.deliveryState, 'PENDING'),
          isNotNull(message.deliveryStartedAt),
          lte(message.deliveryStartedAt, cutoff),
        ),
      )
      .orderBy(asc(message.deliveryStartedAt))
      .limit(limit)
      .for('update', { skipLocked: true })

    for (const item of stale) {
      await failClaimedMessage(
        tx,
        item.id,
        now,
        'AMBIGUOUS_DELIVERY',
        'Delivery result was ambiguous',
      )
    }
    return stale
  })
}

export async function listUnclaimedOutboundMessageIds(db: Database, limit = 100) {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({ id: message.id })
      .from(message)
      .where(
        and(
          eq(message.direction, 'OUTBOUND'),
          eq(message.deliveryState, 'PENDING'),
          isNull(message.deliveryStartedAt),
        ),
      )
      .orderBy(asc(message.createdAt), asc(message.id))
      .limit(Math.min(Math.max(limit, 1), 100))
      .for('update', { skipLocked: true })
    return rows.map(({ id }) => id)
  })
}

export async function completeOutboundMessage(
  db: Database,
  input: { messageId: string; attemptId: string; externalMessageId: string; now?: Date },
) {
  const now = input.now ?? new Date()
  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(message)
      .set({
        deliveryState: 'SENT',
        externalMessageId: input.externalMessageId,
        providerSentAt: null,
        deliveryCompletedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(message.id, input.messageId),
          eq(message.direction, 'OUTBOUND'),
          eq(message.deliveryState, 'PENDING'),
          sql`${message.deliveryStartedAt} is not null`,
        ),
      )
      .returning()
    if (!updated) return null
    await tx
      .update(deliveryAttempt)
      .set({ completedAt: now })
      .where(eq(deliveryAttempt.id, input.attemptId))
    return updated
  })
}

export async function failOutboundMessage(
  db: Database,
  input: {
    messageId: string
    attemptId: string
    failureCode: string
    failureMessage: string
    attempt?: {
      httpStatus?: number | null
      retryNotBefore?: Date | null
      code?: number | null
      subcode?: number | null
      type?: string | null
      message?: string | null
    }
    now?: Date
  },
) {
  const now = input.now ?? new Date()
  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(message)
      .set({
        deliveryState: 'FAILED',
        deliveryCompletedAt: now,
        failureCode: input.failureCode,
        failureMessage: input.failureMessage.slice(0, 500),
        updatedAt: now,
      })
      .where(
        and(
          eq(message.id, input.messageId),
          eq(message.direction, 'OUTBOUND'),
          eq(message.deliveryState, 'PENDING'),
          sql`${message.deliveryStartedAt} is not null`,
        ),
      )
      .returning()
    if (!updated) return null
    await tx
      .update(deliveryAttempt)
      .set({
        httpStatus: input.attempt?.httpStatus ?? null,
        retryNotBefore: input.attempt?.retryNotBefore ?? null,
        code: input.attempt?.code ?? null,
        subcode: input.attempt?.subcode ?? null,
        type: input.attempt?.type ?? null,
        message: input.attempt?.message?.slice(0, 500) ?? null,
        completedAt: now,
      })
      .where(eq(deliveryAttempt.id, input.attemptId))
    return updated
  })
}

async function failClaimedMessage(
  tx: Transaction,
  messageId: string,
  now: Date,
  failureCode: string,
  failureMessage: string,
) {
  await tx
    .update(message)
    .set({
      deliveryState: 'FAILED',
      deliveryCompletedAt: now,
      failureCode,
      failureMessage,
      updatedAt: now,
    })
    .where(and(eq(message.id, messageId), eq(message.deliveryState, 'PENDING')))
  await tx
    .update(deliveryAttempt)
    .set({ message: failureMessage, completedAt: now })
    .where(and(eq(deliveryAttempt.messageId, messageId), isNull(deliveryAttempt.completedAt)))
}

function later(first: Date | null, second: Date) {
  return !first || second.getTime() > first.getTime() ? second : first
}
