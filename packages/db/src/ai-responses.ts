import { and, asc, desc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm'
import type { Database } from './database'
import {
  type AiMemberRuntimeSnapshot,
  aiMemberConfig,
  aiResponseRun,
  channel,
  channelIdentity,
  conversation,
  member,
  memberChannelAccess,
  message,
  messageAttachment,
  mediaAsset,
  knowledgeDocument,
  knowledgeChunk,
  workspace,
} from './schema'

const MAX_AI_RESPONSE_TEXT_LENGTH = 2_000
export const AI_GENERATION_TIMEOUT_MS = 5 * 60 * 1_000
export const MAX_AI_HISTORY_CODE_POINTS = 8_000
const MAX_AI_HISTORY_MESSAGES = 48

export type AiConversationContextMessage = {
  id: string
  direction: 'INBOUND' | 'OUTBOUND'
  origin: 'CUSTOMER' | 'AI' | 'HUMAN'
  senderMemberId: string | null
  createdAt: Date
  text: string
}

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0]

export type AiResponseInputMessage = {
  id: string
  messageType: 'TEXT' | 'ATTACHMENT'
  text: string | null
}

export type AiResponseRunClaim = {
  replyLanguage: string | null
  kind: 'CLAIMED'
  state: 'GENERATING'
  id: string
  workspaceId: string
  conversationId: string
  memberId: string
  inputFirstMessageId: string
  inputLastMessageId: string
  publishedSnapshot: AiMemberRuntimeSnapshot | null
  configVersionId: string | null
  inputMessages: AiResponseInputMessage[]
  history: AiConversationContextMessage[]
}

export type AiResponseRunClaimResult =
  | AiResponseRunClaim
  | { kind: 'DELAYED'; retryAfterMs: number }
  | {
      kind: 'CANCELLED'
      workspaceId: string
      conversationId: string
      cancellationReason: 'OWNERSHIP_CHANGED' | 'NEW_CUSTOMER_MESSAGE'
    }
  | null

export class AiResponseError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'INVALID_REQUEST' | 'MEDIA_UNAVAILABLE',
    message: string = code,
  ) {
    super(message)
  }
}

export function normalizeAiReplyLanguage(value: string) {
  if (
    typeof value !== 'string' ||
    value.length > 50 ||
    !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(value)
  )
    throw new AiResponseError('INVALID_REQUEST', 'Reply language is invalid')
  try {
    return Intl.getCanonicalLocales(value)[0] as string
  } catch {
    throw new AiResponseError('INVALID_REQUEST', 'Reply language is invalid')
  }
}

export type AiResponseCancellationReason = 'OWNERSHIP_CHANGED' | 'NEW_CUSTOMER_MESSAGE'

export async function cancelActiveAiResponseRuns(
  tx: Transaction,
  input: {
    conversationId: string
    reason: AiResponseCancellationReason
    now: Date
  },
) {
  const active = await tx
    .select({ id: aiResponseRun.id })
    .from(aiResponseRun)
    .where(
      and(
        eq(aiResponseRun.conversationId, input.conversationId),
        inArray(aiResponseRun.state, ['QUEUED', 'GENERATING']),
      ),
    )
    .for('update')

  if (!active.length) return []
  await tx
    .update(aiResponseRun)
    .set({
      state: 'CANCELLED',
      cancellationReason: input.reason,
      completedAt: input.now,
      updatedAt: input.now,
    })
    .where(
      inArray(
        aiResponseRun.id,
        active.map(({ id }) => id),
      ),
    )
  return active.map(({ id }) => id)
}

export async function claimAiResponseRun(
  db: Database,
  input: { runId: string; now?: Date },
): Promise<AiResponseRunClaimResult> {
  const now = input.now ?? new Date()
  return db.transaction(async (tx) => {
    const [reference] = await tx
      .select({ conversationId: aiResponseRun.conversationId })
      .from(aiResponseRun)
      .where(eq(aiResponseRun.id, input.runId))
      .limit(1)
    if (!reference) return null

    const conversationLock = await tx.execute(
      sql`select id from ${conversation} where id = ${reference.conversationId} for update`,
    )
    if (!conversationLock.rows.length) return null
    const runLock = await tx.execute(
      sql`select id from ${aiResponseRun} where id = ${input.runId} for update`,
    )
    if (!runLock.rows.length) return null

    const [current] = await tx
      .select({
        id: aiResponseRun.id,
        conversationId: aiResponseRun.conversationId,
        memberId: aiResponseRun.memberId,
        state: aiResponseRun.state,
        inputFirstMessageId: aiResponseRun.inputFirstMessageId,
        inputLastMessageId: aiResponseRun.inputLastMessageId,
        scheduledFor: aiResponseRun.scheduledFor,
        configVersionId: aiResponseRun.configVersionId,
        configSnapshot: aiResponseRun.configSnapshot,
        contextMessageIds: aiResponseRun.contextMessageIds,
        workspaceId: conversation.workspaceId,
        conversationStatus: conversation.status,
        assigneeMemberId: conversation.assigneeMemberId,
        replyLanguage: conversation.aiReplyLanguage,
      })
      .from(aiResponseRun)
      .innerJoin(conversation, eq(conversation.id, aiResponseRun.conversationId))
      .innerJoin(member, eq(member.id, aiResponseRun.memberId))
      .where(eq(aiResponseRun.id, input.runId))
      .limit(1)
    if (current?.state !== 'QUEUED') return null
    if (current.scheduledFor.getTime() > now.getTime()) {
      return {
        kind: 'DELAYED' as const,
        retryAfterMs: current.scheduledFor.getTime() - now.getTime(),
      }
    }

    if (current.conversationStatus !== 'OPEN' || current.assigneeMemberId !== current.memberId) {
      await cancelRun(tx, current.id, 'OWNERSHIP_CHANGED', now)
      return {
        kind: 'CANCELLED' as const,
        workspaceId: current.workspaceId,
        conversationId: current.conversationId,
        cancellationReason: 'OWNERSHIP_CHANGED' as const,
      }
    }

    await tx
      .update(aiResponseRun)
      .set({ state: 'GENERATING', startedAt: now, updatedAt: now })
      .where(and(eq(aiResponseRun.id, current.id), eq(aiResponseRun.state, 'QUEUED')))

    const [config] = await tx
      .select({
        publishedSnapshot: aiMemberConfig.publishedSnapshot,
        publishedVersionId: aiMemberConfig.publishedVersionId,
      })
      .from(aiMemberConfig)
      .where(eq(aiMemberConfig.memberId, current.memberId))
      .limit(1)

    const snapshot = current.configSnapshot ?? config?.publishedSnapshot ?? null
    const configVersionId = current.configSnapshot
      ? current.configVersionId
      : (config?.publishedVersionId ?? null)
    await tx
      .update(aiResponseRun)
      .set({ configSnapshot: snapshot, configVersionId })
      .where(eq(aiResponseRun.id, current.id))

    const boundaries = await tx
      // Keep PostgreSQL microseconds for cutoff comparisons; JavaScript Dates lose them.
      .select({ id: message.id, createdAt: sql<string>`${message.createdAt}::text` })
      .from(message)
      .where(
        and(
          eq(message.conversationId, current.conversationId),
          inArray(message.id, [current.inputFirstMessageId, current.inputLastMessageId]),
        ),
      )
    const start = boundaries.find(({ id }) => id === current.inputFirstMessageId)
    const end = boundaries.find(({ id }) => id === current.inputLastMessageId)
    const messages =
      start && end
        ? await tx
            .select({
              id: message.id,
              direction: message.direction,
              senderType: message.senderType,
              messageType: message.messageType,
              text: message.text,
              createdAt: message.createdAt,
            })
            .from(message)
            .where(
              and(
                eq(message.conversationId, current.conversationId),
                sql`(${message.createdAt}, ${message.id}) >= (${start.createdAt}::timestamptz, ${start.id}::uuid)`,
                sql`(${message.createdAt}, ${message.id}) <= (${end.createdAt}::timestamptz, ${end.id}::uuid)`,
              ),
            )
            .orderBy(asc(message.createdAt), asc(message.id))
        : []
    const firstIndex = messages.findIndex(({ id }) => id === current.inputFirstMessageId)
    const lastIndex = messages.findIndex(({ id }) => id === current.inputLastMessageId)
    const inputMessages =
      firstIndex >= 0 && lastIndex >= firstIndex
        ? messages
            .slice(firstIndex, lastIndex + 1)
            .filter(
              ({ direction, senderType }) => direction === 'INBOUND' && senderType === 'CUSTOMER',
            )
            .map(({ id, messageType, text }) => ({ id, messageType, text }))
        : []

    const history: AiConversationContextMessage[] = []
    const first = messages[firstIndex]
    const last = messages[lastIndex]
    if (first && last && start && end) {
      const recent = await tx
        .select({
          id: message.id,
          direction: message.direction,
          senderType: message.senderType,
          senderMemberId: message.senderMemberId,
          memberType: member.type,
          createdAt: message.createdAt,
          text: message.text,
        })
        .from(message)
        .innerJoin(
          conversation,
          and(
            eq(conversation.id, message.conversationId),
            eq(conversation.workspaceId, current.workspaceId),
          ),
        )
        .leftJoin(
          member,
          and(eq(member.id, message.senderMemberId), eq(member.workspaceId, current.workspaceId)),
        )
        .where(
          and(
            eq(message.conversationId, current.conversationId),
            sql`${message.text} is not null and trim(${message.text}) <> ''`,
            sql`(${message.createdAt}, ${message.id}) < (${start.createdAt}::timestamptz, ${start.id}::uuid)`,
            or(
              and(eq(message.direction, 'INBOUND'), eq(message.senderType, 'CUSTOMER')),
              and(
                eq(message.direction, 'OUTBOUND'),
                eq(message.senderType, 'MEMBER'),
                eq(message.deliveryState, 'SENT'),
                sql`(${message.deliveryCompletedAt} is null or ${message.deliveryCompletedAt} <= ${end.createdAt}::timestamptz)`,
              ),
            ),
          ),
        )
        .orderBy(desc(message.createdAt), desc(message.id))
        .limit(MAX_AI_HISTORY_MESSAGES + 1)
      const turns: AiConversationContextMessage[][] = []
      for (const item of recent.reverse()) {
        const origin = item.senderType === 'CUSTOMER' ? 'CUSTOMER' : item.memberType
        if (!origin || !item.text) continue
        if (origin === 'CUSTOMER' && turns.at(-1)?.at(-1)?.origin !== 'CUSTOMER') turns.push([])
        turns.at(-1)?.push({
          id: item.id,
          direction: item.direction,
          origin,
          senderMemberId: item.senderMemberId,
          createdAt: item.createdAt,
          text: item.text,
        })
      }
      // A bounded scan may begin inside a turn; retain only subsequent complete turns.
      if (recent.length > MAX_AI_HISTORY_MESSAGES && recent[0]?.senderType === 'CUSTOMER')
        turns.shift()
      let size = 0
      for (const turn of turns.reverse()) {
        if (turn.at(-1)?.origin === 'CUSTOMER') continue
        const length = turn.reduce((sum, item) => sum + Array.from(item.text).length, 0)
        if (
          size + length > MAX_AI_HISTORY_CODE_POINTS ||
          history.length + turn.length > MAX_AI_HISTORY_MESSAGES
        )
          break
        size += length
        history.unshift(...turn)
      }
    }

    if (current.contextMessageIds === null) {
      await tx
        .update(aiResponseRun)
        .set({ contextMessageIds: history.map(({ id }) => id) })
        .where(eq(aiResponseRun.id, current.id))
    } else {
      const stored = current.contextMessageIds.length
        ? await tx
            .select({
              id: message.id,
              direction: message.direction,
              senderType: message.senderType,
              senderMemberId: message.senderMemberId,
              createdAt: message.createdAt,
              text: message.text,
              memberType: member.type,
            })
            .from(message)
            .leftJoin(member, eq(member.id, message.senderMemberId))
            .where(
              and(
                eq(message.conversationId, current.conversationId),
                inArray(message.id, current.contextMessageIds),
              ),
            )
        : []
      history.splice(0, history.length)
      for (const id of current.contextMessageIds) {
        const item = stored.find((m) => m.id === id)
        const origin = item?.senderType === 'CUSTOMER' ? 'CUSTOMER' : item?.memberType
        if (item?.text && origin)
          history.push({
            id: item.id,
            direction: item.direction,
            origin,
            senderMemberId: item.senderMemberId,
            createdAt: item.createdAt,
            text: item.text,
          })
      }
    }

    return {
      kind: 'CLAIMED' as const,
      state: 'GENERATING' as const,
      id: current.id,
      workspaceId: current.workspaceId,
      conversationId: current.conversationId,
      memberId: current.memberId,
      inputFirstMessageId: current.inputFirstMessageId,
      inputLastMessageId: current.inputLastMessageId,
      publishedSnapshot: snapshot,
      replyLanguage: current.replyLanguage,
      configVersionId,
      inputMessages,
      history,
    }
  })
}

export async function recordAiResponseRetrievedChunks(
  db: Database,
  input: { runId: string; chunkIds: string[]; now?: Date },
) {
  const now = input.now ?? new Date()
  const [updated] = await db
    .update(aiResponseRun)
    .set({ retrievedChunkIds: input.chunkIds, updatedAt: now })
    .where(and(eq(aiResponseRun.id, input.runId), eq(aiResponseRun.state, 'GENERATING')))
    .returning({ id: aiResponseRun.id })
  return updated ?? null
}

export async function retryAiResponseRun(db: Database, input: { runId: string; now?: Date }) {
  const now = input.now ?? new Date()
  const [updated] = await db
    .update(aiResponseRun)
    .set({ state: 'QUEUED', scheduledFor: now, startedAt: null, updatedAt: now })
    .where(and(eq(aiResponseRun.id, input.runId), eq(aiResponseRun.state, 'GENERATING')))
    .returning({ id: aiResponseRun.id })
  return updated ?? null
}

export async function listStaleAiResponseRuns(
  db: Database,
  input: { now?: Date; limit?: number } = {},
) {
  const now = input.now ?? new Date()
  const cutoff = new Date(now.getTime() - AI_GENERATION_TIMEOUT_MS)
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 100)

  return db.transaction(async (tx) =>
    tx
      .select({
        runId: aiResponseRun.id,
        conversationId: aiResponseRun.conversationId,
        workspaceId: conversation.workspaceId,
        memberId: aiResponseRun.memberId,
      })
      .from(aiResponseRun)
      .innerJoin(conversation, eq(conversation.id, aiResponseRun.conversationId))
      .where(and(eq(aiResponseRun.state, 'GENERATING'), lte(aiResponseRun.startedAt, cutoff)))
      .orderBy(asc(aiResponseRun.startedAt), asc(aiResponseRun.id))
      .limit(limit)
      .for('update', { skipLocked: true }),
  )
}

export async function finishAiResponseRun(
  db: Database,
  input: {
    runId: string
    state: 'HANDOFF' | 'FAILED'
    failureCode?: string
    failureMessage?: string
    now?: Date
  },
) {
  const now = input.now ?? new Date()
  const [updated] = await db
    .update(aiResponseRun)
    .set({
      state: input.state,
      completedAt: now,
      failureCode: input.failureCode?.slice(0, 100) ?? null,
      failureMessage: input.failureMessage?.slice(0, 500) ?? null,
      updatedAt: now,
    })
    .where(and(eq(aiResponseRun.id, input.runId), eq(aiResponseRun.state, 'GENERATING')))
    .returning({ id: aiResponseRun.id })
  return updated ?? null
}

export async function recoverStaleAiResponseRuns(
  db: Database,
  input: { now?: Date; limit?: number } = {},
) {
  const now = input.now ?? new Date()
  const cutoff = new Date(now.getTime() - AI_GENERATION_TIMEOUT_MS)
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 100)
  return db.transaction(async (tx) => {
    const stale = await tx
      .select({ id: aiResponseRun.id, conversationId: aiResponseRun.conversationId })
      .from(aiResponseRun)
      .where(and(eq(aiResponseRun.state, 'GENERATING'), lte(aiResponseRun.startedAt, cutoff)))
      .orderBy(asc(aiResponseRun.startedAt), asc(aiResponseRun.id))
      .limit(limit)
      .for('update', { skipLocked: true })

    if (!stale.length) return []
    await tx
      .update(aiResponseRun)
      .set({
        state: 'FAILED',
        completedAt: now,
        failureCode: 'AI_GENERATION_TIMEOUT',
        failureMessage: 'AI generation exceeded the recovery timeout',
        updatedAt: now,
      })
      .where(
        and(
          eq(aiResponseRun.state, 'GENERATING'),
          inArray(
            aiResponseRun.id,
            stale.map(({ id }) => id),
          ),
        ),
      )

    return tx
      .select({
        runId: aiResponseRun.id,
        conversationId: aiResponseRun.conversationId,
        workspaceId: conversation.workspaceId,
      })
      .from(aiResponseRun)
      .innerJoin(conversation, eq(conversation.id, aiResponseRun.conversationId))
      .where(
        inArray(
          aiResponseRun.id,
          stale.map(({ id }) => id),
        ),
      )
  })
}

export type CommitAiResponseResult =
  | {
      kind: 'COMMITTED'
      workspaceId: string
      conversationId: string
      message: typeof message.$inferSelect
      messages: (typeof message.$inferSelect)[]
    }
  | { kind: 'CANCELLED'; cancellationReason: 'OWNERSHIP_CHANGED' | 'NEW_CUSTOMER_MESSAGE' }
  | null

export async function commitAiResponse(
  db: Database,
  input: {
    runId: string
    text: string
    now?: Date
    mediaAssetId?: string | null
    languageSelection?: { language: string; explicitSwitch: boolean } | null
  },
): Promise<CommitAiResponseResult> {
  const text = input.text.trim()
  if (!text || text.length > MAX_AI_RESPONSE_TEXT_LENGTH) {
    throw new AiResponseError('INVALID_REQUEST', 'AI response text is invalid')
  }
  const now = input.now ?? new Date()
  const selectedLanguage = input.languageSelection
    ? normalizeAiReplyLanguage(input.languageSelection.language)
    : undefined

  return db.transaction(async (tx) => {
    const [reference] = await tx
      .select({
        conversationId: aiResponseRun.conversationId,
        workspaceId: conversation.workspaceId,
      })
      .from(aiResponseRun)
      .innerJoin(conversation, eq(conversation.id, aiResponseRun.conversationId))
      .where(eq(aiResponseRun.id, input.runId))
      .limit(1)
    if (!reference) return null

    await tx.execute(
      sql`select id from ${workspace} where id = ${reference.workspaceId} for update`,
    )
    await tx.execute(
      sql`select id from ${conversation} where id = ${reference.conversationId} for update`,
    )
    const [current] = await tx
      .select({
        id: conversation.id,
        workspaceId: conversation.workspaceId,
        status: conversation.status,
        assigneeMemberId: conversation.assigneeMemberId,
        channelId: channelIdentity.channelId,
        latestMessageAt: conversation.latestMessageAt,
        lastCustomerMessageId: conversation.lastCustomerMessageId,
        replyLanguage: conversation.aiReplyLanguage,
      })
      .from(conversation)
      .innerJoin(channelIdentity, eq(channelIdentity.id, conversation.channelIdentityId))
      .where(eq(conversation.id, reference.conversationId))
      .limit(1)
    const [run] = await tx
      .select({
        id: aiResponseRun.id,
        conversationId: aiResponseRun.conversationId,
        memberId: aiResponseRun.memberId,
        state: aiResponseRun.state,
        inputLastMessageId: aiResponseRun.inputLastMessageId,
        configSnapshot: aiResponseRun.configSnapshot,
        retrievedChunkIds: aiResponseRun.retrievedChunkIds,
      })
      .from(aiResponseRun)
      .where(eq(aiResponseRun.id, input.runId))
      .for('update')
      .limit(1)
    if (!current || !run || run.state !== 'GENERATING') return null

    const [authorized] = await tx
      .select({ id: member.id })
      .from(member)
      .innerJoin(
        memberChannelAccess,
        and(
          eq(memberChannelAccess.memberId, member.id),
          eq(memberChannelAccess.channelId, current.channelId),
        ),
      )
      .innerJoin(channel, eq(channel.id, current.channelId))
      .where(
        and(
          eq(member.id, run.memberId),
          eq(member.workspaceId, current.workspaceId),
          eq(member.status, 'ACTIVE'),
          eq(member.type, 'AI'),
          eq(channel.workspaceId, current.workspaceId),
          eq(channel.status, 'ACTIVE'),
        ),
      )
      .for('share', { of: channel })
    if (!authorized || current.status !== 'OPEN' || current.assigneeMemberId !== run.memberId) {
      await cancelRun(tx, run.id, 'OWNERSHIP_CHANGED', now)
      return { kind: 'CANCELLED' as const, cancellationReason: 'OWNERSHIP_CHANGED' as const }
    }
    if (current.lastCustomerMessageId !== run.inputLastMessageId) {
      await cancelRun(tx, run.id, 'NEW_CUSTOMER_MESSAGE', now)
      return { kind: 'CANCELLED' as const, cancellationReason: 'NEW_CUSTOMER_MESSAGE' as const }
    }

    const replyLanguage = run.configSnapshot?.automaticLanguageEnabled
      ? selectedLanguage
      : undefined
    if (
      replyLanguage &&
      current.replyLanguage &&
      replyLanguage !== current.replyLanguage &&
      input.languageSelection?.explicitSwitch !== true
    )
      throw new AiResponseError('INVALID_REQUEST', 'Language change needs an explicit request')

    if (input.mediaAssetId && !run.configSnapshot?.knowledgeBaseId)
      throw new AiResponseError('MEDIA_UNAVAILABLE', 'Knowledge media is unavailable')
    const [asset] = input.mediaAssetId
      ? await tx
          .select({ asset: mediaAsset })
          .from(mediaAsset)
          .innerJoin(knowledgeDocument, eq(knowledgeDocument.mediaAssetId, mediaAsset.id))
          .innerJoin(knowledgeChunk, eq(knowledgeChunk.knowledgeDocumentId, knowledgeDocument.id))
          .where(
            and(
              eq(mediaAsset.id, input.mediaAssetId),
              eq(mediaAsset.workspaceId, current.workspaceId),
              eq(mediaAsset.inLibrary, true),
              isNull(mediaAsset.deletedAt),
              eq(knowledgeDocument.workspaceId, current.workspaceId),
              eq(knowledgeDocument.knowledgeBaseId, run.configSnapshot?.knowledgeBaseId ?? ''),
              eq(knowledgeDocument.status, 'READY'),
              inArray(knowledgeChunk.id, run.retrievedChunkIds ?? []),
            ),
          )
          .for('share', { of: [mediaAsset, knowledgeDocument] })
          .limit(1)
      : []
    if (input.mediaAssetId && !asset)
      throw new AiResponseError('MEDIA_UNAVAILABLE', 'Knowledge media is unavailable')
    const points = Array.from(text)
    const texts =
      run.configSnapshot?.splitRepliesEnabled && points.length > 500
        ? [
            points.slice(0, 500).join(''),
            points.slice(500, 1000).join(''),
            points.slice(1000).join(''),
          ].filter(Boolean)
        : [text]
    const [stamp] = await tx
      .select({ at: sql<string>`clock_timestamp()::text` })
      .from(conversation)
      .where(eq(conversation.id, current.id))
      .limit(1)
    const createdMessages = await tx
      .insert(message)
      .values(
        texts.map((part, index) => ({
          conversationId: current.id,
          channelId: current.channelId,
          senderMemberId: run.memberId,
          text: part,
          replyGroupId: texts.length > 1 || asset ? run.id : null,
          replySegmentIndex: texts.length > 1 || asset ? index + 1 : null,
          replySegmentCount: texts.length > 1 || asset ? texts.length : null,
          deliveryState: 'PENDING' as const,
          direction: 'OUTBOUND' as const,
          senderType: 'MEMBER' as const,
          messageType: 'TEXT' as const,
          createdAt: sql`${stamp.at}::timestamptz + ${index} * interval '1 microsecond'`,
          updatedAt: now,
        })),
      )
      .returning()
    const created = createdMessages[0]
    if (!created) throw new AiResponseError('INVALID_REQUEST', 'AI message was not created')
    if (asset) {
      const [mediaMessage] = await tx
        .insert(message)
        .values({
          conversationId: current.id,
          channelId: current.channelId,
          senderMemberId: run.memberId,
          direction: 'OUTBOUND',
          senderType: 'MEMBER',
          messageType: 'ATTACHMENT',
          deliveryState: 'PENDING',
          replyGroupId: run.id,
          replyAfterMessageId: createdMessages.at(-1)?.id,
          createdAt: sql`${stamp.at}::timestamptz + ${texts.length} * interval '1 microsecond'`,
          updatedAt: now,
        })
        .returning()
      if (!mediaMessage)
        throw new AiResponseError('INVALID_REQUEST', 'AI media message was not created')
      await tx.insert(messageAttachment).values({
        messageId: mediaMessage.id,
        assetId: asset.asset.id,
        kind: asset.asset.kind,
        filename: asset.asset.filename,
        mimeType: asset.asset.mimeType,
        byteSize: asset.asset.byteSize,
        storageKey: asset.asset.storageKey,
        storageState: 'READY',
      })
      createdMessages.push(mediaMessage)
    }

    await tx
      .update(conversation)
      .set({
        latestMessageAt: later(current.latestMessageAt, now),
        lastOutboundMessageAt: now,
        aiReplyLanguage: replyLanguage,
        updatedAt: now,
      })
      .where(eq(conversation.id, current.id))
    await tx
      .update(aiResponseRun)
      .set({ state: 'COMPLETED', outputMessageId: created.id, completedAt: now, updatedAt: now })
      .where(and(eq(aiResponseRun.id, run.id), eq(aiResponseRun.state, 'GENERATING')))

    return {
      kind: 'COMMITTED' as const,
      workspaceId: current.workspaceId,
      conversationId: current.id,
      message: created,
      messages: createdMessages,
    }
  })
}

async function cancelRun(
  tx: Transaction,
  runId: string,
  reason: AiResponseCancellationReason,
  now: Date,
) {
  await tx
    .update(aiResponseRun)
    .set({
      state: 'CANCELLED',
      cancellationReason: reason,
      completedAt: now,
      updatedAt: now,
    })
    .where(and(eq(aiResponseRun.id, runId), inArray(aiResponseRun.state, ['QUEUED', 'GENERATING'])))
}

function later(first: Date | null, second: Date) {
  return !first || second.getTime() > first.getTime() ? second : first
}
