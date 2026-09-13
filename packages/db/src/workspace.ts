import { eq, sql } from 'drizzle-orm'
import type { Database } from './database'
import { humanMemberAvailability, member, workspace, workspaceUserAccess } from './schema'

type BootstrapWorkspaceInput = {
  userId: string
  userName: string
  name: string
}

export async function bootstrapWorkspace(db: Database, input: BootstrapWorkspaceInput) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${input.userId}, 0))`)

    const [existing] = await tx
      .select({ id: workspace.id, name: workspace.name })
      .from(workspaceUserAccess)
      .innerJoin(workspace, eq(workspace.id, workspaceUserAccess.workspaceId))
      .where(eq(workspaceUserAccess.userId, input.userId))
      .limit(1)
    if (existing) return existing

    const [created] = await tx
      .insert(workspace)
      .values({ name: input.name })
      .returning({ id: workspace.id, name: workspace.name })
    const [access] = await tx
      .insert(workspaceUserAccess)
      .values({ workspaceId: created.id, userId: input.userId, role: 'OWNER' })
      .returning({ id: workspaceUserAccess.id })
    const [human] = await tx
      .insert(member)
      .values({
        workspaceId: created.id,
        type: 'HUMAN',
        workspaceUserAccessId: access.id,
        displayName: input.userName,
      })
      .returning({ id: member.id })
    await tx.insert(humanMemberAvailability).values({ memberId: human.id })

    return created
  })
}
