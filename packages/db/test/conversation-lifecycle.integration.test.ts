import { randomUUID } from 'node:crypto'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import {
  acceptInvitation,
  bootstrapWorkspace,
  channelIdentity,
  connectFacebookPages,
  conversation,
  conversationAssignment,
  createDatabase,
  createInvitation,
  member,
  processFacebookInbound,
  setMemberChannelAccess,
  takeOverConversation,
  transferConversation,
  unassignConversation,
  updateMember,
  closeConversation,
  user,
} from '../src'

const connectionString = process.env.DATABASE_URL

describe.skipIf(!connectionString)('conversation lifecycle', () => {
  const pool = new Pool({ connectionString })
  const db = createDatabase(pool)

  beforeAll(async () => {
    await migrate(db, { migrationsFolder: 'drizzle' })
  })

  afterAll(() => pool.end())

  it('transfers between humans only after confirmation and preserves HUMAN_ONLY', async () => {
    const fixture = await createFixture(db, { teammateAvailable: false, teammateCapacity: 0 })
    await takeOverConversation(db, {
      workspaceId: fixture.workspaceId,
      conversationId: fixture.conversationId,
      actingUserId: fixture.ownerId,
    })
    await db
      .update(conversation)
      .set({ routingConstraint: 'HUMAN_ONLY' })
      .where(eq(conversation.id, fixture.conversationId))

    await expect(
      transferConversation(db, {
        workspaceId: fixture.workspaceId,
        conversationId: fixture.conversationId,
        actingUserId: fixture.ownerId,
        targetMemberId: fixture.teammateMemberId,
      }),
    ).rejects.toMatchObject({ code: 'TRANSFER_CONFIRMATION_REQUIRED' })

    await expect(
      transferConversation(db, {
        workspaceId: fixture.workspaceId,
        conversationId: fixture.conversationId,
        actingUserId: fixture.ownerId,
        targetMemberId: fixture.teammateMemberId,
        confirmOverride: true,
      }),
    ).resolves.toMatchObject({
      fromMemberId: fixture.ownerMemberId,
      toMemberId: fixture.teammateMemberId,
      changed: true,
    })

    const [stored] = await db
      .select()
      .from(conversation)
      .where(eq(conversation.id, fixture.conversationId))
    expect(stored).toEqual(
      expect.objectContaining({
        assigneeMemberId: fixture.teammateMemberId,
        routingConstraint: 'HUMAN_ONLY',
        queueReason: null,
      }),
    )
    expect(
      await db
        .select({ reason: conversationAssignment.reason })
        .from(conversationAssignment)
        .where(eq(conversationAssignment.conversationId, fixture.conversationId)),
    ).toEqual(expect.arrayContaining([{ reason: 'TAKEOVER' }, { reason: 'MANUAL_TRANSFER' }]))
  })

  it('unassigns and disabling the owner requeues through assignment history', async () => {
    const fixture = await createFixture(db)
    await takeOverConversation(db, {
      workspaceId: fixture.workspaceId,
      conversationId: fixture.conversationId,
      actingUserId: fixture.ownerId,
    })

    await unassignConversation(db, {
      workspaceId: fixture.workspaceId,
      conversationId: fixture.conversationId,
      actingUserId: fixture.ownerId,
    })
    const [unassigned] = await db
      .select()
      .from(conversation)
      .where(eq(conversation.id, fixture.conversationId))
    expect(unassigned).toEqual(
      expect.objectContaining({
        assigneeMemberId: null,
        queueReason: 'MANUAL_UNASSIGN',
        routingQueuedAt: expect.any(Date),
      }),
    )

    await takeOverConversation(db, {
      workspaceId: fixture.workspaceId,
      conversationId: fixture.conversationId,
      actingUserId: fixture.ownerId,
    })
    await transferConversation(db, {
      workspaceId: fixture.workspaceId,
      conversationId: fixture.conversationId,
      actingUserId: fixture.ownerId,
      targetMemberId: fixture.teammateMemberId,
    })
    const disabled = await updateMember(db, {
      workspaceId: fixture.workspaceId,
      memberId: fixture.teammateMemberId,
      actingUserId: fixture.ownerId,
      status: 'DISABLED',
    })
    expect(disabled.requeuedConversationIds).toContain(fixture.conversationId)

    const [requeued] = await db
      .select()
      .from(conversation)
      .where(eq(conversation.id, fixture.conversationId))
    expect(requeued).toEqual(
      expect.objectContaining({
        assigneeMemberId: null,
        queueReason: 'MEMBER_DISABLED',
      }),
    )
    expect(
      await db
        .select({ reason: conversationAssignment.reason })
        .from(conversationAssignment)
        .where(eq(conversationAssignment.conversationId, fixture.conversationId)),
    ).toEqual(
      expect.arrayContaining([
        { reason: 'MANUAL_UNASSIGN' },
        { reason: 'TAKEOVER' },
        { reason: 'MEMBER_DISABLED' },
      ]),
    )
  })

  it('rejects disabled and channel-inaccessible human transfer targets', async () => {
    const fixture = await createFixture(db)
    await takeOverConversation(db, {
      workspaceId: fixture.workspaceId,
      conversationId: fixture.conversationId,
      actingUserId: fixture.ownerId,
    })

    await setMemberChannelAccess(db, {
      workspaceId: fixture.workspaceId,
      memberId: fixture.teammateMemberId,
      actingUserId: fixture.ownerId,
      channelIds: [],
    })
    await expect(
      transferConversation(db, {
        workspaceId: fixture.workspaceId,
        conversationId: fixture.conversationId,
        actingUserId: fixture.ownerId,
        targetMemberId: fixture.teammateMemberId,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_TARGET' })

    await updateMember(db, {
      workspaceId: fixture.workspaceId,
      memberId: fixture.teammateMemberId,
      actingUserId: fixture.ownerId,
      status: 'DISABLED',
    })
    await expect(
      transferConversation(db, {
        workspaceId: fixture.workspaceId,
        conversationId: fixture.conversationId,
        actingUserId: fixture.ownerId,
        targetMemberId: fixture.teammateMemberId,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_TARGET' })
  })

  it('closes before or after inbound without losing closed history', async () => {
    const first = await createFixture(db)
    await takeOverConversation(db, {
      workspaceId: first.workspaceId,
      conversationId: first.conversationId,
      actingUserId: first.ownerId,
    })
    await closeConversation(db, {
      workspaceId: first.workspaceId,
      conversationId: first.conversationId,
      actingUserId: first.ownerId,
    })
    const later = await inbound(db, first, 'after-close')
    expect(later.conversationId).not.toBe(first.conversationId)

    const second = await createFixture(db)
    const same = await inbound(db, second, 'before-close')
    expect(same.conversationId).toBe(second.conversationId)
    await closeConversation(db, {
      workspaceId: second.workspaceId,
      conversationId: second.conversationId,
      actingUserId: second.ownerId,
    })
    expect(
      await db
        .select()
        .from(conversationAssignment)
        .where(eq(conversationAssignment.conversationId, second.conversationId)),
    ).toHaveLength(0)
    expect(
      await db
        .select()
        .from(conversation)
        .where(eq(conversation.channelIdentityId, second.channelIdentityId)),
    ).toHaveLength(1)
    expect(
      await db
        .select({ reason: conversationAssignment.reason })
        .from(conversationAssignment)
        .where(eq(conversationAssignment.conversationId, first.conversationId)),
    ).toEqual(expect.arrayContaining([{ reason: 'CLOSE' }]))
  })
})

async function createFixture(
  db: ReturnType<typeof createDatabase>,
  options: { teammateAvailable?: boolean; teammateCapacity?: number } = {},
) {
  const ownerId = randomUUID()
  const teammateUserId = randomUUID()
  const pageId = randomUUID()
  const email = `${teammateUserId}@example.com`
  await db.insert(user).values([
    { id: ownerId, name: 'Owner', email: `${ownerId}@example.com` },
    { id: teammateUserId, name: 'Teammate', email },
  ])
  const workspace = await bootstrapWorkspace(db, {
    userId: ownerId,
    userName: 'Owner',
    name: 'Lifecycle test',
  })
  const [connected] = await connectFacebookPages(db, {
    workspaceId: workspace.id,
    actingUserId: ownerId,
    pages: [
      {
        pageId,
        displayName: 'Support',
        encryptedPageAccessToken: 'cipher',
        tokenIv: 'iv',
        tokenKeyVersion: 'v1',
      },
    ],
  })
  if (!connected) throw new Error('Facebook channel was not created')
  const [owner] = await db.select().from(member).where(eq(member.workspaceId, workspace.id))
  if (!owner) throw new Error('Owner member was not created')
  await setMemberChannelAccess(db, {
    workspaceId: workspace.id,
    memberId: owner.id,
    actingUserId: ownerId,
    channelIds: [connected.id],
  })
  const invitation = await createInvitation(db, {
    workspaceId: workspace.id,
    createdByUserId: ownerId,
    email,
    role: 'AGENT',
    available: options.teammateAvailable,
    maxActiveConversations: options.teammateCapacity,
    channelIds: [connected.id],
  })
  const accepted = await acceptInvitation(db, {
    token: invitation.token,
    userId: teammateUserId,
    userEmail: email,
    userName: 'Teammate',
  })
  const receivedAt = new Date()
  const received = await processFacebookInbound(db, {
    ingressId: randomUUID(),
    pageId,
    externalUserId: `customer-${ownerId}`,
    externalMessageId: `mid-${ownerId}`,
    text: 'hello',
    providerSentAt: receivedAt,
    receivedAt,
    payloadSha256: 'a'.repeat(64),
    eventFragment: { messageId: `mid-${ownerId}` },
  })
  if (received.kind !== 'created') throw new Error('Inbound message was not created')
  const [identity] = await db
    .select({ id: channelIdentity.id })
    .from(channelIdentity)
    .where(eq(channelIdentity.channelId, connected.id))
  if (!identity) throw new Error('Channel identity was not created')
  return {
    ownerId,
    ownerMemberId: owner.id,
    teammateMemberId: accepted.memberId,
    workspaceId: workspace.id,
    conversationId: received.conversationId,
    channelIdentityId: identity.id,
    pageId,
  }
}

async function inbound(
  db: ReturnType<typeof createDatabase>,
  fixture: Awaited<ReturnType<typeof createFixture>>,
  suffix: string,
) {
  const now = new Date()
  const result = await processFacebookInbound(db, {
    ingressId: randomUUID(),
    pageId: fixture.pageId,
    externalUserId: `customer-${fixture.ownerId}`,
    externalMessageId: `${fixture.conversationId}-${suffix}`,
    text: suffix,
    providerSentAt: now,
    receivedAt: now,
    payloadSha256: 'b'.repeat(64),
    eventFragment: { suffix },
  })
  if (result.kind !== 'created') throw new Error('Inbound message was not created')
  return result
}
