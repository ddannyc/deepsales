import { and, asc, eq, sql } from 'drizzle-orm'
import type { Database } from './database'
import {
  aiMemberConfig,
  aiResponseRun,
  channelIdentity,
  conversation,
  member,
  message,
  type AiMemberRuntimeSnapshot,
} from './schema'

const MAX_AI_RESPONSE_TEXT_LENGTH = 2_000

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0]

export type AiResponseInputMessage = {
  id: string
  messageType: 'TEXT' | 'ATTACHMENT'
  text: string | null
}

export type AiResponseRunClaim = {
  kind: 'CLAIMED'
  state: 'GENERATING'
  id: string
  workspaceId: string
  conversationId: string
  memberId: string
  inputFirstMessageId: string
  inputLastMessageId: string
  publishedSnapshot: AiMemberRuntimeSnapshot | null
  inputMessages: AiResponseInputMessage[]
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
    readonly code: 'NOT_FOUND' | 'INVALID_REQUEST',
    message: string = code,
  ) {
    super(message)
  }
}

export async function claimAiResponseRun(
  db: Database,
  input: { runId: string; now?: Date },
): Promise<AiResponseRunClaimResult> {
  const now = input.now ?? new Date()
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({
        id: aiResponseRun.id,
        conversationId: aiResponseRun.conversationId,
        memberId: aiResponseRun.memberId,
        state: aiResponseRun.state,
        inputFirstMessageId: aiResponseRun.inputFirstMessageId,
        inputLastMessageId: aiResponseRun.inputLastMessageId,
        scheduledFor: aiResponseRun.scheduledFor,
        workspaceId: conversation.workspaceId,
        conversationStatus: conversation.status,
        assigneeMemberId: conversation.assigneeMemberId,
      })
      .from(aiResponseRun)
      .innerJoin(conversation, eq(conversation.id, aiResponseRun.conversationId))
      .innerJoin(member, eq(member.id, aiResponseRun.memberId))
      .where(eq(aiResponseRun.id, input.runId))
      .for('update')
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
      .select({ publishedSnapshot: aiMemberConfig.publishedSnapshot })
      .from(aiMemberConfig)
      .where(eq(aiMemberConfig.memberId, current.memberId))
      .limit(1)

    const messages = await tx
      .select({
        id: message.id,
        direction: message.direction,
        senderType: message.senderType,
        messageType: message.messageType,
        text: message.text,
      })
      .from(message)
      .where(eq(message.conversationId, current.conversationId))
      .orderBy(asc(message.createdAt), asc(message.id))
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

    return {
      kind: 'CLAIMED' as const,
      state: 'GENERATING' as const,
      id: current.id,
      workspaceId: current.workspaceId,
      conversationId: current.conversationId,
      memberId: current.memberId,
      inputFirstMessageId: current.inputFirstMessageId,
      inputLastMessageId: current.inputLastMessageId,
      publishedSnapshot: config?.publishedSnapshot ?? null,
      inputMessages,
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

export type CommitAiResponseResult =
  | {
      kind: 'COMMITTED'
      workspaceId: string
      conversationId: string
      message: typeof message.$inferSelect
    }
  | { kind: 'CANCELLED'; cancellationReason: 'OWNERSHIP_CHANGED' | 'NEW_CUSTOMER_MESSAGE' }
  | null

export async function commitAiResponse(
  db: Database,
  input: { runId: string; text: string; now?: Date },
): Promise<CommitAiResponseResult> {
  const text = input.text.trim()
  if (!text || text.length > MAX_AI_RESPONSE_TEXT_LENGTH) {
    throw new AiResponseError('INVALID_REQUEST', 'AI response text is invalid')
  }
  const now = input.now ?? new Date()

  return db.transaction(async (tx) => {
    const [reference] = await tx
      .select({ conversationId: aiResponseRun.conversationId })
      .from(aiResponseRun)
      .where(eq(aiResponseRun.id, input.runId))
      .limit(1)
    if (!reference) return null

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
      })
      .from(aiResponseRun)
      .where(eq(aiResponseRun.id, input.runId))
      .for('update')
      .limit(1)
    if (!current || !run || run.state !== 'GENERATING') return null

    if (current.status !== 'OPEN' || current.assigneeMemberId !== run.memberId) {
      await cancelRun(tx, run.id, 'OWNERSHIP_CHANGED', now)
      return { kind: 'CANCELLED' as const, cancellationReason: 'OWNERSHIP_CHANGED' as const }
    }
    if (current.lastCustomerMessageId !== run.inputLastMessageId) {
      await cancelRun(tx, run.id, 'NEW_CUSTOMER_MESSAGE', now)
      return { kind: 'CANCELLED' as const, cancellationReason: 'NEW_CUSTOMER_MESSAGE' as const }
    }

    const [created] = await tx
      .insert(message)
      .values({
        conversationId: current.id,
        channelId: current.channelId,
        direction: 'OUTBOUND',
        senderType: 'MEMBER',
        senderMemberId: run.memberId,
        messageType: 'TEXT',
        text,
        deliveryState: 'PENDING',
        createdAt: now,
        updatedAt: now,
      })
      .returning()
    if (!created) throw new AiResponseError('INVALID_REQUEST', 'AI message was not created')

    await tx
      .update(conversation)
      .set({
        latestMessageAt: later(current.latestMessageAt, now),
        lastOutboundMessageAt: now,
        updatedAt: now,
      })
      .where(eq(conversation.id, current.id))
    await tx
      .update(aiResponseRun)
      .set({ state: 'COMPLETED', completedAt: now, updatedAt: now })
      .where(and(eq(aiResponseRun.id, run.id), eq(aiResponseRun.state, 'GENERATING')))

    return {
      kind: 'COMMITTED' as const,
      workspaceId: current.workspaceId,
      conversationId: current.id,
      message: created,
    }
  })
}

async function cancelRun(
  tx: Transaction,
  runId: string,
  reason: 'OWNERSHIP_CHANGED' | 'NEW_CUSTOMER_MESSAGE',
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
    .where(eq(aiResponseRun.id, runId))
}

function later(first: Date | null, second: Date) {
  return !first || second.getTime() > first.getTime() ? second : first
}
