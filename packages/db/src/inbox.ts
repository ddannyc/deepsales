import { and, asc, desc, eq, getTableColumns, inArray, isNull, lt, sql } from 'drizzle-orm'
import { ensureAiResponseRun } from './assignments'
import type { FacebookInboundAttachmentInput } from './attachments'
import type { Database } from './database'
import {
  aiResponseRun,
  channel,
  channelIdentity,
  conversation,
  conversationMemberMute,
  conversationMemberRead,
  customer,
  customerPropertyDefinition,
  customerPropertyValue,
  customerTag,
  customerTagDefinition,
  facebookAttachmentSource,
  facebookChannelConfig,
  facebookMessagingWindow,
  facebookWebhookReceipt,
  member,
  memberChannelAccess,
  message,
  messageAttachment,
  messageMemberRead,
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

export const FACEBOOK_WEBHOOK_RECEIPT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000

// Caller holds the channel/user advisory lock so referral and message intake share one identity.
export async function ensureFacebookIdentity(
  tx: Transaction,
  input: { channelId: string; workspaceId: string; externalUserId: string },
) {
  let [identity] = await tx
    .select({ id: channelIdentity.id, customerId: channelIdentity.customerId })
    .from(channelIdentity)
    .where(
      and(
        eq(channelIdentity.channelId, input.channelId),
        eq(channelIdentity.externalUserId, input.externalUserId),
      ),
    )
    .limit(1)
  if (!identity) {
    const [createdCustomer] = await tx
      .insert(customer)
      .values({ workspaceId: input.workspaceId })
      .returning({ id: customer.id })
    if (!createdCustomer) throw new InboxError('INVALID_REQUEST', 'Customer was not created')
    const [createdIdentity] = await tx
      .insert(channelIdentity)
      .values({ ...input, customerId: createdCustomer.id })
      .returning({ id: channelIdentity.id, customerId: channelIdentity.customerId })
    identity = createdIdentity
  }
  if (!identity) throw new InboxError('INVALID_REQUEST', 'Channel identity was not created')
  return identity
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

    const identity = await ensureFacebookIdentity(tx, {
      ...activeChannel,
      externalUserId: input.externalUserId,
    })

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
        createdAt: sql`clock_timestamp()`,
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
        lastCustomerMessageId: createdMessage.id,
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

export async function deleteOldFacebookWebhookReceipts(
  db: Database,
  input: { now?: Date; retentionMs?: number; limit?: number } = {},
) {
  const now = input.now ?? new Date()
  const cutoff = new Date(
    now.getTime() - (input.retentionMs ?? FACEBOOK_WEBHOOK_RECEIPT_RETENTION_MS),
  )
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 100)

  return db.transaction(async (tx) => {
    const stale = await tx
      .select({ id: facebookWebhookReceipt.id })
      .from(facebookWebhookReceipt)
      .where(lt(facebookWebhookReceipt.receivedAt, cutoff))
      .orderBy(asc(facebookWebhookReceipt.receivedAt), asc(facebookWebhookReceipt.id))
      .limit(limit)
      .for('update', { skipLocked: true })
    if (!stale.length) return 0

    const deleted = await tx
      .delete(facebookWebhookReceipt)
      .where(
        inArray(
          facebookWebhookReceipt.id,
          stale.map(({ id }) => id),
        ),
      )
      .returning({ id: facebookWebhookReceipt.id })
    return deleted.length
  })
}

export type ConversationView =
  | 'my'
  | 'waiting-human'
  | 'ai-handling'
  | 'unassigned'
  | 'all-open'
  | 'closed'
  | 'team'
export type ConversationCursor = { updatedAt: Date | string; id: string }

export type InboxFilters = {
  view: ConversationView
  query?: string
  memberIds?: string[]
  tagIds?: string[]
  customerId?: string
  channelId?: string
  createdFrom?: string
  createdTo?: string
  updatedFrom?: string
  updatedTo?: string
  attention?: 'unread' | 'unanswered'
  mute?: 'muted' | 'unmuted'
  properties?: { definitionId: string; value: string | number }[]
}

export async function inboxFilterOptions(
  db: QueryHandle,
  input: { workspaceId: string; userId: string },
) {
  const viewer = await assertInboxViewer(db, input.workspaceId, input.userId)
  const members = await db
    .select({ id: member.id, name: member.displayName })
    .from(member)
    .where(
      and(
        eq(member.workspaceId, input.workspaceId),
        eq(member.status, 'ACTIVE'),
        viewer.role === 'AGENT'
          ? sql`exists (select 1 from ${memberChannelAccess} target join ${memberChannelAccess} own on target.channel_id = own.channel_id where target.member_id = ${member.id} and own.member_id = ${viewer.memberId})`
          : undefined,
      ),
    )
    .orderBy(member.displayName, member.id)
  const tags = await db
    .select()
    .from(customerTagDefinition)
    .where(eq(customerTagDefinition.workspaceId, input.workspaceId))
    .orderBy(customerTagDefinition.name)
  const properties = await db
    .select()
    .from(customerPropertyDefinition)
    .where(
      and(
        eq(customerPropertyDefinition.workspaceId, input.workspaceId),
        isNull(customerPropertyDefinition.deletedAt),
      ),
    )
    .orderBy(customerPropertyDefinition.name)
  return { members, tags, properties }
}

export async function validateInboxFilters(
  db: QueryHandle,
  input: { workspaceId: string; userId: string },
  filters: InboxFilters,
) {
  if (
    !filters.memberIds?.length &&
    !filters.tagIds?.length &&
    !filters.properties?.length &&
    !filters.customerId
  )
    return
  const options = await inboxFilterOptions(db, input)
  if (
    filters.memberIds?.some((id) => !options.members.some((m) => m.id === id)) ||
    filters.tagIds?.some((id) => !options.tags.some((t) => t.id === id))
  )
    throw new InboxError('INVALID_REQUEST', 'Filter references need repair')
  if (filters.customerId) {
    const viewer = await assertInboxViewer(db, input.workspaceId, input.userId)
    const [target] = await db
      .select({ id: customer.id })
      .from(customer)
      .where(
        and(
          eq(customer.id, filters.customerId),
          eq(customer.workspaceId, input.workspaceId),
          viewer.role === 'AGENT'
            ? sql`exists (select 1 from ${channelIdentity} ci join ${memberChannelAccess} a on a.channel_id = ci.channel_id where ci.customer_id = ${customer.id} and a.member_id = ${viewer.memberId})`
            : undefined,
        ),
      )
    if (!target) throw new InboxError('INVALID_REQUEST', 'Filter references need repair')
  }
  for (const condition of filters.properties ?? []) {
    const definition = options.properties.find((d) => d.id === condition.definitionId)
    if (
      !definition ||
      (definition.type === 'NUMBER'
        ? typeof condition.value !== 'number' || !Number.isFinite(condition.value)
        : typeof condition.value !== 'string' ||
          condition.value.length > definition.maxLength ||
          (definition.type === 'OPTION' && !definition.options.includes(condition.value)))
    )
      throw new InboxError('INVALID_REQUEST', 'Filter references need repair')
  }
}

export async function listConversations(
  db: Database,
  input: InboxFilters & {
    workspaceId: string
    userId: string
    view: ConversationView
    after?: ConversationCursor
    limit?: number
    conversationId?: string
    includeClosed?: boolean
    tagId?: string
    attention?: 'unread' | 'unanswered'
  },
) {
  const viewer = await assertInboxViewer(db, input.workspaceId, input.userId)
  await validateInboxFilters(db, input, input)
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 100)
  const filters = [eq(conversation.workspaceId, input.workspaceId)]
  if (!input.includeClosed)
    filters.push(eq(conversation.status, input.view === 'closed' ? 'CLOSED' : 'OPEN'))
  const unread = sql<boolean>`exists (select 1 from message input where input.conversation_id = ${conversation.id} and input.sender_type = 'CUSTOMER' and not exists (select 1 from ${messageMemberRead} r where r.member_id = ${viewer.memberId} and r.message_id = input.id))`
  const unanswered = sql<boolean>`exists (select 1 from message input where input.id = ${conversation.lastCustomerMessageId} and not exists (select 1 from message reply where reply.conversation_id = ${conversation.id} and reply.direction = 'OUTBOUND' and reply.sender_type = 'MEMBER' and reply.delivery_state = 'SENT' and (length(btrim(coalesce(reply.text, ''))) > 0 or reply.message_type = 'ATTACHMENT') and (reply.created_at, reply.id) > (input.created_at, input.id)))`
  if (input.attention === 'unread') filters.push(unread)
  const muted = sql<boolean>`exists (select 1 from ${conversationMemberMute} m where m.member_id = ${viewer.memberId} and m.conversation_id = ${conversation.id})`
  if (input.mute === 'muted') filters.push(muted)
  if (input.mute === 'unmuted') filters.push(sql`not (${muted})`)
  if (input.attention === 'unanswered') filters.push(unanswered)
  const sharedCustomerVisible =
    viewer.role === 'AGENT'
      ? sql`not exists (select 1 from ${channelIdentity} ci where ci.customer_id = ${customer.id} and not exists (select 1 from ${memberChannelAccess} a where a.member_id = ${viewer.memberId} and a.channel_id = ci.channel_id)) and not exists (select 1 from jsonb_array_elements_text(${customer.profileSourceChannelIds}) s(channel_id) where not exists (select 1 from ${memberChannelAccess} a where a.member_id = ${viewer.memberId} and a.channel_id::text = s.channel_id))`
      : sql`true`
  if (viewer.role === 'AGENT')
    filters.push(
      sql`exists (select 1 from ${memberChannelAccess} a where a.member_id = ${viewer.memberId} and a.channel_id = ${channelIdentity.channelId})`,
    )
  if (input.query)
    filters.push(
      sql`${sharedCustomerVisible} and (strpos(lower(coalesce(${customer.displayName}, '')), lower(${input.query})) > 0 or strpos(lower(coalesce(${customer.notes}, '')), lower(${input.query})) > 0)`,
    )
  if (input.customerId) filters.push(eq(customer.id, input.customerId))
  if (input.channelId) filters.push(eq(channelIdentity.channelId, input.channelId))
  if (input.createdFrom)
    filters.push(sql`${customer.createdAt} >= ${input.createdFrom}::timestamptz`)
  if (input.createdTo) filters.push(sql`${customer.createdAt} <= ${input.createdTo}::timestamptz`)
  if (input.memberIds?.length) filters.push(inArray(conversation.assigneeMemberId, input.memberIds))
  if (input.updatedFrom)
    filters.push(sql`${conversation.updatedAt} >= ${input.updatedFrom}::timestamptz`)
  if (input.updatedTo)
    filters.push(sql`${conversation.updatedAt} <= ${input.updatedTo}::timestamptz`)
  for (const condition of input.properties ?? [])
    filters.push(
      sql`exists (select 1 from ${customerPropertyValue} p where p.definition_id = ${condition.definitionId} and (p.customer_id = ${customer.id} or p.conversation_id = ${conversation.id}) and p.value = ${JSON.stringify(condition.value)}::jsonb ${viewer.role === 'AGENT' ? sql`and (p.customer_id is null or (${sharedCustomerVisible})) and exists (select 1 from ${memberChannelAccess} a where a.member_id = ${viewer.memberId} and a.channel_id = p.source_channel_id)` : sql``})`,
    )
  for (const tagId of new Set([...(input.tagIds ?? []), ...(input.tagId ? [input.tagId] : [])])) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tagId))
      throw new InboxError('INVALID_REQUEST', 'Invalid tag')
    const [tag] = await db
      .select({ id: customerTagDefinition.id })
      .from(customerTagDefinition)
      .where(
        and(
          eq(customerTagDefinition.id, tagId),
          eq(customerTagDefinition.workspaceId, input.workspaceId),
        ),
      )
    if (!tag) throw new InboxError('NOT_FOUND', 'Tag not found')
    filters.push(
      sql`exists (select 1 from ${customerTag} t where t.tag_id = ${tagId} and (t.customer_id = ${customer.id} or t.conversation_id = ${conversation.id}) ${viewer.role === 'AGENT' ? sql`and exists (select 1 from ${memberChannelAccess} a where a.member_id = ${viewer.memberId} and a.channel_id = t.source_channel_id) and (t.customer_id is null or (${sharedCustomerVisible}))` : sql``})`,
    )
  }

  if (input.view === 'my') filters.push(eq(conversation.assigneeMemberId, viewer.memberId))
  if (input.view === 'team') filters.push(eq(member.type, 'HUMAN'))
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
    filters.push(
      sql`(${conversation.updatedAt}, ${conversation.id}) < (${input.after.updatedAt}::timestamptz, ${input.after.id}::uuid)`,
    )
  }

  const rows = await db
    .select({
      id: conversation.id,
      unread,
      aiStopState: conversation.aiStopState,
      muted,
      unanswered,
      cursorTime: sql<string>`to_char(${conversation.updatedAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      status: conversation.status,
      routingConstraint: conversation.routingConstraint,
      queueReason: conversation.queueReason,
      routingQueuedAt: conversation.routingQueuedAt,
      latestMessageAt: conversation.latestMessageAt,
      lastCustomerMessageAt: conversation.lastCustomerMessageAt,
      updatedAt: conversation.updatedAt,
      customerId: customer.id,
      channelIdentityId: channelIdentity.id,
      customerName: sql<
        string | null
      >`case when ${sharedCustomerVisible} then ${customer.displayName} else null end`,
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
    nextCursor: hasNext && last ? { updatedAt: last.cursorTime, id: last.id } : null,
  }
}

export async function listMessages(
  db: Database,
  input: {
    workspaceId: string
    userId: string
    conversationId: string
    after?: { createdAt: Date | string; id: string }
    before?: { createdAt: Date | string; id: string }
    latest?: boolean
    limit?: number
  },
) {
  await assertInboxConversationAccess(db, input)
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 100)
  const filters = [eq(message.conversationId, input.conversationId)]
  if (input.after) {
    filters.push(
      sql`(${message.createdAt}, ${message.id}) > (${input.after.createdAt}::timestamptz, ${input.after.id}::uuid)`,
    )
  }
  if (input.before)
    filters.push(
      sql`(${message.createdAt}, ${message.id}) < (${input.before.createdAt}::timestamptz, ${input.before.id}::uuid)`,
    )
  const backwards = Boolean(input.latest || input.before)

  const rows = await db
    .select({
      ...getTableColumns(message),
      cursorTime: sql<string>`to_char(${message.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
    })
    .from(message)
    .where(and(...filters))
    .orderBy(
      backwards ? desc(message.createdAt) : asc(message.createdAt),
      backwards ? desc(message.id) : asc(message.id),
    )
    .limit(limit + 1)
  const hasNext = rows.length > limit
  const messages = rows.slice(0, limit)
  if (backwards) messages.reverse()
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
      createdAt: item.cursorTime,
      attachments: (attachmentsByMessageId.get(item.id) ?? []).map(
        ({ messageId: _messageId, ...attachment }) => attachment,
      ),
    })),
    nextCursor: !backwards && hasNext && last ? { createdAt: last.cursorTime, id: last.id } : null,
    olderCursor:
      backwards && hasNext && messages[0]
        ? { createdAt: messages[0].cursorTime, id: messages[0].id }
        : null,
  }
}

export async function acknowledgeConversationRead(
  db: Database,
  input: { workspaceId: string; userId: string; conversationId: string; messageIds: string[] },
) {
  return db.transaction(async (tx) => {
    const viewer = await assertInboxConversationAccess(tx, input)
    const ids = [...new Set(input.messageIds)]
    const visible = await tx
      .select({ id: message.id, createdAt: message.createdAt })
      .from(message)
      .where(
        and(
          eq(message.conversationId, input.conversationId),
          eq(message.senderType, 'CUSTOMER'),
          inArray(message.id, ids),
        ),
      )
      .orderBy(desc(message.createdAt), desc(message.id))
    if (visible.length !== ids.length || !visible.length)
      throw new InboxError('INVALID_REQUEST', 'Customer messages required')
    await tx
      .insert(messageMemberRead)
      .values(visible.map((m) => ({ memberId: viewer.memberId, messageId: m.id })))
      .onConflictDoNothing()
    await tx
      .insert(conversationMemberRead)
      .values({
        memberId: viewer.memberId,
        conversationId: input.conversationId,
        lastReadMessageId: visible[0].id,
      })
      .onConflictDoUpdate({
        target: [conversationMemberRead.memberId, conversationMemberRead.conversationId],
        set: {
          lastReadMessageId: sql`case when (select (created_at, id) from message where id = excluded.last_read_message_id) > (select (created_at, id) from message where id = ${conversationMemberRead.lastReadMessageId}) then excluded.last_read_message_id else ${conversationMemberRead.lastReadMessageId} end`,
        },
      })
  })
}

export async function assertInboxViewer(db: QueryHandle, workspaceId: string, userId: string) {
  const [viewer] = await db
    .select({ memberId: member.id, role: workspaceUserAccess.role })
    .from(workspaceUserAccess)
    .innerJoin(member, eq(member.workspaceUserAccessId, workspaceUserAccess.id))
    .where(
      and(
        eq(workspaceUserAccess.workspaceId, workspaceId),
        eq(workspaceUserAccess.userId, userId),
        eq(member.workspaceId, workspaceId),
        eq(member.status, 'ACTIVE'),
        eq(member.type, 'HUMAN'),
      ),
    )
    .limit(1)
  if (!viewer) throw new InboxError('FORBIDDEN', 'Workspace access required')
  return viewer
}

export async function assertInboxConversationAccess(
  db: QueryHandle,
  input: { workspaceId: string; userId: string; conversationId: string },
) {
  const viewer = await assertInboxViewer(db, input.workspaceId, input.userId)
  const [found] = await db
    .select({ id: conversation.id, channelId: channelIdentity.channelId })
    .from(conversation)
    .innerJoin(channelIdentity, eq(channelIdentity.id, conversation.channelIdentityId))
    .where(
      and(
        eq(conversation.id, input.conversationId),
        eq(conversation.workspaceId, input.workspaceId),
      ),
    )
    .limit(1)
  if (!found) throw new InboxError('NOT_FOUND', 'Conversation not found')
  if (viewer.role === 'AGENT') {
    const [allowed] = await db
      .select({ channelId: memberChannelAccess.channelId })
      .from(memberChannelAccess)
      .where(
        and(
          eq(memberChannelAccess.memberId, viewer.memberId),
          eq(memberChannelAccess.channelId, found.channelId),
        ),
      )
    if (!allowed) throw new InboxError('FORBIDDEN', 'Channel access required')
  }
  return viewer
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
