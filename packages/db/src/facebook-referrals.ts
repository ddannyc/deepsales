import { and, desc, eq, getTableColumns, or, sql } from 'drizzle-orm'
import type { Database } from './database'
import { assertInboxConversationAccess, ensureFacebookIdentity, InboxError } from './inbox'
import {
  type AdvertisingContext,
  aiResponseRun,
  channel,
  channelIdentity,
  conversation,
  facebookChannelConfig,
  facebookReferral,
  member,
  memberChannelAccess,
  message,
} from './schema'

export async function getAiFacebookAdvertisingContext(
  db: Database,
  input: { workspaceId: string; runId: string },
): Promise<AdvertisingContext> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ run: aiResponseRun })
      .from(aiResponseRun)
      .innerJoin(conversation, eq(conversation.id, aiResponseRun.conversationId))
      .where(
        and(eq(aiResponseRun.id, input.runId), eq(conversation.workspaceId, input.workspaceId)),
      )
      .for('update', { of: aiResponseRun })
    const run = row?.run
    if (run?.state !== 'GENERATING') return { status: 'UNAVAILABLE' }
    const save = async (context: AdvertisingContext) => {
      await tx
        .update(aiResponseRun)
        .set({ advertisingContext: context })
        .where(eq(aiResponseRun.id, run.id))
      return context
    }
    if (!run.configSnapshot?.adLearningEnabled) return save({ status: 'DISABLED' })
    const [authorized] = await tx
      .select({
        identityId: channelIdentity.id,
        lastInputAt: sql<string>`${message.createdAt}::text`,
        externalMessageId: message.externalMessageId,
      })
      .from(conversation)
      .innerJoin(channelIdentity, eq(channelIdentity.id, conversation.channelIdentityId))
      .innerJoin(channel, eq(channel.id, channelIdentity.channelId))
      .innerJoin(
        memberChannelAccess,
        and(
          eq(memberChannelAccess.channelId, channel.id),
          eq(memberChannelAccess.memberId, run.memberId),
        ),
      )
      .innerJoin(member, eq(member.id, run.memberId))
      .innerJoin(
        message,
        and(eq(message.id, run.inputLastMessageId), eq(message.conversationId, conversation.id)),
      )
      .where(
        and(
          eq(conversation.id, run.conversationId),
          eq(conversation.workspaceId, input.workspaceId),
          eq(channel.workspaceId, input.workspaceId),
          eq(member.workspaceId, input.workspaceId),
          eq(channel.status, 'ACTIVE'),
          eq(member.status, 'ACTIVE'),
          eq(member.type, 'AI'),
        ),
      )
    if (!authorized) return save({ status: 'UNAVAILABLE' })
    if (run.advertisingContext) return run.advertisingContext
    const [referral] = await tx
      .select()
      .from(facebookReferral)
      .where(
        and(
          eq(facebookReferral.channelIdentityId, authorized.identityId),
          or(
            sql`${facebookReferral.eventAt} <= ${authorized.lastInputAt}::timestamptz`,
            authorized.externalMessageId
              ? and(
                  sql`${facebookReferral.providerSentAt} is null`,
                  eq(facebookReferral.externalMessageId, authorized.externalMessageId),
                )
              : undefined,
          ),
        ),
      )
      .orderBy(desc(facebookReferral.eventAt), desc(facebookReferral.id))
      .limit(1)
    if (referral?.source !== 'ADS' || !referral.adId) return save({ status: 'NO_SOURCE' })
    const mapping = run.configSnapshot.adMappings?.find(({ adId }) => adId === referral.adId)
    return save({
      status: mapping ? 'MAPPED' : 'UNMAPPED',
      referralId: referral.id,
      adId: referral.adId,
      ...(mapping ? { content: mapping.content } : {}),
    })
  })
}

export type FacebookReferralInput = {
  pageId: string
  externalUserId: string
  externalMessageId: string | null
  providerSentAt: string | null
  source: string
  type: string
  ref: string | null
  adId: string | null
  refererUri: string | null
  adTitle: string | null
  imageUrl: string | null
}

export async function processFacebookReferral(
  db: Database,
  input: FacebookReferralInput & { receivedAt: Date },
) {
  if (!input.providerSentAt && !input.externalMessageId)
    throw new InboxError('INVALID_REQUEST', 'Stable referral identity required')
  // A timestamped referral has the same identity whether delivered standalone or with a message.
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(
      JSON.stringify([
        input.providerSentAt ?? input.externalMessageId,
        input.source,
        input.type,
        input.ref,
        input.adId,
        input.refererUri,
      ]),
    ),
  )
  const eventKey = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join(
    '',
  )
  return db.transaction(async (tx) => {
    const [active] = await tx
      .select({ channelId: channel.id, workspaceId: channel.workspaceId })
      .from(channel)
      .innerJoin(facebookChannelConfig, eq(facebookChannelConfig.channelId, channel.id))
      .where(and(eq(facebookChannelConfig.pageId, input.pageId), eq(channel.status, 'ACTIVE')))
    if (!active) return null
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`${active.channelId}:${input.externalUserId}`}, 0))`,
    )
    const identity = await ensureFacebookIdentity(tx, {
      ...active,
      externalUserId: input.externalUserId,
    })
    const candidates = await tx
      .select()
      .from(facebookReferral)
      .where(
        and(
          eq(facebookReferral.channelIdentityId, identity.id),
          or(
            eq(facebookReferral.eventKey, eventKey),
            input.externalMessageId
              ? eq(facebookReferral.externalMessageId, input.externalMessageId)
              : undefined,
          ),
        ),
      )
    const existing = candidates.find((row) => row.eventKey === eventKey) ?? candidates[0]
    if (!existing)
      await tx
        .insert(facebookReferral)
        .values({
          channelIdentityId: identity.id,
          eventKey,
          externalMessageId: input.externalMessageId,
          source: input.source,
          type: input.type,
          ref: input.ref,
          adId: input.adId,
          refererUri: input.refererUri,
          adTitle: input.adTitle,
          imageUrl: input.imageUrl,
          providerSentAt: input.providerSentAt ? new Date(input.providerSentAt) : null,
          receivedAt: input.receivedAt,
          eventAt: input.providerSentAt ? new Date(input.providerSentAt) : input.receivedAt,
        })
        .onConflictDoNothing()
    else {
      const previous = candidates.find((row) => row.id !== existing.id)
      const receivedAt = new Date(
        Math.min(input.receivedAt.getTime(), ...candidates.map((row) => row.receivedAt.getTime())),
      )
      const providerSentAt =
        existing.providerSentAt ??
        previous?.providerSentAt ??
        (input.providerSentAt ? new Date(input.providerSentAt) : null)
      // A later timestamped copy can reconcile a prior MID-only row and a standalone source.
      for (const row of candidates)
        if (row.id !== existing.id)
          await tx.delete(facebookReferral).where(eq(facebookReferral.id, row.id))
      await tx
        .update(facebookReferral)
        .set({
          eventKey: existing.providerSentAt
            ? existing.eventKey
            : previous?.providerSentAt
              ? previous.eventKey
              : input.providerSentAt
                ? eventKey
                : existing.eventKey,
          externalMessageId:
            existing.externalMessageId ?? previous?.externalMessageId ?? input.externalMessageId,
          adTitle: existing.adTitle ?? previous?.adTitle ?? input.adTitle,
          imageUrl: existing.imageUrl ?? previous?.imageUrl ?? input.imageUrl,
          providerSentAt,
          receivedAt,
          eventAt: providerSentAt ?? receivedAt,
        })
        .where(eq(facebookReferral.id, existing.id))
    }
    const conversations = await tx
      .select({ id: conversation.id })
      .from(conversation)
      .where(and(eq(conversation.channelIdentityId, identity.id), eq(conversation.status, 'OPEN')))
    return { workspaceId: active.workspaceId, conversationIds: conversations.map((c) => c.id) }
  })
}

export async function listFacebookReferrals(
  db: Database,
  input: { workspaceId: string; userId: string; conversationId: string; before?: string },
) {
  return db.transaction(async (tx) => {
    await assertInboxConversationAccess(tx, input)
    const [current] = await tx
      .select({ identityId: conversation.channelIdentityId, channelId: channelIdentity.channelId })
      .from(conversation)
      .innerJoin(channelIdentity, eq(channelIdentity.id, conversation.channelIdentityId))
      .where(
        and(
          eq(conversation.id, input.conversationId),
          eq(conversation.workspaceId, input.workspaceId),
        ),
      )
    if (!current) throw new InboxError('NOT_FOUND')
    const scope = eq(facebookReferral.channelIdentityId, current.identityId)
    const [cursor] = input.before
      ? await tx
          .select()
          .from(facebookReferral)
          .where(and(scope, eq(facebookReferral.id, input.before)))
      : []
    if (input.before && !cursor) throw new InboxError('INVALID_REQUEST', 'Invalid referral cursor')
    const rows = await tx
      .select({
        ...getTableColumns(facebookReferral),
        messageId: message.id,
        conversationId: message.conversationId,
      })
      .from(facebookReferral)
      .leftJoin(
        message,
        and(
          eq(message.channelId, current.channelId),
          eq(message.externalMessageId, facebookReferral.externalMessageId),
          eq(message.senderType, 'CUSTOMER'),
          sql`${message.conversationId} in (select id from conversation where channel_identity_id = ${current.identityId})`,
        ),
      )
      .where(
        and(
          scope,
          cursor
            ? sql`(${facebookReferral.eventAt}, ${facebookReferral.id}) < (${cursor.eventAt}, ${cursor.id}::uuid)`
            : undefined,
        ),
      )
      .orderBy(desc(facebookReferral.eventAt), desc(facebookReferral.id))
      .limit(51)
    return {
      referrals: rows.slice(0, 50),
      nextReferralCursor: rows.length > 50 ? rows[49].id : null,
    }
  })
}
