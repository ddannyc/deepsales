import { and, eq, inArray, sql } from 'drizzle-orm'
import type { Database } from './database'
import { listMessages } from './inbox'
import {
  channel,
  channelIdentity,
  conversation,
  facebookChannelConfig,
  facebookMessageReceipt,
  facebookReceiptWatermark,
} from './schema'

export async function processFacebookReceipt(
  db: Database,
  event: {
    pageId: string
    externalUserId: string
    kind: 'delivery' | 'read' | 'echo'
    mids: string[]
    watermark: string | null
    providerSentAt: string | null
  },
) {
  return db.transaction(async (tx) => {
    const [identity] = await tx
      .select({ id: channelIdentity.id, workspaceId: channelIdentity.workspaceId })
      .from(channelIdentity)
      .innerJoin(channel, eq(channel.id, channelIdentity.channelId))
      .innerJoin(facebookChannelConfig, eq(facebookChannelConfig.channelId, channel.id))
      .where(
        and(
          eq(facebookChannelConfig.pageId, event.pageId),
          eq(channel.status, 'ACTIVE'),
          eq(channelIdentity.externalUserId, event.externalUserId),
        ),
      )
      .limit(1)
    if (!identity) return null
    if (event.watermark) {
      const through = new Date(event.watermark)
      await tx
        .insert(facebookReceiptWatermark)
        .values({
          channelIdentityId: identity.id,
          deliveredThrough: event.kind === 'delivery' ? through : null,
          readThrough: event.kind === 'read' ? through : null,
        })
        .onConflictDoUpdate({
          target: facebookReceiptWatermark.channelIdentityId,
          set: {
            deliveredThrough: sql`greatest(${facebookReceiptWatermark.deliveredThrough}, excluded.delivered_through)`,
            readThrough: sql`greatest(${facebookReceiptWatermark.readThrough}, excluded.read_through)`,
          },
        })
    }
    if (event.mids.length)
      await tx
        .insert(facebookMessageReceipt)
        .values(
          [...new Set(event.mids)].sort().map((externalMessageId) => ({
            channelIdentityId: identity.id,
            externalMessageId,
            providerSentAt:
              event.kind === 'echo' && event.providerSentAt ? new Date(event.providerSentAt) : null,
            delivered: event.kind === 'delivery',
          })),
        )
        .onConflictDoUpdate({
          target: [
            facebookMessageReceipt.channelIdentityId,
            facebookMessageReceipt.externalMessageId,
          ],
          set: {
            delivered: sql`${facebookMessageReceipt.delivered} or excluded.delivered`,
            providerSentAt: sql`coalesce(${facebookMessageReceipt.providerSentAt}, excluded.provider_sent_at)`,
          },
        })
    const conversations = await tx
      .select({ id: conversation.id })
      .from(conversation)
      .where(eq(conversation.channelIdentityId, identity.id))
    return { workspaceId: identity.workspaceId, conversationIds: conversations.map((c) => c.id) }
  })
}

export async function listFacebookMessages(
  db: Database,
  input: Parameters<typeof listMessages>[1],
) {
  const page = await listMessages(db, input)
  const messages = page.messages
  const [identity] = await db
    .select({ id: conversation.channelIdentityId })
    .from(conversation)
    .where(eq(conversation.id, input.conversationId))
  const receipts = messages.length
    ? await db
        .select()
        .from(facebookMessageReceipt)
        .where(
          and(
            eq(facebookMessageReceipt.channelIdentityId, identity.id),
            inArray(
              facebookMessageReceipt.externalMessageId,
              messages.map((m) => m.externalMessageId).filter((id): id is string => Boolean(id)),
            ),
          ),
        )
    : []
  const [watermark] = await db
    .select()
    .from(facebookReceiptWatermark)
    .where(eq(facebookReceiptWatermark.channelIdentityId, identity.id))
  const receiptById = new Map(receipts.map((r) => [r.externalMessageId, r]))
  return {
    ...page,
    messages: messages.map((item) => ({
      ...item,
      providerSentAt:
        item.direction === 'OUTBOUND'
          ? (receiptById.get(item.externalMessageId ?? '')?.providerSentAt ?? null)
          : item.providerSentAt,
      delivered:
        item.direction === 'OUTBOUND' &&
        (receiptById.get(item.externalMessageId ?? '')?.delivered === true ||
          receiptCovered(
            receiptById.get(item.externalMessageId ?? '')?.providerSentAt,
            watermark?.deliveredThrough,
          )),
      read:
        item.direction === 'OUTBOUND' &&
        receiptCovered(
          receiptById.get(item.externalMessageId ?? '')?.providerSentAt,
          watermark?.readThrough,
        ),
    })),
  }
}

function receiptCovered(sent: Date | null | undefined, through: Date | null | undefined) {
  return Boolean(sent && through && sent.getTime() <= through.getTime())
}
