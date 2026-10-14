import { and, desc, eq, getTableColumns, sql } from 'drizzle-orm'
import { commitAiResponse } from './ai-responses'
import { selectedAiSkillId } from './ai-skills'
import { readAiRunToolInstructions } from './ai-tool-authorization'
import { instructionTools } from './ai-tools'
import type { Database } from './database'
import { assertInboxConversationAccess, InboxError } from './inbox'
import {
  aiMemberConfig,
  aiOperation,
  aiResponseRun,
  conversation,
  conversationInternalNote,
  conversationMemberMute,
  member,
} from './schema'

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0]

type Context = { workspaceId: string; userId: string; conversationId: string }

export async function createAiInternalNote(
  db: Database | Transaction,
  input: {
    runId: string
    clientKey: string
    text: string
    handoffEvaluation?: Parameters<typeof commitAiResponse>[1]['handoffEvaluation']
  },
) {
  if (!input.text.trim() || input.text.length > 2000)
    throw new InboxError('INVALID_REQUEST', 'Invalid internal note')
  return db.transaction(async (tx) => {
    const guard = await commitAiResponse(tx, {
      runId: input.runId,
      text: '',
      stopCheckOnly: true,
      handoffEvaluation: input.handoffEvaluation,
    })
    if (guard?.kind !== 'CONTINUE') return { guard }
    const [author] = await tx
      .select({
        conversationId: aiResponseRun.conversationId,
        memberId: member.id,
        name: member.displayName,
        frozen: aiResponseRun.configSnapshot,
        current: aiMemberConfig.publishedSnapshot,
        operationOutput: aiOperation.output,
      })
      .from(aiResponseRun)
      .innerJoin(member, eq(member.id, aiResponseRun.memberId))
      .innerJoin(aiMemberConfig, eq(aiMemberConfig.memberId, member.id))
      .innerJoin(aiOperation, eq(aiOperation.id, aiResponseRun.id))
      .where(eq(aiResponseRun.id, input.runId))
    const authorized = author
      ? await readAiRunToolInstructions(
          tx,
          input.runId,
          author.frozen,
          author.current,
          selectedAiSkillId(author.operationOutput),
        )
      : null
    if (
      !author ||
      !authorized ||
      !instructionTools(authorized.frozen).includes('record') ||
      !instructionTools(authorized.current).includes('record')
    )
      throw new InboxError('INVALID_REQUEST', 'Tool is unavailable')
    await tx
      .insert(conversationInternalNote)
      .values({
        conversationId: author.conversationId,
        authorMemberId: author.memberId,
        authorName: author.name ?? 'AI member',
        clientKey: input.clientKey,
        text: input.text.trim(),
        createdAt: sql`clock_timestamp()`,
      })
      .onConflictDoNothing()
    const [note] = await tx
      .select({ id: conversationInternalNote.id, text: conversationInternalNote.text })
      .from(conversationInternalNote)
      .where(
        and(
          eq(conversationInternalNote.conversationId, author.conversationId),
          eq(conversationInternalNote.authorMemberId, author.memberId),
          eq(conversationInternalNote.clientKey, input.clientKey),
        ),
      )
    if (!note || note.text !== input.text.trim()) throw new InboxError('INVALID_REQUEST')
    return { noteId: note.id }
  })
}

export async function setConversationMute(db: Database, input: Context & { muted: boolean }) {
  return db.transaction(async (tx) => {
    const viewer = await assertInboxConversationAccess(tx, input)
    if (input.muted)
      await tx
        .insert(conversationMemberMute)
        .values({ conversationId: input.conversationId, memberId: viewer.memberId })
        .onConflictDoNothing()
    else
      await tx
        .delete(conversationMemberMute)
        .where(
          and(
            eq(conversationMemberMute.conversationId, input.conversationId),
            eq(conversationMemberMute.memberId, viewer.memberId),
          ),
        )
    return { muted: input.muted }
  })
}
const noteFields = {
  ...getTableColumns(conversationInternalNote),
  createdAt: sql<string>`to_char(${conversationInternalNote.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
}

export async function listInternalNotes(
  db: Database,
  input: Context & { before?: { createdAt: string; id: string } },
) {
  await assertInboxConversationAccess(db, input)
  const rows = await db
    .select(noteFields)
    .from(conversationInternalNote)
    .where(
      and(
        eq(conversationInternalNote.conversationId, input.conversationId),
        input.before
          ? sql`(${conversationInternalNote.createdAt}, ${conversationInternalNote.id}) < (${input.before.createdAt}::timestamptz, ${input.before.id}::uuid)`
          : undefined,
      ),
    )
    .orderBy(desc(conversationInternalNote.createdAt), desc(conversationInternalNote.id))
    .limit(51)
  const notes = rows.slice(0, 50).reverse()
  const oldest = notes[0]
  return {
    notes,
    olderCursor: rows.length > 50 && oldest ? { createdAt: oldest.createdAt, id: oldest.id } : null,
  }
}

export async function createInternalNote(
  db: Database,
  input: Context & { clientKey: string; text: string },
) {
  if (!input.text.trim() || input.text.length > 2000)
    throw new InboxError('INVALID_REQUEST', 'Invalid internal note')
  return db.transaction(async (tx) => {
    const viewer = await assertInboxConversationAccess(tx, input)
    const [current] = await tx
      .select({ status: conversation.status })
      .from(conversation)
      .where(eq(conversation.id, input.conversationId))
      .for('update')
    const [existing] = await tx
      .select(noteFields)
      .from(conversationInternalNote)
      .where(
        and(
          eq(conversationInternalNote.conversationId, input.conversationId),
          eq(conversationInternalNote.authorMemberId, viewer.memberId),
          eq(conversationInternalNote.clientKey, input.clientKey),
        ),
      )
    if (existing) {
      if (existing.text !== input.text.trim())
        throw new InboxError('INVALID_REQUEST', 'Retry key belongs to another note')
      return { note: existing }
    }
    if (current?.status !== 'OPEN')
      throw new InboxError('INVALID_REQUEST', 'Conversation is closed')
    const [author] = await tx
      .select({ name: member.displayName })
      .from(member)
      .where(eq(member.id, viewer.memberId))
    const [note] = await tx
      .insert(conversationInternalNote)
      .values({
        conversationId: input.conversationId,
        authorMemberId: viewer.memberId,
        authorName: author.name ?? 'Team member',
        clientKey: input.clientKey,
        text: input.text.trim(),
        createdAt: sql`clock_timestamp()`,
      })
      .returning(noteFields)
    return { note }
  })
}
