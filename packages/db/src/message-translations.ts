import { and, eq, sql } from 'drizzle-orm'
import type { Database } from './database'
import { assertInboxConversationAccess } from './inbox'
import { ReplyError } from './outbound'
import { conversation, memberChannelAccess, message, messageTranslation } from './schema'

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0]
type Identity = { workspaceId: string; conversationId: string; userId: string }
export const TRANSLATION_LANGUAGES = ['en', 'zh', 'es', 'fr', 'de', 'ja', 'pt', 'ar'] as const

async function authorize(tx: Transaction, input: Identity, outgoing: boolean) {
  await tx.execute(sql`select id from workspace where id = ${input.workspaceId} for share`)
  await tx.execute(
    sql`select id from ${conversation} where id = ${input.conversationId} and workspace_id = ${input.workspaceId} for update`,
  )
  const viewer = await assertInboxConversationAccess(tx, input)
  if (outgoing) {
    const [current] = await tx
      .select({
        owner: conversation.assigneeMemberId,
        status: conversation.status,
        channelIdentityId: conversation.channelIdentityId,
      })
      .from(conversation)
      .where(eq(conversation.id, input.conversationId))
    if (current.status !== 'OPEN' || current.owner !== viewer.memberId)
      throw new ReplyError('FORBIDDEN')
    // Draft translation is available to the same human who can send this reply.
    const allowed = await tx.execute(
      sql`select 1 from ${memberChannelAccess} a join channel_identity i on i.channel_id = a.channel_id where a.member_id = ${viewer.memberId} and i.id = ${current.channelIdentityId}`,
    )
    if (!allowed.rows.length) throw new ReplyError('FORBIDDEN')
  }
  return viewer
}

export async function createMessageTranslation(
  db: Database,
  input: Identity & {
    id: string
    sourceMessageId?: string
    sourceText?: string
    sourceVersion: string
    targetLanguage: string
  },
) {
  if (
    !TRANSLATION_LANGUAGES.includes(
      input.targetLanguage as (typeof TRANSLATION_LANGUAGES)[number],
    ) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.sourceVersion) ||
    Boolean(input.sourceMessageId) === Boolean(input.sourceText)
  )
    throw new ReplyError('INVALID_REQUEST')
  return db.transaction(async (tx) => {
    const viewer = await authorize(tx, input, !input.sourceMessageId)
    let text = input.sourceText?.trim() ?? ''
    if (input.sourceMessageId) {
      const [source] = await tx
        .select({ text: message.text })
        .from(message)
        .where(
          and(
            eq(message.id, input.sourceMessageId),
            eq(message.conversationId, input.conversationId),
          ),
        )
      if (!source?.text) throw new ReplyError('NOT_FOUND')
      text = source.text
    }
    if (!text.trim() || text.length > (input.sourceMessageId ? 8000 : 2000))
      throw new ReplyError('INVALID_REQUEST')
    const [existing] = await tx
      .select()
      .from(messageTranslation)
      .where(eq(messageTranslation.id, input.id))
    if (existing) {
      if (
        existing.workspaceId !== input.workspaceId ||
        existing.conversationId !== input.conversationId ||
        existing.requesterMemberId !== viewer.memberId ||
        existing.sourceText !== text ||
        existing.sourceVersion !== input.sourceVersion ||
        existing.targetLanguage !== input.targetLanguage ||
        existing.sourceMessageId !== (input.sourceMessageId ?? null)
      )
        throw new ReplyError('INVALID_REQUEST')
      return existing
    }
    if (input.sourceMessageId) {
      const [cached] = await tx
        .select()
        .from(messageTranslation)
        .where(
          and(
            eq(messageTranslation.requesterMemberId, viewer.memberId),
            eq(messageTranslation.sourceMessageId, input.sourceMessageId),
            eq(messageTranslation.targetLanguage, input.targetLanguage),
          ),
        )
      if (cached) return cached
    }
    const [created] = await tx
      .insert(messageTranslation)
      .values({
        id: input.id,
        workspaceId: input.workspaceId,
        conversationId: input.conversationId,
        requesterMemberId: viewer.memberId,
        sourceMessageId: input.sourceMessageId,
        sourceText: text,
        sourceVersion: input.sourceVersion,
        targetLanguage: input.targetLanguage,
      })
      .returning()
    return created
  })
}

export async function completeMessageTranslation(
  db: Database,
  input: Identity & { id: string; text: string },
) {
  return db.transaction(async (tx) => {
    // Match authorization lock order before reading an immutable result.
    await tx.execute(sql`select id from workspace where id = ${input.workspaceId} for share`)
    await tx.execute(
      sql`select id from ${conversation} where id = ${input.conversationId} and workspace_id = ${input.workspaceId} for update`,
    )
    const [record] = await tx
      .select()
      .from(messageTranslation)
      .where(
        and(
          eq(messageTranslation.id, input.id),
          eq(messageTranslation.workspaceId, input.workspaceId),
          eq(messageTranslation.conversationId, input.conversationId),
        ),
      )
    if (!record) throw new ReplyError('NOT_FOUND')
    const viewer = await authorize(tx, input, !record.sourceMessageId)
    if (viewer.memberId !== record.requesterMemberId) throw new ReplyError('FORBIDDEN')
    if (!input.text.trim() || input.text.length > (record.sourceMessageId ? 12000 : 2000))
      throw new ReplyError('INVALID_REQUEST')
    if (record.translatedText && record.translatedText !== input.text.trim())
      throw new ReplyError('INVALID_REQUEST')
    const [updated] = await tx
      .update(messageTranslation)
      .set({ translatedText: input.text.trim() })
      .where(eq(messageTranslation.id, record.id))
      .returning()
    return updated
  })
}
