import { and, eq, or } from 'drizzle-orm'
import type { Database } from './database'
import { assertInboxViewer, InboxError, type InboxFilters, validateInboxFilters } from './inbox'
import { inboxSavedView } from './schema'

type Context = { workspaceId: string; userId: string }

export async function listInboxViews(db: Database, input: Context) {
  const viewer = await assertInboxViewer(db, input.workspaceId, input.userId)
  const rows = await db
    .select()
    .from(inboxSavedView)
    .where(
      and(
        eq(inboxSavedView.workspaceId, input.workspaceId),
        or(eq(inboxSavedView.scope, 'PUBLIC'), eq(inboxSavedView.ownerMemberId, viewer.memberId)),
      ),
    )
    .orderBy(inboxSavedView.name, inboxSavedView.id)
  const views = await Promise.all(
    rows.map(async (row) => {
      let valid = true
      try {
        await validateInboxFilters(db, input, row.filters)
      } catch (error) {
        if (!(error instanceof InboxError) || error.code !== 'INVALID_REQUEST') throw error
        valid = false
      }
      return {
        ...row,
        valid,
        canEdit:
          row.scope === 'PUBLIC' ? viewer.role !== 'AGENT' : row.ownerMemberId === viewer.memberId,
      }
    }),
  )
  return { views }
}

export async function saveInboxView(
  db: Database,
  input: Context & {
    id?: string
    name: string
    scope: 'PERSONAL' | 'PUBLIC'
    filters: InboxFilters
  },
) {
  return db.transaction(async (tx) => {
    const viewer = await assertInboxViewer(tx, input.workspaceId, input.userId)
    if (input.scope === 'PUBLIC' && viewer.role === 'AGENT') throw new InboxError('FORBIDDEN')
    await validateInboxFilters(tx, input, input.filters)
    if (input.id) {
      const [existing] = await tx
        .select()
        .from(inboxSavedView)
        .where(
          and(eq(inboxSavedView.id, input.id), eq(inboxSavedView.workspaceId, input.workspaceId)),
        )
        .for('update')
      if (
        !existing ||
        (existing.scope === 'PERSONAL' && existing.ownerMemberId !== viewer.memberId)
      )
        throw new InboxError('NOT_FOUND')
      if (existing.scope === 'PUBLIC' && viewer.role === 'AGENT') throw new InboxError('FORBIDDEN')
      // A public view belongs to its creator; converting it must not expose another member's personal view.
      if (existing.scope !== input.scope && existing.ownerMemberId !== viewer.memberId)
        throw new InboxError('FORBIDDEN')
      const [view] = await tx
        .update(inboxSavedView)
        .set({
          name: input.name.trim(),
          scope: input.scope,
          filters: input.filters,
          updatedAt: new Date(),
        })
        .where(eq(inboxSavedView.id, input.id))
        .returning()
      return { view }
    }
    const [view] = await tx
      .insert(inboxSavedView)
      .values({
        workspaceId: input.workspaceId,
        ownerMemberId: viewer.memberId,
        name: input.name.trim(),
        scope: input.scope,
        filters: input.filters,
      })
      .returning()
    return { view }
  })
}

export async function deleteInboxView(db: Database, input: Context & { id: string }) {
  return db.transaction(async (tx) => {
    const viewer = await assertInboxViewer(tx, input.workspaceId, input.userId)
    const [existing] = await tx
      .select()
      .from(inboxSavedView)
      .where(
        and(eq(inboxSavedView.id, input.id), eq(inboxSavedView.workspaceId, input.workspaceId)),
      )
      .for('update')
    if (!existing || (existing.scope === 'PERSONAL' && existing.ownerMemberId !== viewer.memberId))
      throw new InboxError('NOT_FOUND')
    if (existing.scope === 'PUBLIC' && viewer.role === 'AGENT') throw new InboxError('FORBIDDEN')
    await tx.delete(inboxSavedView).where(eq(inboxSavedView.id, input.id))
  })
}
