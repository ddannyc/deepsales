import { eq, sql } from 'drizzle-orm'
import type { Database } from './database'
import { MemberError } from './members'
import {
  humanMemberAvailability,
  member,
  registrationInvitation,
  workspace,
  workspaceUserAccess,
} from './schema'

type BootstrapWorkspaceInput = {
  userId: string
  userName: string
  name: string
}

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0]

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

    return createWorkspace(tx, input)
  })
}

export async function createWorkspaceFromRegistrationInvite(
  db: Database,
  input: BootstrapWorkspaceInput,
) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${input.userId}, 0))`)
    const [invitation] = await tx
      .select()
      .from(registrationInvitation)
      .where(eq(registrationInvitation.acceptedByUserId, input.userId))
      .limit(1)
      .for('update')

    if (!invitation) {
      throw new MemberError('WORKSPACE_SETUP_REQUIRED', 'A registration invitation is required')
    }
    if (invitation.workspaceCreatedAt) {
      throw new MemberError('WORKSPACE_ALREADY_EXISTS', 'A workspace was already created')
    }

    const [existing] = await tx
      .select({ id: workspaceUserAccess.id })
      .from(workspaceUserAccess)
      .where(eq(workspaceUserAccess.userId, input.userId))
      .limit(1)
    if (existing) {
      throw new MemberError('WORKSPACE_ALREADY_EXISTS', 'User already belongs to a workspace')
    }

    const created = await createWorkspace(tx, input)
    const now = new Date()
    await tx
      .update(registrationInvitation)
      .set({ workspaceCreatedAt: now, updatedAt: now })
      .where(eq(registrationInvitation.id, invitation.id))
    return created
  })
}

async function createWorkspace(tx: Transaction, input: BootstrapWorkspaceInput) {
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
}
