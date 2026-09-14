import { randomUUID } from 'node:crypto'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import {
  bootstrapWorkspace,
  connectFacebookPages,
  conversation,
  conversationAssignment,
  createAiMember,
  createDatabase,
  createFacebookHumanReply as createHumanReply,
  claimOutboundMessage,
  completeOutboundMessage,
  channelIdentity,
  deliveryAttempt,
  facebookMessagingWindow,
  member,
  message,
  processFacebookInbound,
  recoverStaleOutboundMessages,
  setMemberChannelAccess,
  takeOverConversation,
  user,
} from '../src'

const connectionString = process.env.DATABASE_URL

describe.skipIf(!connectionString)('human reply delivery', () => {
  const pool = new Pool({ connectionString })
  const db = createDatabase(pool)

  beforeAll(async () => {
    await migrate(db, { migrationsFolder: 'drizzle' })
  })

  afterAll(() => pool.end())

  it('lets the current active human take over an unassigned conversation once', async () => {
    const ownerId = randomUUID()
    const pageId = randomUUID()
    await db.insert(user).values({ id: ownerId, name: 'Owner', email: `${ownerId}@example.com` })
    const workspace = await bootstrapWorkspace(db, {
      userId: ownerId,
      userName: 'Owner',
      name: 'Takeover test',
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

    const received = await processFacebookInbound(db, {
      ingressId: randomUUID(),
      pageId,
      externalUserId: 'customer-1',
      externalMessageId: 'mid-takeover',
      text: 'hello',
      providerSentAt: new Date(),
      receivedAt: new Date(),
      payloadSha256: 'a'.repeat(64),
      eventFragment: { messageId: 'mid-takeover' },
    })
    if (received.kind !== 'created') throw new Error('Inbound message was not created')

    const takeovers = await Promise.all([
      takeOverConversation(db, {
        workspaceId: workspace.id,
        conversationId: received.conversationId,
        actingUserId: ownerId,
      }),
      takeOverConversation(db, {
        workspaceId: workspace.id,
        conversationId: received.conversationId,
        actingUserId: ownerId,
      }),
    ])
    expect(takeovers.filter(({ changed }) => changed)).toHaveLength(1)
    expect(takeovers.filter(({ changed }) => !changed)).toHaveLength(1)
    expect(takeovers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ toMemberId: owner.id, changed: true }),
        expect.objectContaining({ toMemberId: owner.id, changed: false }),
      ]),
    )

    const [owned] = await db
      .select()
      .from(conversation)
      .where(eq(conversation.id, received.conversationId))
    expect(owned).toEqual(
      expect.objectContaining({
        assigneeMemberId: owner.id,
        queueReason: null,
        routingQueuedAt: null,
      }),
    )
    expect(
      await db
        .select()
        .from(conversationAssignment)
        .where(eq(conversationAssignment.conversationId, received.conversationId)),
    ).toHaveLength(1)
    expect(
      await db
        .select()
        .from(message)
        .where(
          and(
            eq(message.conversationId, received.conversationId),
            eq(message.direction, 'INBOUND'),
          ),
        ),
    ).toHaveLength(1)
  })

  it('lets a human take over an AI-owned conversation and records the prior owner', async () => {
    const fixture = await createFixture(db)
    const ai = await createAiMember(db, {
      workspaceId: fixture.workspaceId,
      createdByUserId: fixture.ownerId,
      displayName: 'Support AI',
    })
    await db
      .update(conversation)
      .set({ assigneeMemberId: ai.id, queueReason: null, routingQueuedAt: null })
      .where(eq(conversation.id, fixture.conversationId))

    await expect(
      takeOverConversation(db, {
        workspaceId: fixture.workspaceId,
        conversationId: fixture.conversationId,
        actingUserId: fixture.ownerId,
      }),
    ).resolves.toMatchObject({ fromMemberId: ai.id, toMemberId: fixture.ownerMemberId })

    const [assignment] = await db
      .select()
      .from(conversationAssignment)
      .where(eq(conversationAssignment.conversationId, fixture.conversationId))
    expect(assignment).toEqual(
      expect.objectContaining({ fromMemberId: ai.id, toMemberId: fixture.ownerMemberId }),
    )
  })

  it('commits an authorized text reply as PENDING while the Messenger window is open', async () => {
    const fixture = await createFixture(db)
    await takeOverConversation(db, {
      workspaceId: fixture.workspaceId,
      conversationId: fixture.conversationId,
      actingUserId: fixture.ownerId,
    })

    const created = await createHumanReply(db, {
      workspaceId: fixture.workspaceId,
      conversationId: fixture.conversationId,
      actingUserId: fixture.ownerId,
      text: 'Thanks, we can help.',
    })

    expect(created.message).toEqual(
      expect.objectContaining({
        conversationId: fixture.conversationId,
        direction: 'OUTBOUND',
        senderType: 'MEMBER',
        senderMemberId: fixture.ownerMemberId,
        messageType: 'TEXT',
        text: 'Thanks, we can help.',
        deliveryState: 'PENDING',
      }),
    )
    expect(await db.select().from(message).where(eq(message.id, created.message.id))).toHaveLength(
      1,
    )
  })

  it('rejects a reply from anyone other than the current human assignee', async () => {
    const fixture = await createFixture(db)

    await expect(
      createHumanReply(db, {
        workspaceId: fixture.workspaceId,
        conversationId: fixture.conversationId,
        actingUserId: fixture.ownerId,
        text: 'Not assigned yet',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(
      await db.select().from(message).where(eq(message.conversationId, fixture.conversationId)),
    ).toHaveLength(1)
  })

  it('rejects a reply before creating a message when the Messenger window is closed', async () => {
    const fixture = await createFixture(db)
    await takeOverConversation(db, {
      workspaceId: fixture.workspaceId,
      conversationId: fixture.conversationId,
      actingUserId: fixture.ownerId,
    })
    const now = new Date()
    await db
      .update(facebookMessagingWindow)
      .set({ eligibleUntil: new Date(now.getTime() - 1_000), updatedAt: now })
      .where(eq(facebookMessagingWindow.channelIdentityId, fixture.channelIdentityId))

    await expect(
      createHumanReply(db, {
        workspaceId: fixture.workspaceId,
        conversationId: fixture.conversationId,
        actingUserId: fixture.ownerId,
        text: 'Too late',
        now,
      }),
    ).rejects.toMatchObject({ code: 'REPLY_WINDOW_CLOSED' })
    expect(
      await db.select().from(message).where(eq(message.conversationId, fixture.conversationId)),
    ).toHaveLength(1)
  })

  it('claims an outbound message once and records its successful delivery', async () => {
    const fixture = await createFixture(db)
    await takeOverConversation(db, {
      workspaceId: fixture.workspaceId,
      conversationId: fixture.conversationId,
      actingUserId: fixture.ownerId,
    })
    const created = await createHumanReply(db, {
      workspaceId: fixture.workspaceId,
      conversationId: fixture.conversationId,
      actingUserId: fixture.ownerId,
      text: 'One delivery only',
    })
    const first = await claimOutboundMessage(db, { messageId: created.message.id })
    const duplicate = await claimOutboundMessage(db, { messageId: created.message.id })

    expect(first).toEqual(
      expect.objectContaining({
        id: created.message.id,
        attemptId: expect.any(String),
      }),
    )
    expect(duplicate).toBeNull()
    const sent = await completeOutboundMessage(db, {
      messageId: created.message.id,
      attemptId: first?.attemptId ?? '',
      externalMessageId: 'meta-outbound-1',
    })

    expect(sent).toEqual(
      expect.objectContaining({ deliveryState: 'SENT', externalMessageId: 'meta-outbound-1' }),
    )
    expect(
      await db
        .select()
        .from(deliveryAttempt)
        .where(eq(deliveryAttempt.messageId, created.message.id)),
    ).toHaveLength(1)
  })

  it('keeps a committed reply deliverable after ownership changes', async () => {
    const fixture = await createFixture(db)
    await takeOverConversation(db, {
      workspaceId: fixture.workspaceId,
      conversationId: fixture.conversationId,
      actingUserId: fixture.ownerId,
    })
    const created = await createHumanReply(db, {
      workspaceId: fixture.workspaceId,
      conversationId: fixture.conversationId,
      actingUserId: fixture.ownerId,
      text: 'Ownership can change after commit',
    })

    await db
      .update(conversation)
      .set({
        assigneeMemberId: null,
        queueReason: 'MANUAL_UNASSIGN',
        routingQueuedAt: new Date(),
      })
      .where(eq(conversation.id, fixture.conversationId))

    const claimed = await claimOutboundMessage(db, { messageId: created.message.id })
    const sent = await completeOutboundMessage(db, {
      messageId: created.message.id,
      attemptId: claimed?.attemptId ?? '',
      externalMessageId: 'meta-independent-1',
    })
    expect(sent).toEqual(
      expect.objectContaining({ deliveryState: 'SENT', externalMessageId: 'meta-independent-1' }),
    )
  })

  it('fails an abandoned claim instead of allowing a resend', async () => {
    const fixture = await createFixture(db)
    await takeOverConversation(db, {
      workspaceId: fixture.workspaceId,
      conversationId: fixture.conversationId,
      actingUserId: fixture.ownerId,
    })
    const created = await createHumanReply(db, {
      workspaceId: fixture.workspaceId,
      conversationId: fixture.conversationId,
      actingUserId: fixture.ownerId,
      text: 'Abandoned delivery',
    })
    const claimedAt = new Date('2026-09-14T00:00:00.000Z')
    await expect(
      claimOutboundMessage(db, { messageId: created.message.id, now: claimedAt }),
    ).resolves.toBeTruthy()
    await expect(
      recoverStaleOutboundMessages(db, {
        now: new Date(claimedAt.getTime() + 5 * 60 * 1_000),
      }),
    ).resolves.toEqual([{ id: created.message.id, workspaceId: fixture.workspaceId }])

    const [failed] = await db.select().from(message).where(eq(message.id, created.message.id))
    expect(failed).toEqual(
      expect.objectContaining({ deliveryState: 'FAILED', failureCode: 'AMBIGUOUS_DELIVERY' }),
    )
  })
})

async function createFixture(db: ReturnType<typeof createDatabase>) {
  const ownerId = randomUUID()
  const pageId = randomUUID()
  await db.insert(user).values({ id: ownerId, name: 'Owner', email: `${ownerId}@example.com` })
  const createdWorkspace = await bootstrapWorkspace(db, {
    userId: ownerId,
    userName: 'Owner',
    name: 'Reply test',
  })
  const [connected] = await connectFacebookPages(db, {
    workspaceId: createdWorkspace.id,
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
  const [owner] = await db.select().from(member).where(eq(member.workspaceId, createdWorkspace.id))
  if (!owner) throw new Error('Owner member was not created')
  await setMemberChannelAccess(db, {
    workspaceId: createdWorkspace.id,
    memberId: owner.id,
    actingUserId: ownerId,
    channelIds: [connected.id],
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
    workspaceId: createdWorkspace.id,
    conversationId: received.conversationId,
    channelIdentityId: identity.id,
  }
}
