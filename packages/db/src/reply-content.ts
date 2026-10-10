import { and, desc, eq, ilike, isNull, or } from 'drizzle-orm'
import type { Database } from './database'
import { assertInboxViewer, InboxError } from './inbox'
import { mediaAsset, replyTemplate } from './schema'

type Context = { workspaceId: string; userId: string }
const publicAsset = {
  id: mediaAsset.id,
  title: mediaAsset.title,
  filename: mediaAsset.filename,
  kind: mediaAsset.kind,
  mimeType: mediaAsset.mimeType,
  byteSize: mediaAsset.byteSize,
  inLibrary: mediaAsset.inLibrary,
}

export async function listMediaAssets(db: Database, input: Context & { query?: string }) {
  await assertInboxViewer(db, input.workspaceId, input.userId)
  return {
    assets: await db
      .select(publicAsset)
      .from(mediaAsset)
      .where(
        and(
          eq(mediaAsset.workspaceId, input.workspaceId),
          eq(mediaAsset.inLibrary, true),
          isNull(mediaAsset.deletedAt),
          input.query
            ? or(
                ilike(mediaAsset.title, `%${input.query}%`),
                ilike(mediaAsset.filename, `%${input.query}%`),
              )
            : undefined,
        ),
      )
      .orderBy(desc(mediaAsset.createdAt), desc(mediaAsset.id))
      .limit(100),
  }
}

export async function getMediaAsset(db: Database, input: Context & { assetId: string }) {
  await assertInboxViewer(db, input.workspaceId, input.userId)
  const [asset] = await db
    .select()
    .from(mediaAsset)
    .where(
      and(
        eq(mediaAsset.id, input.assetId),
        eq(mediaAsset.workspaceId, input.workspaceId),
        isNull(mediaAsset.deletedAt),
      ),
    )
  if (!asset) throw new InboxError('NOT_FOUND', 'Media asset is unavailable')
  return asset
}

export async function createMediaAsset(
  db: Database,
  input: Context & { asset: typeof mediaAsset.$inferInsert },
) {
  return db.transaction(async (tx) => {
    await assertInboxViewer(tx, input.workspaceId, input.userId)
    await tx
      .insert(mediaAsset)
      .values({ ...input.asset, workspaceId: input.workspaceId })
      .onConflictDoNothing()
    const [asset] = await tx
      .select()
      .from(mediaAsset)
      .where(
        and(
          eq(mediaAsset.id, input.asset.id),
          eq(mediaAsset.workspaceId, input.workspaceId),
          isNull(mediaAsset.deletedAt),
        ),
      )
    if (
      !asset ||
      asset.sha256 !== input.asset.sha256 ||
      asset.mimeType !== input.asset.mimeType ||
      asset.filename !== input.asset.filename
    )
      throw new InboxError('INVALID_REQUEST', 'Upload ID already used')
    return {
      asset: {
        id: asset.id,
        title: asset.title,
        filename: asset.filename,
        kind: asset.kind,
        mimeType: asset.mimeType,
        byteSize: asset.byteSize,
        inLibrary: asset.inLibrary,
      },
    }
  })
}

export async function updateMediaAsset(
  db: Database,
  input: Context & { assetId: string; title?: string; inLibrary?: boolean; deleted?: boolean },
) {
  return db.transaction(async (tx) => {
    await assertInboxViewer(tx, input.workspaceId, input.userId)
    const [asset] = await tx
      .update(mediaAsset)
      .set({
        ...(input.deleted ? { deletedAt: new Date() } : {}),
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.inLibrary === undefined ? {} : { inLibrary: input.inLibrary }),
      })
      .where(
        and(
          eq(mediaAsset.id, input.assetId),
          eq(mediaAsset.workspaceId, input.workspaceId),
          isNull(mediaAsset.deletedAt),
        ),
      )
      .returning(publicAsset)
    if (!asset) throw new InboxError('NOT_FOUND', 'Media asset is unavailable')
    return { asset }
  })
}

export async function listReplyTemplates(db: Database, input: Context & { query?: string }) {
  await assertInboxViewer(db, input.workspaceId, input.userId)
  return {
    templates: await db
      .select()
      .from(replyTemplate)
      .where(
        and(
          eq(replyTemplate.workspaceId, input.workspaceId),
          input.query
            ? or(
                ilike(replyTemplate.title, `%${input.query}%`),
                ilike(replyTemplate.text, `%${input.query}%`),
              )
            : undefined,
        ),
      )
      .orderBy(desc(replyTemplate.updatedAt), desc(replyTemplate.id))
      .limit(100),
  }
}

export async function saveReplyTemplate(
  db: Database,
  input: Context & { id?: string; title: string; text: string },
) {
  return db.transaction(async (tx) => {
    await assertInboxViewer(tx, input.workspaceId, input.userId)
    if (
      !input.title.trim() ||
      input.title.length > 100 ||
      !input.text.trim() ||
      input.text.length > 2000
    )
      throw new InboxError('INVALID_REQUEST', 'Invalid reply template')
    const values = { title: input.title.trim(), text: input.text.trim(), updatedAt: new Date() }
    const [template] = input.id
      ? await tx
          .update(replyTemplate)
          .set(values)
          .where(
            and(eq(replyTemplate.id, input.id), eq(replyTemplate.workspaceId, input.workspaceId)),
          )
          .returning()
      : await tx
          .insert(replyTemplate)
          .values({ workspaceId: input.workspaceId, ...values })
          .returning()
    if (!template) throw new InboxError('NOT_FOUND', 'Reply template is unavailable')
    return { template }
  })
}

export async function deleteReplyTemplate(db: Database, input: Context & { id: string }) {
  return db.transaction(async (tx) => {
    await assertInboxViewer(tx, input.workspaceId, input.userId)
    const deleted = await tx
      .delete(replyTemplate)
      .where(and(eq(replyTemplate.id, input.id), eq(replyTemplate.workspaceId, input.workspaceId)))
      .returning({ id: replyTemplate.id })
    if (!deleted.length) throw new InboxError('NOT_FOUND', 'Reply template is unavailable')
    return { deleted: true }
  })
}
