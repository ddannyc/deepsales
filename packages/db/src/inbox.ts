import { and, asc, desc, eq, gt, inArray, isNull, lt, or, sql } from 'drizzle-orm'
import { ensureAiResponseRun } from './assignments'
import type { FacebookInboundAttachmentInput } from './attachments'
import type { Database } from './database'
import {
  channel,
  channelIdentity,
  conversation,
  customer,
  aiResponseRun,
  facebookAttachmentSource,
  facebookChannelConfig,
  facebookMessagingWindow,
  facebookWebhookReceipt,
  member,
  messageAttachment,
  message,
  workspaceUserAccess,
} from './schema'

export type InboxErrorCode = 'FORBIDDEN' | 'NOT_FOUND' | 'INVALID_REQUEST'

export class InboxError extends Error {
  constructor(
    readonly code: InboxErrorCode,
    message: string = code,
  ) {
    super(message)
  }
}

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0]
type QueryHandle = Database | Transaction

export type FacebookInboundMessage = {
  ingressId: string
  pageId: string
  externalUserId: string
  externalMessageId: string
  text: string | null
  attachments?: FacebookInboundAttachmentInput[]
  providerSentAt: Date | null
  receivedAt: Date
  payloadSha256: string
  eventFragment: Record<string, unknown>
}

export async function processFacebookInbound(db: Database, input: FacebookInboundMessage) {
  const attachments = input.attachments ?? []
  if (!input.text && !attachments.length) {
    throw new InboxError('INVALID_REQUEST', 'Message text or attachment is required')
  }

  return db.transaction(async (tx) => {
    const [receipt] = await tx
      .insert(facebookWebhookReceipt)
      .values({
        ingressId: input.ingressId,
        pageId: input.pageId,
        externalMessageId: input.externalMessageId,
        eventFragment: input.eventFragment,
        payloadSha256: input.payloadSha256,
        receivedAt: input.receivedAt,
      })
      .onConflictDoNothing()
      .returning({ id: facebookWebhookReceipt.id })

    if (!receipt) return { kind: 'duplicate-receipt' as const }

    const [activeChannel] = await tx
      .select({ channelId: channel.id, workspaceId: channel.workspaceId })
      .from(channel)
      .innerJoin(facebookChannelConfig, eq(facebookChannelConfig.channelId, channel.id))
      .where(and(eq(facebookChannelConfig.pageId, input.pageId), eq(channel.status, 'ACTIVE')))
      .limit(1)

    if (!activeChannel) {
      await markReceiptProcessed(tx, receipt.id, input.receivedAt)
      return { kind: 'ignored' as const }
    }

    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`${activeChannel.channelId}:${input.externalMessageId}`}, 0))`,
    )
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`${activeChannel.channelId}:${input.externalUserId}`}, 0))`,
    )

    const [duplicate] = await tx
      .select({ id: message.id, conversationId: message.conversationId })
      .from(message)
      .where(
        and(
          eq(message.channelId, activeChannel.channelId),
          eq(message.externalMessageId, input.externalMessageId),
        ),
      )
      .limit(1)
    if (duplicate) {
      await markReceiptProcessed(tx, receipt.id, input.receivedAt)
      return {
        kind: 'duplicate-message' as const,
        workspaceId: activeChannel.workspaceId,
        conversationId: duplicate.conversationId,
        messageId: duplicate.id,
        attachmentIds: await listAttachmentIds(tx, duplicate.id),
      }
    }

    let [identity] = await tx
      .select({ id: channelIdentity.id, customerId: channelIdentity.customerId })
      .from(channelIdentity)
      .where(
        and(
          eq(channelIdentity.channelId, activeChannel.channelId),
          eq(channelIdentity.externalUserId, input.externalUserId),
        ),
      )
      .limit(1)

    if (!identity) {
      const [createdCustomer] = await tx
        .insert(customer)
        .values({ workspaceId: activeChannel.workspaceId })
        .returning({ id: customer.id })
      if (!createdCustomer) throw new InboxError('INVALID_REQUEST', 'Customer was not created')

      const [createdIdentity] = await tx
        .insert(channelIdentity)
        .values({
          workspaceId: activeChannel.workspaceId,
          customerId: createdCustomer.id,
          channelId: activeChannel.channelId,
          externalUserId: input.externalUserId,
        })
        .returning({ id: channelIdentity.id, customerId: channelIdentity.customerId })
      identity = createdIdentity
    }
    if (!identity) throw new InboxError('INVALID_REQUEST', 'Channel identity was not created')

    await tx.execute(sql`select id from channel_identity where id = ${identity.id} for update`)
    await tx.execute(
      sql`select id from conversation where channel_identity_id = ${identity.id} and status = 'OPEN' for update`,
    )
    let [openConversation] = await tx
      .select()
      .from(conversation)
      .where(and(eq(conversation.channelIdentityId, identity.id), eq(conversation.status, 'OPEN')))
      .limit(1)

    const eventAt = input.providerSentAt ?? input.receivedAt
    const now = input.receivedAt
    if (!openConversation) {
      const [created] = await tx
        .insert(conversation)
        .values({
          workspaceId: activeChannel.workspaceId,
          channelIdentityId: identity.id,
          status: 'OPEN',
          queueReason: 'NEW_CONVERSATION',
          routingConstraint: 'ANY_MEMBER',
          routingQueuedAt: now,
          latestMessageAt: eventAt,
          lastCustomerMessageAt: eventAt,
        })
        .returning()
      openConversation = created
    }
    if (!openConversation) throw new InboxError('INVALID_REQUEST', 'Conversation was not created')

    const [createdMessage] = await tx
      .insert(message)
      .values({
        conversationId: openConversation.id,
        channelId: activeChannel.channelId,
        direction: 'INBOUND',
        senderType: 'CUSTOMER',
        messageType: attachments.length ? 'ATTACHMENT' : 'TEXT',
        text: input.text,
        externalMessageId: input.externalMessageId,
        providerSentAt: input.providerSentAt,
      })
      .onConflictDoNothing()
      .returning({ id: message.id, conversationId: message.conversationId })

    if (!createdMessage) {
      const [existing] = await tx
        .select({ id: message.id, conversationId: message.conversationId })
        .from(message)
        .where(
          and(
            eq(message.channelId, activeChannel.channelId),
            eq(message.externalMessageId, input.externalMessageId),
          ),
        )
        .limit(1)
      await markReceiptProcessed(tx, receipt.id, input.receivedAt)
      return {
        kind: 'duplicate-message' as const,
        workspaceId: activeChannel.workspaceId,
        conversationId: existing?.conversationId ?? openConversation.id,
        messageId: existing?.id ?? '',
        attachmentIds: existing ? await listAttachmentIds(tx, existing.id) : [],
      }
    }

    let attachmentIds: string[] = []
    if (attachments.length) {
      const createdAttachments = await tx
        .insert(messageAttachment)
        .values(
          attachments.map((attachment) => ({
            messageId: createdMessage.id,
            kind: attachment.kind,
            filename: attachment.filename ?? null,
            mimeType: attachment.mimeType ?? null,
            storageState: 'PENDING' as const,
            createdAt: now,
            updatedAt: now,
          })),
        )
        .returning({ id: messageAttachment.id })
      if (createdAttachments.length !== attachments.length) {
        throw new InboxError('INVALID_REQUEST', 'Attachments were not created')
      }
      attachmentIds = createdAttachments.map(({ id }) => id).sort()
      await tx.insert(facebookAttachmentSource).values(
        createdAttachments.map(({ id }, index) => {
          const attachment = attachments[index]
          if (!attachment) throw new InboxError('INVALID_REQUEST', 'Attachment is missing')
          return {
            attachmentId: id,
            encryptedSourceUrl: attachment.encryptedSourceUrl,
            urlIv: attachment.urlIv,
            tokenKeyVersion: attachment.tokenKeyVersion ?? 'v1',
            expiresAt: attachment.expiresAt,
            createdAt: now,
            updatedAt: now,
          }
        }),
      )
    }

    const latestMessageAt = later(openConversation.latestMessageAt, eventAt)
    const lastCustomerMessageAt = later(openConversation.lastCustomerMessageAt, eventAt)
    await tx
      .update(conversation)
      .set({
        latestMessageAt,
        lastCustomerMessageAt,
        lastCustomerMessageId:
          !openConversation.lastCustomerMessageAt ||
          eventAt.getTime() >= openConversation.lastCustomerMessageAt.getTime()
            ? createdMessage.id
            : openConversation.lastCustomerMessageId,
        updatedAt: now,
      })
      .where(eq(conversation.id, openConversation.id))

    let aiResponseRunId: string | null = null
    if (openConversation.assigneeMemberId) {
      const [assignee] = await tx
        .select({ type: member.type })
        .from(member)
        .where(eq(member.id, openConversation.assigneeMemberId))
        .limit(1)
      if (assignee?.type === 'AI') {
        aiResponseRunId = await ensureAiResponseRun(tx, {
          conversationId: openConversation.id,
          memberId: openConversation.assigneeMemberId,
          now,
        })
      }
    }

    const eligibleUntil = new Date(eventAt.getTime() + 24 * 60 * 60 * 1_000)
    await tx
      .insert(facebookMessagingWindow)
      .values({
        channelIdentityId: identity.id,
        lastCustomerMessageAt: eventAt,
        eligibleUntil,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: facebookMessagingWindow.channelIdentityId,
        set: {
          lastCustomerMessageAt: sql`greatest(${facebookMessagingWindow.lastCustomerMessageAt}, ${eventAt})`,
          eligibleUntil: sql`greatest(${facebookMessagingWindow.eligibleUntil}, ${eligibleUntil})`,
          updatedAt: now,
        },
      })

    await markReceiptProcessed(tx, receipt.id, input.receivedAt)
    return {
      kind: 'created' as const,
      workspaceId: activeChannel.workspaceId,
      conversationId: openConversation.id,
      messageId: createdMessage.id,
      attachmentIds,
      aiResponseRunId,
    }
  })
}

export type ConversationView = 'my' | 'waiting-human' | 'ai-handling' | 'unassigned' | 'all-open'
export type ConversationCursor = { updatedAt: Date; id: string }

export async function listConversations(
  db: Database,
  input: {
    workspaceId: string
    userId: string
    view: ConversationView
    after?: ConversationCursor
    limit?: number
    conversationId?: string
  },
) {
  const viewer = await assertViewer(db, input.workspaceId, input.userId)
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 100)
  const filters = [eq(conversation.workspaceId, input.workspaceId), eq(conversation.status, 'OPEN')]

  if (input.view === 'my') filters.push(eq(conversation.assigneeMemberId, viewer.memberId))
  if (input.view === 'waiting-human') {
    filters.push(
      isNull(conversation.assigneeMemberId),
      eq(conversation.routingConstraint, 'HUMAN_ONLY'),
    )
  }
  if (input.view === 'ai-handling') {
    filters.push(eq(member.type, 'AI'))
  }
  if (input.view === 'unassigned') filters.push(isNull(conversation.assigneeMemberId))
  if (input.conversationId) filters.push(eq(conversation.id, input.conversationId))
  if (input.after && !input.conversationId) {
    const cursorFilter = or(
      lt(conversation.updatedAt, input.after.updatedAt),
      and(eq(conversation.updatedAt, input.after.updatedAt), lt(conversation.id, input.after.id)),
    )
    if (cursorFilter) filters.push(cursorFilter)
  }

  const rows = await db
    .select({
      id: conversation.id,
      status: conversation.status,
      routingConstraint: conversation.routingConstraint,
      queueReason: conversation.queueReason,
      routingQueuedAt: conversation.routingQueuedAt,
      latestMessageAt: conversation.latestMessageAt,
      lastCustomerMessageAt: conversation.lastCustomerMessageAt,
      updatedAt: conversation.updatedAt,
      customerId: customer.id,
      customerName: customer.displayName,
      channelId: channel.id,
      channelName: channel.displayName,
      assigneeMemberId: conversation.assigneeMemberId,
      assigneeName: member.displayName,
      assigneeType: member.type,
      aiGenerating: sql<boolean>`exists (
        select 1 from ${aiResponseRun} generating_run
        where generating_run.conversation_id = ${conversation.id}
          and generating_run.state in ('QUEUED', 'GENERATING')
      )`,
      latestPreview: message.text,
      failedMessage: sql<boolean>`exists (
        select 1 from message failed_message
        where failed_message.conversation_id = ${conversation.id}
          and failed_message.delivery_state = 'FAILED'
      )`,
    })
    .from(conversation)
    .innerJoin(channelIdentity, eq(channelIdentity.id, conversation.channelIdentityId))
    .innerJoin(customer, eq(customer.id, channelIdentity.customerId))
    .innerJoin(channel, eq(channel.id, channelIdentity.channelId))
    .leftJoin(member, eq(member.id, conversation.assigneeMemberId))
    .leftJoin(message, eq(message.id, conversation.lastCustomerMessageId))
    .where(and(...filters))
    .orderBy(desc(conversation.updatedAt), desc(conversation.id))
    .limit(input.conversationId ? 1 : limit + 1)

  const hasNext = !input.conversationId && rows.length > limit
  const conversations = rows.slice(0, input.conversationId ? 1 : limit).map((row) => ({
    ...row,
    failedMessage: Boolean(row.failedMessage),
  }))
  const last = conversations.at(-1)
  return {
    conversations,
    nextCursor: hasNext && last ? { updatedAt: last.updatedAt, id: last.id } : null,
  }
}

export async function listMessages(
  db: Database,
  input: {
    workspaceId: string
    userId: string
    conversationId: string
    after?: { createdAt: Date; id: string }
    limit?: number
  },
) {
  await assertConversationAccess(db, input)
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 100)
  const filters = [eq(message.conversationId, input.conversationId)]
  if (input.after) {
    const cursorFilter = or(
      gt(message.createdAt, input.after.createdAt),
      and(eq(message.createdAt, input.after.createdAt), gt(message.id, input.after.id)),
    )
    if (cursorFilter) filters.push(cursorFilter)
  }

  const rows = await db
    .select()
    .from(message)
    .where(and(...filters))
    .orderBy(asc(message.createdAt), asc(message.id))
    .limit(limit + 1)
  const hasNext = rows.length > limit
  const messages = rows.slice(0, limit)
  const attachments = messages.length
    ? await db
        .select({
          id: messageAttachment.id,
          messageId: messageAttachment.messageId,
          kind: messageAttachment.kind,
          filename: messageAttachment.filename,
          mimeType: messageAttachment.mimeType,
          byteSize: messageAttachment.byteSize,
          storageState: messageAttachment.storageState,
          failureCode: messageAttachment.failureCode,
        })
        .from(messageAttachment)
        .where(
          inArray(
            messageAttachment.messageId,
            messages.map(({ id }) => id),
          ),
        )
        .orderBy(asc(messageAttachment.createdAt), asc(messageAttachment.id))
    : []
  const attachmentsByMessageId = new Map<string, typeof attachments>()
  for (const attachment of attachments) {
    const current = attachmentsByMessageId.get(attachment.messageId) ?? []
    current.push(attachment)
    attachmentsByMessageId.set(attachment.messageId, current)
  }
  const last = messages.at(-1)
  return {
    messages: messages.map((item) => ({
      ...item,
      attachments: (attachmentsByMessageId.get(item.id) ?? []).map(
        ({ messageId: _messageId, ...attachment }) => attachment,
      ),
    })),
    nextCursor: hasNext && last ? { createdAt: last.createdAt, id: last.id } : null,
  }
}

async function assertViewer(db: QueryHandle, workspaceId: string, userId: string) {
  const [viewer] = await db
    .select({ memberId: member.id, role: workspaceUserAccess.role })
    .from(workspaceUserAccess)
    .innerJoin(member, eq(member.workspaceUserAccessId, workspaceUserAccess.id))
    .where(
      and(eq(workspaceUserAccess.workspaceId, workspaceId), eq(workspaceUserAccess.userId, userId)),
    )
    .limit(1)
  if (!viewer) throw new InboxError('FORBIDDEN', 'Workspace access required')
  return viewer
}

async function assertConversationAccess(
  db: QueryHandle,
  input: { workspaceId: string; userId: string; conversationId: string },
) {
  await assertViewer(db, input.workspaceId, input.userId)
  const [found] = await db
    .select({ id: conversation.id })
    .from(conversation)
    .where(
      and(
        eq(conversation.id, input.conversationId),
        eq(conversation.workspaceId, input.workspaceId),
      ),
    )
    .limit(1)
  if (!found) throw new InboxError('NOT_FOUND', 'Conversation not found')
}

async function markReceiptProcessed(db: QueryHandle, receiptId: string, processedAt: Date) {
  await db
    .update(facebookWebhookReceipt)
    .set({ processedAt })
    .where(eq(facebookWebhookReceipt.id, receiptId))
}

async function listAttachmentIds(db: QueryHandle, messageId: string) {
  const rows = await db
    .select({ id: messageAttachment.id })
    .from(messageAttachment)
    .where(eq(messageAttachment.messageId, messageId))
    .orderBy(asc(messageAttachment.createdAt), asc(messageAttachment.id))
  return rows.map(({ id }) => id)
}

function later(first: Date | null, second: Date) {
  return !first || second.getTime() > first.getTime() ? second : first
}
