import { and, asc, desc, eq, gt, inArray, isNull, lt, sql } from 'drizzle-orm'
import type { Database } from './database'
import { assertInboxViewer, InboxError, type InboxFilters, listConversations } from './inbox'
import {
  aiOperation,
  type CampaignCalendar,
  type CampaignContent,
  campaign,
  campaignRecipient,
  campaignRun,
  channel,
  channelIdentity,
  conversation,
  facebookChannelConfig,
  facebookMessagingWindow,
  mediaAsset,
  member,
  memberChannelAccess,
  message,
  messageAttachment,
  workspaceUserAccess,
} from './schema'

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0]
type Handle = Database | Tx
type Context = { workspaceId: string; userId: string }

async function manager(db: Handle, input: Context, channelId?: string) {
  const viewer = await assertInboxViewer(db, input.workspaceId, input.userId)
  if (viewer.role === 'AGENT') throw new InboxError('FORBIDDEN')
  if (channelId) {
    const [access] = await db
      .select({ id: channel.id })
      .from(channel)
      .innerJoin(memberChannelAccess, eq(memberChannelAccess.channelId, channel.id))
      .where(
        and(
          eq(channel.id, channelId),
          eq(channel.workspaceId, input.workspaceId),
          eq(memberChannelAccess.memberId, viewer.memberId),
        ),
      )
    if (!access) throw new InboxError('FORBIDDEN')
  }
  return viewer
}

export async function listCampaignAudience(
  db: Database,
  input: Context & {
    channelId: string
    filters: InboxFilters
    after?: { updatedAt: string; id: string }
  },
) {
  await manager(db, input, input.channelId)
  const page = await listConversations(db, {
    ...input.filters,
    workspaceId: input.workspaceId,
    userId: input.userId,
    includeClosed: true,
    channelId: input.channelId,
    after: input.after,
  })
  return page
}

export async function saveCampaign(
  db: Database,
  input: Context & {
    id: string
    name: string
    channelId: string
    identityIds: string[]
    content: CampaignContent
    selectionMode?: 'ALL' | 'RANDOM'
    targetLanguage?: string | null
    calendar?: CampaignCalendar | null
    intervalSeconds?: number
  },
) {
  if (
    !input.name.trim() ||
    input.name.length > 100 ||
    !input.identityIds.length ||
    input.identityIds.length > 1000 ||
    !input.content.length ||
    input.content.length > 20
  )
    throw new InboxError('INVALID_REQUEST')
  return db.transaction(async (tx) => {
    await tx.execute(sql`select id from workspace where id = ${input.workspaceId} for share`)
    const viewer = await manager(tx, input, input.channelId)
    const [existing] = await tx
      .select()
      .from(campaign)
      .where(eq(campaign.id, input.id))
      .for('update')
    if (
      existing &&
      (existing.workspaceId !== input.workspaceId || existing.creatorMemberId !== viewer.memberId)
    )
      throw new InboxError('FORBIDDEN')
    if (existing && existing.status !== 'DRAFT')
      throw new InboxError('INVALID_REQUEST', 'Only draft campaigns can be edited')
    const identityIds = [...new Set(input.identityIds)]
    const identities = await tx
      .select({ id: channelIdentity.id })
      .from(channelIdentity)
      .where(
        and(
          inArray(channelIdentity.id, identityIds),
          eq(channelIdentity.channelId, input.channelId),
          eq(channelIdentity.workspaceId, input.workspaceId),
        ),
      )
    if (identities.length !== identityIds.length) throw new InboxError('INVALID_REQUEST')
    for (const block of input.content) {
      if (
        Boolean(block.text?.trim()) === Boolean(block.assetId) ||
        (block.text?.length ?? 0) > 2000
      )
        throw new InboxError('INVALID_REQUEST')
      if (block.assetId) {
        const [asset] = await tx
          .select({ id: mediaAsset.id })
          .from(mediaAsset)
          .where(
            and(
              eq(mediaAsset.id, block.assetId),
              eq(mediaAsset.workspaceId, input.workspaceId),
              isNull(mediaAsset.deletedAt),
            ),
          )
        if (!asset) throw new InboxError('INVALID_REQUEST', 'Media is unavailable')
      }
    }
    const values = {
      name: input.name.trim(),
      channelId: input.channelId,
      identityIds,
      content: input.content,
      selectionMode: input.selectionMode ?? 'ALL',
      targetLanguage: input.targetLanguage ?? null,
      calendar: input.calendar ?? null,
      intervalSeconds: input.intervalSeconds ?? 1,
      updatedAt: new Date(),
    }
    const [saved] = existing
      ? await tx
          .update(campaign)
          .set({ ...values, version: existing.version + 1 })
          .where(eq(campaign.id, input.id))
          .returning()
      : await tx
          .insert(campaign)
          .values({
            id: input.id,
            workspaceId: input.workspaceId,
            creatorMemberId: viewer.memberId,
            ...values,
          })
          .returning()
    return { campaign: saved }
  })
}

export async function listCampaigns(db: Database, input: Context) {
  const viewer = await manager(db, input)
  return {
    campaigns: await db
      .select()
      .from(campaign)
      .where(
        and(
          eq(campaign.workspaceId, input.workspaceId),
          sql`exists (select 1 from member_channel_access a where a.member_id = ${viewer.memberId} and a.channel_id = ${campaign.channelId})`,
        ),
      )
      .orderBy(desc(campaign.createdAt))
      .limit(100),
  }
}

export async function readCampaign(
  db: Database,
  input: Context & { id: string; runId?: string; before?: string; afterOrdinal?: number },
) {
  const [plan] = await db
    .select()
    .from(campaign)
    .where(and(eq(campaign.id, input.id), eq(campaign.workspaceId, input.workspaceId)))
  if (!plan) throw new InboxError('NOT_FOUND')
  await manager(db, input, plan.channelId)
  const runs = await db
    .select()
    .from(campaignRun)
    .where(
      and(
        eq(campaignRun.campaignId, plan.id),
        input.runId ? eq(campaignRun.id, input.runId) : undefined,
        input.before ? lt(campaignRun.scheduledAt, new Date(input.before)) : undefined,
      ),
    )
    .orderBy(desc(campaignRun.scheduledAt))
    .limit(4)
  const details = []
  for (const run of runs.slice(0, 3)) {
    const recipients = await db
      .select()
      .from(campaignRecipient)
      .where(
        and(
          eq(campaignRecipient.runId, run.id),
          input.afterOrdinal === undefined
            ? undefined
            : gt(campaignRecipient.ordinal, input.afterOrdinal),
        ),
      )
      .orderBy(asc(campaignRecipient.ordinal))
      .limit(21)
    const results = []
    for (const recipient of recipients.slice(0, 20)) {
      const messages = recipient.messageIds.length
        ? await db
            .select({
              id: message.id,
              state: message.deliveryState,
              failureCode: message.failureCode,
            })
            .from(message)
            .where(inArray(message.id, recipient.messageIds))
        : []
      const failed = messages.find((m) => m.state === 'FAILED')
      const state = failed
        ? failed.failureCode === 'AMBIGUOUS_DELIVERY'
          ? 'UNKNOWN'
          : 'FAILED'
        : recipient.messageIds.length ===
              (recipient.translatedContent ?? recipient.content).length &&
            messages.every((m) => m.state === 'SENT')
          ? 'SUCCESS'
          : recipient.state
      results.push({ ...recipient, state, messages })
    }
    details.push({
      ...run,
      recipients: results,
      nextRecipientOrdinal: recipients.length > 20 ? recipients[19].ordinal : null,
    })
  }
  return {
    campaign: plan,
    runs: details,
    nextRunBefore: runs.length > 3 ? runs[2].scheduledAt.toISOString() : null,
  }
}

export async function changeCampaignState(
  db: Database,
  input: Context & {
    id: string
    action: 'execute' | 'pause' | 'resume' | 'cancel'
    expectedVersion: number
    firstRunAt?: Date
  },
) {
  return db.transaction(async (tx) => {
    const [plan] = await tx
      .select()
      .from(campaign)
      .where(and(eq(campaign.id, input.id), eq(campaign.workspaceId, input.workspaceId)))
      .for('update')
    if (!plan) throw new InboxError('NOT_FOUND')
    await manager(tx, input, plan.channelId)
    if (input.action === 'execute' && plan.version !== input.expectedVersion)
      throw new InboxError('INVALID_REQUEST', 'Campaign draft changed; refresh and retry')
    if (input.action === 'execute' && plan.status !== 'DRAFT') return { campaign: plan }
    if (input.action === 'resume' && plan.status !== 'PAUSED')
      throw new InboxError('INVALID_REQUEST')
    if (input.action === 'pause' && plan.status !== 'ACTIVE')
      throw new InboxError('INVALID_REQUEST')
    if (['COMPLETED', 'CANCELLED'].includes(plan.status)) throw new InboxError('INVALID_REQUEST')
    const status =
      input.action === 'cancel' ? 'CANCELLED' : input.action === 'pause' ? 'PAUSED' : 'ACTIVE'
    const [updated] = await tx
      .update(campaign)
      .set({
        status,
        updatedAt: new Date(),
        ...(input.action === 'execute' ? { nextRunAt: input.firstRunAt ?? new Date() } : {}),
      })
      .where(eq(campaign.id, plan.id))
      .returning()
    if (status === 'CANCELLED')
      await tx.execute(
        sql`update campaign_recipient r set state = 'SKIPPED', reason = 'CANCELLED' from campaign_run run where r.run_id = run.id and run.campaign_id = ${plan.id} and r.state = 'WAITING'`,
      )
    return { campaign: updated }
  })
}

export async function dueCampaigns(db: Database, now = new Date()) {
  return db
    .select()
    .from(campaign)
    .where(and(eq(campaign.status, 'ACTIVE'), sql`${campaign.nextRunAt} <= ${now}`))
    .limit(100)
}

export async function startCampaignRun(
  db: Database,
  input: { id: string; scheduledAt: Date; nextRunAt: Date | null; now?: Date; skip?: boolean },
) {
  const now = input.now ?? new Date()
  return db.transaction(async (tx) => {
    const [plan] = await tx.select().from(campaign).where(eq(campaign.id, input.id)).for('update')
    if (plan?.status !== 'ACTIVE' || plan.nextRunAt?.getTime() !== input.scheduledAt.getTime())
      return
    const count = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(campaignRun)
      .where(eq(campaignRun.campaignId, plan.id))
    const stopped =
      (plan.calendar?.maxRuns !== undefined && count[0].count >= plan.calendar.maxRuns) ||
      (plan.calendar?.until !== undefined && now > new Date(plan.calendar.until))
    const nextRunAt = stopped ? null : input.nextRunAt
    await tx.update(campaign).set({ nextRunAt, updatedAt: now }).where(eq(campaign.id, plan.id))
    if (stopped || input.skip) return
    const [run] = await tx
      .insert(campaignRun)
      .values({
        id: crypto.randomUUID(),
        campaignId: plan.id,
        version: plan.version,
        scheduledAt: input.scheduledAt,
        content: plan.content,
      })
      .onConflictDoNothing()
      .returning()
    if (!run) return
    await tx.insert(campaignRecipient).values(
      plan.identityIds.map((id, ordinal) => ({
        id: crypto.randomUUID(),
        runId: run.id,
        channelIdentityId: id,
        ordinal,
        content:
          plan.selectionMode === 'RANDOM'
            ? [
                plan.content[
                  Math.floor(
                    (crypto.getRandomValues(new Uint32Array(1))[0] / 4294967296) *
                      plan.content.length,
                  )
                ],
              ]
            : plan.content,
        translationOperationId: crypto.randomUUID(),
      })),
    )
  })
}

async function eligible(
  tx: Handle,
  plan: typeof campaign.$inferSelect,
  identityId: string,
  now: Date,
) {
  const [found] = await tx
    .select({ id: channelIdentity.id })
    .from(channelIdentity)
    .innerJoin(channel, eq(channel.id, channelIdentity.channelId))
    .innerJoin(facebookChannelConfig, eq(facebookChannelConfig.channelId, channel.id))
    .innerJoin(
      facebookMessagingWindow,
      eq(facebookMessagingWindow.channelIdentityId, channelIdentity.id),
    )
    .innerJoin(member, eq(member.id, plan.creatorMemberId))
    .innerJoin(workspaceUserAccess, eq(workspaceUserAccess.id, member.workspaceUserAccessId))
    .innerJoin(
      memberChannelAccess,
      and(
        eq(memberChannelAccess.memberId, member.id),
        eq(memberChannelAccess.channelId, channel.id),
      ),
    )
    .where(
      and(
        eq(channelIdentity.id, identityId),
        eq(channelIdentity.channelId, plan.channelId),
        eq(channelIdentity.workspaceId, plan.workspaceId),
        eq(channel.status, 'ACTIVE'),
        eq(facebookChannelConfig.connectionStatus, 'ACTIVE'),
        eq(member.status, 'ACTIVE'),
        eq(member.type, 'HUMAN'),
        eq(member.workspaceId, plan.workspaceId),
        sql`${workspaceUserAccess.role} in ('OWNER','ADMIN')`,
        sql`${facebookMessagingWindow.eligibleUntil} > ${now}`,
      ),
    )
  return Boolean(found)
}

export async function campaignDeliveryContext(db: Database, messageId: string) {
  const [item] = await db
    .select({ recipient: campaignRecipient, plan: campaign })
    .from(campaignRecipient)
    .innerJoin(campaignRun, eq(campaignRun.id, campaignRecipient.runId))
    .innerJoin(campaign, eq(campaign.id, campaignRun.campaignId))
    .where(sql`${messageId}::uuid = any(${campaignRecipient.messageIds})`)
    .limit(1)
  return item
    ? {
        allowed: await eligible(db, item.plan, item.recipient.channelIdentityId, new Date()),
        intervalSeconds: item.plan.intervalSeconds,
      }
    : null
}

export async function pendingCampaignTranslations(db: Database) {
  const items = await db
    .select({ recipient: campaignRecipient, plan: campaign })
    .from(campaignRecipient)
    .innerJoin(campaignRun, eq(campaignRun.id, campaignRecipient.runId))
    .innerJoin(campaign, eq(campaign.id, campaignRun.campaignId))
    .where(
      and(
        eq(campaign.status, 'ACTIVE'),
        eq(campaignRecipient.state, 'WAITING'),
        isNull(campaignRecipient.translatedContent),
        sql`${campaign.targetLanguage} is not null`,
      ),
    )
    .limit(20)
  const allowed = []
  for (const item of items) {
    if (await eligible(db, item.plan, item.recipient.channelIdentityId, new Date()))
      allowed.push(item)
    else
      await db
        .update(campaignRecipient)
        .set({ state: 'SKIPPED', reason: 'SEND_NOT_PERMITTED' })
        .where(
          and(eq(campaignRecipient.id, item.recipient.id), eq(campaignRecipient.state, 'WAITING')),
        )
  }
  return allowed
}

export async function storeCampaignTranslation(
  db: Database,
  input: { recipientId: string; content: CampaignContent },
) {
  return db.transaction(async (tx) => {
    const [item] = await tx
      .select({ recipient: campaignRecipient, plan: campaign })
      .from(campaignRecipient)
      .innerJoin(campaignRun, eq(campaignRun.id, campaignRecipient.runId))
      .innerJoin(campaign, eq(campaign.id, campaignRun.campaignId))
      .where(eq(campaignRecipient.id, input.recipientId))
      .for('update', { of: campaignRecipient })
    if (
      item?.plan.status !== 'ACTIVE' ||
      item.recipient.state !== 'WAITING' ||
      !(await eligible(tx, item.plan, item.recipient.channelIdentityId, new Date()))
    )
      return false
    await tx
      .update(campaignRecipient)
      .set({ translatedContent: input.content })
      .where(
        and(
          eq(campaignRecipient.id, input.recipientId),
          isNull(campaignRecipient.translatedContent),
        ),
      )
    return true
  })
}

export async function stopCampaignRecipient(
  db: Database,
  id: string,
  reason: string,
  unknown = false,
) {
  await db
    .update(campaignRecipient)
    .set({ state: unknown ? 'UNKNOWN' : 'FAILED', reason, updatedAt: new Date() })
    .where(and(eq(campaignRecipient.id, id), eq(campaignRecipient.state, 'WAITING')))
}

export async function pauseUnknownCampaignTranslation(db: Database, recipientId: string) {
  const [scope] = await db
    .select({ planId: campaignRun.campaignId })
    .from(campaignRecipient)
    .innerJoin(campaignRun, eq(campaignRun.id, campaignRecipient.runId))
    .where(eq(campaignRecipient.id, recipientId))
  if (!scope) return
  return db.transaction(async (tx) => {
    await tx
      .select({ id: campaign.id })
      .from(campaign)
      .where(eq(campaign.id, scope.planId))
      .for('update')
    const [item] = await tx
      .select({ recipient: campaignRecipient, planId: campaignRun.campaignId })
      .from(campaignRecipient)
      .innerJoin(campaignRun, eq(campaignRun.id, campaignRecipient.runId))
      .innerJoin(aiOperation, eq(aiOperation.id, campaignRecipient.translationOperationId))
      .where(and(eq(campaignRecipient.id, recipientId), eq(aiOperation.state, 'UNKNOWN')))
      .for('update', { of: campaignRecipient })
    if (item?.recipient.state !== 'WAITING') return
    await tx
      .update(campaignRecipient)
      .set({ state: 'UNKNOWN', reason: 'TRANSLATION_RESULT_UNKNOWN' })
      .where(eq(campaignRecipient.id, recipientId))
    await tx
      .update(campaign)
      .set({ status: 'PAUSED' })
      .where(and(eq(campaign.id, item.planId), eq(campaign.status, 'ACTIVE')))
  })
}

export async function dispatchCampaignMessages(db: Database, now = new Date()) {
  const plans = await db
    .select()
    .from(campaign)
    .where(
      and(
        eq(campaign.status, 'ACTIVE'),
        sql`(${campaign.nextRunAt} is null or exists (select 1 from campaign_recipient r join campaign_run run on run.id = r.run_id where run.campaign_id = ${campaign.id} and r.state = 'WAITING'))`,
      ),
    )
    .orderBy(asc(campaign.createdAt))
    .limit(100)
  const created: string[] = []
  for (const plan of plans) {
    const id = await db.transaction(async (tx) => {
      // One channel lock serializes campaigns; a pending send blocks later submissions.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`campaign:${plan.channelId}`}, 0))`,
      )
      const [currentPlan] = await tx
        .select()
        .from(campaign)
        .where(eq(campaign.id, plan.id))
        .for('update')
      if (currentPlan.status !== 'ACTIVE') return
      const items = await tx
        .select({ recipient: campaignRecipient })
        .from(campaignRecipient)
        .innerJoin(campaignRun, eq(campaignRun.id, campaignRecipient.runId))
        .where(and(eq(campaignRun.campaignId, plan.id), eq(campaignRecipient.state, 'WAITING')))
        .orderBy(asc(campaignRun.scheduledAt), asc(campaignRecipient.ordinal))
        .limit(100)
      for (const { recipient } of items) {
        const blocks = recipient.translatedContent ?? recipient.content
        const sent = recipient.messageIds.length
          ? await tx.select().from(message).where(inArray(message.id, recipient.messageIds))
          : []
        const failure = sent.find((m) => m.deliveryState === 'FAILED')
        if (failure) {
          const unknown = failure.failureCode === 'AMBIGUOUS_DELIVERY'
          await tx
            .update(campaignRecipient)
            .set({ state: unknown ? 'UNKNOWN' : 'FAILED', reason: failure.failureCode })
            .where(eq(campaignRecipient.id, recipient.id))
          if (unknown)
            await tx.update(campaign).set({ status: 'PAUSED' }).where(eq(campaign.id, plan.id))
          return
        }
        if (sent.some((m) => m.deliveryState === 'PENDING')) return
        if (recipient.messageIds.length === blocks.length) {
          await tx
            .update(campaignRecipient)
            .set({ state: 'SUCCESS', updatedAt: now })
            .where(eq(campaignRecipient.id, recipient.id))
          continue
        }
        if (!(await eligible(tx, currentPlan, recipient.channelIdentityId, now))) {
          await tx
            .update(campaignRecipient)
            .set({ state: 'SKIPPED', reason: 'SEND_NOT_PERMITTED', updatedAt: now })
            .where(eq(campaignRecipient.id, recipient.id))
          continue
        }
        if (plan.targetLanguage && !recipient.translatedContent) return
        const recent = await tx.execute(
          sql`select m.delivery_state, m.delivery_completed_at, m.delivery_started_at, (select max(a.retry_not_before) from facebook_delivery_attempt a where a.message_id = m.id) retry_not_before from message m join campaign_recipient r on m.id = any(r.message_ids) where m.channel_id = ${plan.channelId} order by m.created_at desc, m.id desc limit 1`,
        )
        const last = recent.rows[0] as
          | {
              delivery_state: string
              delivery_completed_at: Date | null
              delivery_started_at: Date | null
              retry_not_before: Date | null
            }
          | undefined
        if (
          last?.delivery_state === 'PENDING' ||
          (last?.retry_not_before && new Date(last.retry_not_before) > now) ||
          (last?.delivery_completed_at &&
            new Date(last.delivery_completed_at).getTime() + plan.intervalSeconds * 1000 >
              now.getTime())
        )
          return
        const [thread] = await tx
          .select({ id: conversation.id, latestMessageAt: conversation.latestMessageAt })
          .from(conversation)
          .where(
            and(
              eq(conversation.channelIdentityId, recipient.channelIdentityId),
              eq(conversation.workspaceId, plan.workspaceId),
            ),
          )
          .orderBy(desc(conversation.createdAt))
          .limit(1)
          .for('update')
        if (!thread) {
          await tx
            .update(campaignRecipient)
            .set({ state: 'SKIPPED', reason: 'NO_CONVERSATION' })
            .where(eq(campaignRecipient.id, recipient.id))
          continue
        }
        const block = blocks[recipient.messageIds.length]
        const [asset] = block.assetId
          ? await tx
              .select()
              .from(mediaAsset)
              .where(
                and(
                  eq(mediaAsset.id, block.assetId),
                  eq(mediaAsset.workspaceId, plan.workspaceId),
                  isNull(mediaAsset.deletedAt),
                ),
              )
              .for('share')
          : []
        if (block.assetId && !asset) {
          await tx
            .update(campaignRecipient)
            .set({ state: 'FAILED', reason: 'MEDIA_UNAVAILABLE' })
            .where(eq(campaignRecipient.id, recipient.id))
          continue
        }
        const [outbound] = await tx
          .insert(message)
          .values({
            conversationId: thread.id,
            channelId: plan.channelId,
            direction: 'OUTBOUND',
            senderType: 'MEMBER',
            senderMemberId: plan.creatorMemberId,
            messageType: asset ? 'ATTACHMENT' : 'TEXT',
            text: asset ? null : block.text,
            deliveryState: 'PENDING',
            clientKey: crypto.randomUUID(),
          })
          .returning({ id: message.id })
        if (asset)
          await tx.insert(messageAttachment).values({
            messageId: outbound.id,
            assetId: asset.id,
            kind: asset.kind,
            filename: asset.filename,
            mimeType: asset.mimeType,
            byteSize: asset.byteSize,
            storageKey: asset.storageKey,
            storageState: 'READY',
          })
        await tx
          .update(campaignRecipient)
          .set({ messageIds: [...recipient.messageIds, outbound.id], updatedAt: now })
          .where(eq(campaignRecipient.id, recipient.id))
        await tx
          .update(conversation)
          .set({
            latestMessageAt: new Date(
              Math.max(now.getTime(), thread.latestMessageAt?.getTime() ?? 0),
            ),
            lastOutboundMessageAt: now,
            updatedAt: now,
          })
          .where(eq(conversation.id, thread.id))
        return outbound.id
      }
      if (!items.length && !currentPlan.nextRunAt)
        await tx.update(campaign).set({ status: 'COMPLETED' }).where(eq(campaign.id, plan.id))
    })
    if (id) created.push(id)
  }
  return created
}
