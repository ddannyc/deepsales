import { and, desc, eq, getTableColumns, sql } from 'drizzle-orm'
import type { Database } from './database'
import { assertInboxConversationAccess, InboxError } from './inbox'
import { conversation, conversationInternalNote, conversationMemberMute, member } from './schema'

type Context = { workspaceId: string; userId: string; conversationId: string }

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
