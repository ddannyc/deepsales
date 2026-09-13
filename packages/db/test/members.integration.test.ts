import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { eq } from 'drizzle-orm'
import { Pool } from 'pg'
import {
  acceptInvitation,
  bootstrapWorkspace,
  channel,
  createDatabase,
  createAiMember,
  createInvitation,
  humanMemberAvailability,
  member,
  memberChannelAccess,
  setMemberChannelAccess,
  user,
  updateMember,
  workspace,
  workspaceInvitation,
  workspaceUserAccess,
} from '../src'

const connectionString = process.env.DATABASE_URL

describe.skipIf(!connectionString)('member onboarding', () => {
  const pool = new Pool({ connectionString })
  const db = createDatabase(pool)

  beforeAll(async () => {
    await migrate(db, { migrationsFolder: 'drizzle' })
  })

  afterAll(() => pool.end())

  it('accepts one invitation under concurrent retries and creates one human member', async () => {
    const ownerId = randomUUID()
    const invitedId = randomUUID()
    const email = `${invitedId}@example.com`
    await db.insert(user).values([
      { id: ownerId, name: 'Owner', email: `${ownerId}@example.com` },
      { id: invitedId, name: 'Invited', email },
    ])
    const created = await bootstrapWorkspace(db, {
      userId: ownerId,
      userName: 'Owner',
      name: 'Invitation Race',
    })
    const [assignedChannel] = await db
      .insert(channel)
      .values({
        workspaceId: created.id,
        provider: 'FACEBOOK_MESSENGER',
        displayName: 'Inbox',
      })
      .returning({ id: channel.id })
    if (!assignedChannel) throw new Error('Assigned channel was not created')
    const invitation = await createInvitation(db, {
      workspaceId: created.id,
      createdByUserId: ownerId,
      email,
      role: 'AGENT',
      displayName: 'Invited teammate',
      available: false,
      autoAssignmentEnabled: false,
      maxActiveConversations: 4,
      channelIds: [assignedChannel.id],
    })

    const results = await Promise.allSettled([
      acceptInvitation(db, {
        token: invitation.token,
        userId: invitedId,
        userEmail: email,
        userName: 'Invited',
      }),
      acceptInvitation(db, {
        token: invitation.token,
        userId: invitedId,
        userEmail: email,
        userName: 'Invited',
      }),
    ])

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const accepted = results.find(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof acceptInvitation>>> =>
        result.status === 'fulfilled',
    )
    expect(accepted?.value.memberId).toBeDefined()
    const accesses = await pool.query(
      'select count(*)::text as count from workspace_user_access where workspace_id = $1 and user_id = $2',
      [created.id, invitedId],
    )
    const members = await pool.query(
      `select count(*)::text as count
       from member m
       join workspace_user_access a on a.id = m.workspace_user_access_id
       where a.workspace_id = $1 and a.user_id = $2`,
      [created.id, invitedId],
    )
    const availabilityCount = await pool.query(
      `select count(*)::text as count
       from human_member_availability h
       join member m on m.id = h.member_id
       join workspace_user_access a on a.id = m.workspace_user_access_id
       where a.workspace_id = $1 and a.user_id = $2`,
      [created.id, invitedId],
    )
    expect(accesses.rows[0]).toEqual({ count: '1' })
    expect(members.rows[0]).toEqual({ count: '1' })
    expect(availabilityCount.rows[0]).toEqual({ count: '1' })

    const stored = await db
      .select()
      .from(workspaceInvitation)
      .where(eq(workspaceInvitation.workspaceId, created.id))
    expect(stored).toHaveLength(1)
    expect(stored[0]?.tokenHash).not.toBe(invitation.token)
    expect(stored[0]?.acceptedAt).not.toBeNull()
    expect(await db.select().from(member).where(eq(member.workspaceId, created.id))).toHaveLength(2)
    expect(
      await db
        .select()
        .from(humanMemberAvailability)
        .where(eq(humanMemberAvailability.memberId, accepted?.value.memberId ?? '')),
    ).toHaveLength(1)
    expect(
      await db
        .select()
        .from(memberChannelAccess)
        .where(eq(memberChannelAccess.memberId, accepted?.value.memberId ?? '')),
    ).toEqual([{ memberId: accepted?.value.memberId, channelId: assignedChannel.id }])
    const [acceptedMember] = await db
      .select()
      .from(member)
      .where(eq(member.id, accepted?.value.memberId ?? ''))
    expect(acceptedMember).toEqual(
      expect.objectContaining({
        autoAssignmentEnabled: false,
        maxActiveConversations: 4,
      }),
    )
    const [acceptedAvailability] = await db
      .select()
      .from(humanMemberAvailability)
      .where(eq(humanMemberAvailability.memberId, accepted?.value.memberId ?? ''))
    expect(acceptedAvailability?.available).toBe(false)
  })

  it('rejects agent mutations and cross-workspace channel access', async () => {
    const ownerId = randomUUID()
    const agentId = randomUUID()
    const ownerEmail = `${ownerId}@example.com`
    const agentEmail = `${agentId}@example.com`
    await db.insert(user).values([
      { id: ownerId, name: 'Owner', email: ownerEmail },
      { id: agentId, name: 'Agent', email: agentEmail },
    ])
    const workspaceA = await bootstrapWorkspace(db, {
      userId: ownerId,
      userName: 'Owner',
      name: 'Workspace A',
    })
    const [workspaceB] = await db
      .insert(workspace)
      .values({ name: 'Workspace B' })
      .returning({ id: workspace.id })
    if (!workspaceB) throw new Error('Workspace B was not created')
    const [foreignChannel] = await db
      .insert(channel)
      .values({
        workspaceId: workspaceB.id,
        provider: 'FACEBOOK_MESSENGER',
        displayName: 'Foreign channel',
      })
      .returning({ id: channel.id })
    if (!foreignChannel) throw new Error('Foreign channel was not created')
    const invitation = await createInvitation(db, {
      workspaceId: workspaceA.id,
      createdByUserId: ownerId,
      email: agentEmail,
      role: 'AGENT',
    })
    await acceptInvitation(db, {
      token: invitation.token,
      userId: agentId,
      userEmail: agentEmail,
      userName: 'Agent',
    })
    const ai = await createAiMember(db, {
      workspaceId: workspaceA.id,
      createdByUserId: ownerId,
      displayName: 'Bot',
    })

    await expect(
      createAiMember(db, {
        workspaceId: workspaceA.id,
        createdByUserId: agentId,
        displayName: 'Not allowed',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(
      setMemberChannelAccess(db, {
        workspaceId: workspaceA.id,
        memberId: ai.id,
        actingUserId: ownerId,
        channelIds: [foreignChannel.id],
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(
      await db.select().from(memberChannelAccess).where(eq(memberChannelAccess.memberId, ai.id)),
    ).toHaveLength(0)

    const [ownerAccess] = await db
      .select({ memberId: member.id })
      .from(member)
      .innerJoin(workspaceUserAccess, eq(workspaceUserAccess.id, member.workspaceUserAccessId))
      .where(eq(workspaceUserAccess.userId, ownerId))
    if (!ownerAccess) throw new Error('Owner member was not found')
    await expect(
      updateMember(db, {
        workspaceId: workspaceA.id,
        memberId: ownerAccess.memberId,
        actingUserId: ownerId,
        status: 'DISABLED',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})
