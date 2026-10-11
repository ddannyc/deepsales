import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import type { AiConversationContextMessage } from './ai-responses'
import type { Database } from './database'
import { assertInboxConversationAccess } from './inbox'
import { ReplyError } from './outbound'
import {
  aiMemberConfig,
  channelIdentity,
  conversation,
  knowledgeBase,
  knowledgeChunk,
  member,
  memberChannelAccess,
  message,
  replySuggestion,
} from './schema'

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0]
type Identity = { workspaceId: string; conversationId: string; userId: string }

async function authorize(tx: Transaction, input: Identity) {
  await tx.execute(sql`select id from workspace where id = ${input.workspaceId} for share`)
  await tx.execute(
    sql`select id from ${conversation} where id = ${input.conversationId} and workspace_id = ${input.workspaceId} for update`,
  )
  const viewer = await assertInboxConversationAccess(tx, input)
  const [current] = await tx
    .select()
    .from(conversation)
    .where(eq(conversation.id, input.conversationId))
  if (current.status !== 'OPEN' || current.assigneeMemberId !== viewer.memberId)
    throw new ReplyError('FORBIDDEN')
  const [identity] = await tx
    .select()
    .from(channelIdentity)
    .where(eq(channelIdentity.id, current.channelIdentityId))
  const [allowed] = await tx
    .select()
    .from(memberChannelAccess)
    .where(
      and(
        eq(memberChannelAccess.memberId, viewer.memberId),
        eq(memberChannelAccess.channelId, identity.channelId),
      ),
    )
  if (!allowed) throw new ReplyError('FORBIDDEN')
  return { viewer, channelId: identity.channelId }
}

export async function latestSuggestionInput(tx: Database | Transaction, conversationId: string) {
  const [latest] = await tx
    .select()
    .from(message)
    .where(
      and(
        eq(message.conversationId, conversationId),
        eq(message.direction, 'INBOUND'),
        eq(message.senderType, 'CUSTOMER'),
      ),
    )
    .orderBy(desc(message.createdAt), desc(message.id))
    .limit(1)
  return latest
}

async function assertAiAccess(
  tx: Transaction,
  workspaceId: string,
  channelId: string,
  aiMemberId: string,
) {
  const allowed = await tx.execute(
    sql`select 1 from ${member} m join ${memberChannelAccess} a on a.member_id = m.id join ${aiMemberConfig} c on c.member_id = m.id where m.id = ${aiMemberId} and m.workspace_id = ${workspaceId} and m.type = 'AI' and m.status = 'ACTIVE' and a.channel_id = ${channelId} and c.published_snapshot is not null`,
  )
  if (!allowed.rows.length) throw new ReplyError('FORBIDDEN')
}

export async function createReplySuggestion(
  db: Database,
  input: Identity & { id: string; aiMemberId: string },
) {
  return db.transaction(async (tx) => {
    const { viewer, channelId } = await authorize(tx, input)
    const [existing] = await tx
      .select()
      .from(replySuggestion)
      .where(eq(replySuggestion.id, input.id))
    if (existing) {
      if (
        existing.workspaceId !== input.workspaceId ||
        existing.conversationId !== input.conversationId ||
        existing.requesterMemberId !== viewer.memberId ||
        existing.aiMemberId !== input.aiMemberId
      )
        throw new ReplyError('INVALID_REQUEST')
      if ((await latestSuggestionInput(tx, input.conversationId))?.id !== existing.inputMessageId)
        throw new ReplyError('INVALID_REQUEST', 'Suggestion is stale')
      await assertAiAccess(tx, input.workspaceId, channelId, existing.aiMemberId)
      return existing
    }
    const [configured] = await tx
      .select({
        snapshot: aiMemberConfig.publishedSnapshot,
        versionId: aiMemberConfig.publishedVersionId,
      })
      .from(aiMemberConfig)
      .innerJoin(member, eq(member.id, aiMemberConfig.memberId))
      .innerJoin(
        memberChannelAccess,
        and(
          eq(memberChannelAccess.memberId, member.id),
          eq(memberChannelAccess.channelId, channelId),
        ),
      )
      .where(
        and(
          eq(member.id, input.aiMemberId),
          eq(member.workspaceId, input.workspaceId),
          eq(member.type, 'AI'),
          eq(member.status, 'ACTIVE'),
        ),
      )
    const snapshot = configured?.snapshot
    if (!snapshot) throw new ReplyError('INVALID_REQUEST', 'Published AI required')
    const [base] = await tx
      .select()
      .from(knowledgeBase)
      .where(
        and(
          eq(knowledgeBase.id, snapshot.knowledgeBaseId),
          eq(knowledgeBase.workspaceId, input.workspaceId),
        ),
      )
    if (!base) throw new ReplyError('INVALID_REQUEST')
    const latest = await latestSuggestionInput(tx, input.conversationId)
    if (!latest?.text?.trim() || Array.from(latest.text).length > 8000)
      throw new ReplyError('INVALID_REQUEST')
    const context = await tx
      .select({ id: message.id, text: message.text })
      .from(message)
      .where(
        and(
          eq(message.conversationId, input.conversationId),
          sql`(${message.createdAt}, ${message.id}) < (${latest.createdAt}::timestamptz, ${latest.id}::uuid)`,
          sql`${message.text} is not null`,
          sql`(${message.senderType} = 'CUSTOMER' or (${message.senderType} = 'MEMBER' and ${message.deliveryState} = 'SENT'))`,
        ),
      )
      .orderBy(desc(message.createdAt), desc(message.id))
      .limit(48)
    let size = Array.from(latest.text).length
    const ids: string[] = []
    for (const item of context) {
      size += Array.from(item.text ?? '').length
      if (size > 8000) break
      ids.unshift(item.id)
    }
    const [created] = await tx
      .insert(replySuggestion)
      .values({
        id: input.id,
        workspaceId: input.workspaceId,
        conversationId: input.conversationId,
        requesterMemberId: viewer.memberId,
        aiMemberId: input.aiMemberId,
        inputMessageId: latest.id,
        contextMessageIds: ids,
        snapshot,
        configVersionId: configured.versionId,
      })
      .returning()
    return created
  })
}

export async function readReplySuggestionContext(db: Database, input: Identity & { id: string }) {
  return db.transaction(async (tx) => {
    const { viewer, channelId } = await authorize(tx, input)
    const [record] = await tx
      .select()
      .from(replySuggestion)
      .where(
        and(
          eq(replySuggestion.id, input.id),
          eq(replySuggestion.workspaceId, input.workspaceId),
          eq(replySuggestion.conversationId, input.conversationId),
          eq(replySuggestion.requesterMemberId, viewer.memberId),
        ),
      )
    if (!record) throw new ReplyError('NOT_FOUND')
    await assertAiAccess(tx, input.workspaceId, channelId, record.aiMemberId)
    const latest = await latestSuggestionInput(tx, input.conversationId)
    if (latest?.id !== record.inputMessageId || !latest.text)
      throw new ReplyError('INVALID_REQUEST', 'Suggestion is stale')
    const rows = record.contextMessageIds.length
      ? await tx
          .select({
            id: message.id,
            text: message.text,
            direction: message.direction,
            senderType: message.senderType,
            senderMemberId: message.senderMemberId,
            createdAt: message.createdAt,
            memberType: member.type,
          })
          .from(message)
          .leftJoin(member, eq(member.id, message.senderMemberId))
          .where(
            and(
              eq(message.conversationId, input.conversationId),
              inArray(message.id, record.contextMessageIds),
            ),
          )
      : []
    const history: AiConversationContextMessage[] = []
    for (const id of record.contextMessageIds) {
      const item = rows.find((row) => row.id === id)
      if (item?.text)
        history.push({
          ...item,
          text: item.text,
          origin: item.senderType === 'CUSTOMER' ? 'CUSTOMER' : (item.memberType ?? 'HUMAN'),
        })
    }
    return { record, messages: [{ id: latest.id, text: latest.text }], history }
  })
}

export async function completeReplySuggestion(
  db: Database,
  input: Identity & { id: string; text: string; chunkIds: string[] },
) {
  return db.transaction(async (tx) => {
    const { viewer, channelId } = await authorize(tx, input)
    const [record] = await tx
      .select()
      .from(replySuggestion)
      .where(
        and(
          eq(replySuggestion.id, input.id),
          eq(replySuggestion.workspaceId, input.workspaceId),
          eq(replySuggestion.conversationId, input.conversationId),
          eq(replySuggestion.requesterMemberId, viewer.memberId),
        ),
      )
    if (!record) throw new ReplyError('NOT_FOUND')
    await assertAiAccess(tx, input.workspaceId, channelId, record.aiMemberId)
    if ((await latestSuggestionInput(tx, input.conversationId))?.id !== record.inputMessageId)
      throw new ReplyError('INVALID_REQUEST', 'Suggestion is stale')
    if (!input.text.trim() || input.text.length > 2000 || input.chunkIds.length > 6)
      throw new ReplyError('INVALID_REQUEST')
    if (
      record.suggestedText &&
      (record.suggestedText !== input.text.trim() ||
        JSON.stringify(record.chunkIds) !== JSON.stringify(input.chunkIds))
    )
      throw new ReplyError('INVALID_REQUEST')
    if (input.chunkIds.length) {
      const chunks = await tx
        .select({ id: knowledgeChunk.id })
        .from(knowledgeChunk)
        .where(
          and(
            eq(knowledgeChunk.workspaceId, input.workspaceId),
            eq(knowledgeChunk.knowledgeBaseId, record.snapshot.knowledgeBaseId),
            inArray(knowledgeChunk.id, input.chunkIds),
          ),
        )
      if (chunks.length !== input.chunkIds.length) throw new ReplyError('INVALID_REQUEST')
    }
    const [updated] = await tx
      .update(replySuggestion)
      .set({ suggestedText: input.text.trim(), chunkIds: input.chunkIds })
      .where(eq(replySuggestion.id, record.id))
      .returning()
    return updated
  })
}
