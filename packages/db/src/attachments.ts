import { and, asc, eq, gt, inArray, isNull, lte, or, sql } from 'drizzle-orm'
import type { Database } from './database'
import { assertInboxConversationAccess, InboxError } from './inbox'
import {
  conversation,
  facebookAttachmentSource,
  message,
  messageAttachment,
  workspaceUserAccess,
} from './schema'

export const FACEBOOK_ATTACHMENT_CLAIM_TIMEOUT_MS = 5 * 60 * 1_000
export const MAX_INBOUND_ATTACHMENT_BYTES = 25 * 1024 * 1024

export type MessageAttachmentKind = 'IMAGE' | 'FILE' | 'AUDIO' | 'VIDEO'

export type FacebookInboundAttachmentInput = {
  kind: MessageAttachmentKind
  filename?: string | null
  mimeType?: string | null
  encryptedSourceUrl: string
  urlIv: string
  tokenKeyVersion?: string
  expiresAt: Date
}

export type ClaimedFacebookAttachment = {
  id: string
  messageId: string
  workspaceId: string
  kind: MessageAttachmentKind
  filename: string | null
  mimeType: string | null
  encryptedSourceUrl: string | null
  urlIv: string | null
  tokenKeyVersion: string | null
  expiresAt: Date | null
  processingStartedAt: Date
}

export type FacebookAttachmentDownload = {
  id: string
  kind: MessageAttachmentKind
  filename: string | null
  mimeType: string | null
  storageKey: string
}

export type AttachmentErrorCode = 'FORBIDDEN' | 'NOT_FOUND'

export class AttachmentError extends Error {
  constructor(
    readonly code: AttachmentErrorCode,
    message: string = code,
  ) {
    super(message)
  }
}

export async function claimFacebookInboundAttachment(
  db: Database,
  input: { attachmentId: string; now?: Date; claimTimeoutMs?: number },
) {
  const now = input.now ?? new Date()
  const cutoff = new Date(
    now.getTime() - (input.claimTimeoutMs ?? FACEBOOK_ATTACHMENT_CLAIM_TIMEOUT_MS),
  )
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({
        id: messageAttachment.id,
        messageId: messageAttachment.messageId,
        workspaceId: conversation.workspaceId,
        kind: messageAttachment.kind,
        filename: messageAttachment.filename,
        mimeType: messageAttachment.mimeType,
        storageState: messageAttachment.storageState,
        processingStartedAt: messageAttachment.processingStartedAt,
        encryptedSourceUrl: facebookAttachmentSource.encryptedSourceUrl,
        urlIv: facebookAttachmentSource.urlIv,
        tokenKeyVersion: facebookAttachmentSource.tokenKeyVersion,
        expiresAt: facebookAttachmentSource.expiresAt,
      })
      .from(messageAttachment)
      .innerJoin(message, eq(message.id, messageAttachment.messageId))
      .innerJoin(conversation, eq(conversation.id, message.conversationId))
      .innerJoin(
        facebookAttachmentSource,
        eq(facebookAttachmentSource.attachmentId, messageAttachment.id),
      )
      .where(eq(messageAttachment.id, input.attachmentId))
      .for('update')
      .limit(1)

    if (current?.storageState !== 'PENDING') return null
    if (current.processingStartedAt && current.processingStartedAt.getTime() > cutoff.getTime()) {
      return null
    }

    const [claimed] = await tx
      .update(messageAttachment)
      .set({ processingStartedAt: now, updatedAt: now })
      .where(
        and(
          eq(messageAttachment.id, input.attachmentId),
          eq(messageAttachment.storageState, 'PENDING'),
          or(
            isNull(messageAttachment.processingStartedAt),
            lte(messageAttachment.processingStartedAt, cutoff),
          ),
        ),
      )
      .returning({ id: messageAttachment.id })
    if (!claimed) return null

    return {
      ...current,
      processingStartedAt: now,
    }
  })
}

export async function completeFacebookInboundAttachment(
  db: Database,
  input: {
    attachmentId: string
    storageKey: string
    byteSize: number
    mimeType: string | null
    processingStartedAt?: Date
    now?: Date
  },
) {
  const now = input.now ?? new Date()
  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(messageAttachment)
      .set({
        storageKey: input.storageKey,
        byteSize: input.byteSize,
        mimeType: input.mimeType,
        storageState: 'READY',
        processingStartedAt: null,
        failureCode: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(messageAttachment.id, input.attachmentId),
          eq(messageAttachment.storageState, 'PENDING'),
          input.processingStartedAt
            ? eq(messageAttachment.processingStartedAt, input.processingStartedAt)
            : sql`${messageAttachment.processingStartedAt} is not null`,
        ),
      )
      .returning({
        id: messageAttachment.id,
        messageId: messageAttachment.messageId,
      })
    if (!updated) return null

    await tx
      .delete(facebookAttachmentSource)
      .where(eq(facebookAttachmentSource.attachmentId, input.attachmentId))
    return updated
  })
}

export async function failFacebookInboundAttachment(
  db: Database,
  input: {
    attachmentId: string
    failureCode: string
    processingStartedAt?: Date
    now?: Date
  },
) {
  const now = input.now ?? new Date()
  return db
    .update(messageAttachment)
    .set({
      storageState: 'FAILED',
      processingStartedAt: null,
      failureCode: input.failureCode.slice(0, 100),
      updatedAt: now,
    })
    .where(
      and(
        eq(messageAttachment.id, input.attachmentId),
        eq(messageAttachment.storageState, 'PENDING'),
        input.processingStartedAt
          ? eq(messageAttachment.processingStartedAt, input.processingStartedAt)
          : sql`${messageAttachment.processingStartedAt} is not null`,
      ),
    )
    .returning({ id: messageAttachment.id, messageId: messageAttachment.messageId })
}

export async function releaseFacebookInboundAttachment(
  db: Database,
  input: { attachmentId: string; processingStartedAt: Date; now?: Date },
) {
  const now = input.now ?? new Date()
  return db
    .update(messageAttachment)
    .set({ processingStartedAt: null, updatedAt: now })
    .where(
      and(
        eq(messageAttachment.id, input.attachmentId),
        eq(messageAttachment.storageState, 'PENDING'),
        eq(messageAttachment.processingStartedAt, input.processingStartedAt),
      ),
    )
    .returning({ id: messageAttachment.id })
}

export async function expireFacebookInboundAttachments(
  db: Database,
  input: { now?: Date; limit?: number } = {},
) {
  const now = input.now ?? new Date()
  const cutoff = new Date(now.getTime() - FACEBOOK_ATTACHMENT_CLAIM_TIMEOUT_MS)
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 100)
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({
        id: messageAttachment.id,
        messageId: messageAttachment.messageId,
        workspaceId: conversation.workspaceId,
      })
      .from(messageAttachment)
      .innerJoin(
        facebookAttachmentSource,
        eq(facebookAttachmentSource.attachmentId, messageAttachment.id),
      )
      .innerJoin(message, eq(message.id, messageAttachment.messageId))
      .innerJoin(conversation, eq(conversation.id, message.conversationId))
      .where(
        and(
          eq(messageAttachment.storageState, 'PENDING'),
          or(
            isNull(messageAttachment.processingStartedAt),
            lte(messageAttachment.processingStartedAt, cutoff),
          ),
          lte(facebookAttachmentSource.expiresAt, now),
        ),
      )
      .orderBy(asc(facebookAttachmentSource.expiresAt), asc(messageAttachment.id))
      .limit(limit)
      .for('update', { skipLocked: true })
    if (!rows.length) return []

    await tx
      .update(messageAttachment)
      .set({
        storageState: 'FAILED',
        processingStartedAt: null,
        failureCode: 'SOURCE_EXPIRED',
        updatedAt: now,
      })
      .where(
        and(
          inArray(
            messageAttachment.id,
            rows.map(({ id }) => id),
          ),
          eq(messageAttachment.storageState, 'PENDING'),
          or(
            isNull(messageAttachment.processingStartedAt),
            lte(messageAttachment.processingStartedAt, cutoff),
          ),
        ),
      )
    return rows
  })
}

export async function listPendingFacebookInboundAttachmentIds(
  db: Database,
  input: { now?: Date; limit?: number } = {},
) {
  const now = input.now ?? new Date()
  const cutoff = new Date(now.getTime() - FACEBOOK_ATTACHMENT_CLAIM_TIMEOUT_MS)
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 100)
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({ id: messageAttachment.id })
      .from(messageAttachment)
      .innerJoin(
        facebookAttachmentSource,
        eq(facebookAttachmentSource.attachmentId, messageAttachment.id),
      )
      .where(
        and(
          eq(messageAttachment.storageState, 'PENDING'),
          gt(facebookAttachmentSource.expiresAt, now),
          or(
            isNull(messageAttachment.processingStartedAt),
            lte(messageAttachment.processingStartedAt, cutoff),
          ),
        ),
      )
      .orderBy(asc(messageAttachment.updatedAt), asc(messageAttachment.id))
      .limit(limit)
      .for('update', { skipLocked: true })
    return rows.map(({ id }) => id)
  })
}

export async function getFacebookAttachmentForDownload(
  db: Database,
  input: { workspaceId: string; userId: string; attachmentId: string },
) {
  const [access] = await db
    .select({ id: workspaceUserAccess.id })
    .from(workspaceUserAccess)
    .where(
      and(
        eq(workspaceUserAccess.workspaceId, input.workspaceId),
        eq(workspaceUserAccess.userId, input.userId),
      ),
    )
    .limit(1)
  if (!access) throw new AttachmentError('FORBIDDEN', 'Workspace access required')

  const [attachment] = await db
    .select({
      id: messageAttachment.id,
      conversationId: conversation.id,
      kind: messageAttachment.kind,
      filename: messageAttachment.filename,
      mimeType: messageAttachment.mimeType,
      storageKey: messageAttachment.storageKey,
      storageState: messageAttachment.storageState,
    })
    .from(messageAttachment)
    .innerJoin(message, eq(message.id, messageAttachment.messageId))
    .innerJoin(conversation, eq(conversation.id, message.conversationId))
    .where(
      and(
        eq(messageAttachment.id, input.attachmentId),
        eq(conversation.workspaceId, input.workspaceId),
      ),
    )
    .limit(1)
  if (attachment) {
    try {
      await assertInboxConversationAccess(db, {
        ...input,
        conversationId: attachment.conversationId,
      })
    } catch (error) {
      if (error instanceof InboxError)
        throw new AttachmentError(error.code === 'NOT_FOUND' ? 'NOT_FOUND' : 'FORBIDDEN')
      throw error
    }
  }
  if (attachment?.storageState !== 'READY' || !attachment.storageKey) {
    throw new AttachmentError('NOT_FOUND', 'Attachment not found')
  }
  return {
    id: attachment.id,
    kind: attachment.kind,
    filename: attachment.filename,
    mimeType: attachment.mimeType,
    storageKey: attachment.storageKey,
  }
}
