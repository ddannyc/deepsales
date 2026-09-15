import { randomUUID } from 'node:crypto'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import {
  autoAssignConversation,
  bootstrapWorkspace,
  connectFacebookPages,
  createHumanReply,
  conversation,
  conversationAssignment,
  createAiMember,
  createDatabase,
  createKnowledgeBase,
  aiResponseRun,
  member,
  processFacebookInbound,
  publishAiMemberConfig,
  setMemberChannelAccess,
  transferConversation,
  updateAiMemberConfig,
  updateMember,
  user,
} from '../src'

const connectionString = process.env.DATABASE_URL

describe.skipIf(!connectionString)('conversation auto-assignment', () => {
  const pool = new Pool({ connectionString })
  const db = createDatabase(pool)

  beforeAll(async () => {
    await migrate(db, { migrationsFolder: 'drizzle' })
  })

  afterAll(() => pool.end())

  it('assigns AI first and creates one queued run under concurrent routing', async () => {
    const fixture = await createFixture(db)
    const received = await receive(db, fixture)

    const results = await Promise.all([
      autoAssignConversation(db, {
        workspaceId: fixture.workspaceId,
        conversationId: received.conversationId,
      }),
      autoAssignConversation(db, {
        workspaceId: fixture.workspaceId,
        conversationId: received.conversationId,
      }),
    ])

    expect(results.filter(({ changed }) => changed)).toHaveLength(1)
    expect(results.find(({ changed }) => changed)?.toMemberId).toBe(fixture.aiMemberId)
    expect(
      await db
        .select({ reason: conversationAssignment.reason })
        .from(conversationAssignment)
        .where(eq(conversationAssignment.conversationId, received.conversationId)),
    ).toEqual([{ reason: 'AUTO_ROUTE' }])
    const runs = await db
      .select()
      .from(aiResponseRun)
      .where(eq(aiResponseRun.conversationId, received.conversationId))
    expect(runs).toHaveLength(1)
    expect(runs[0]).toEqual(
      expect.objectContaining({
        memberId: fixture.aiMemberId,
        state: 'QUEUED',
        inputFirstMessageId: received.messageId,
        inputLastMessageId: received.messageId,
      }),
    )

    const later = await receive(db, fixture, 'follow-up')
    expect(later.aiResponseRunId).toBe(runs[0]?.id)
    const [updatedRun] = await db
      .select()
      .from(aiResponseRun)
      .where(eq(aiResponseRun.conversationId, received.conversationId))
    expect(updatedRun).toEqual(
      expect.objectContaining({
        inputFirstMessageId: received.messageId,
        inputLastMessageId: later.messageId,
      }),
    )
  })

  it('uses a human for HUMAN_ONLY and allows an authorized human-to-AI transfer', async () => {
    const fixture = await createFixture(db)
    const received = await receive(db, fixture)
    await db
      .update(conversation)
      .set({ routingConstraint: 'HUMAN_ONLY' })
      .where(eq(conversation.id, received.conversationId))
    const assigned = await autoAssignConversation(db, {
      workspaceId: fixture.workspaceId,
      conversationId: received.conversationId,
    })
    expect(assigned.toMemberId).toBe(fixture.ownerMemberId)

    await expect(
      transferConversation(db, {
        workspaceId: fixture.workspaceId,
        conversationId: received.conversationId,
        actingUserId: fixture.ownerId,
        targetMemberId: fixture.aiMemberId,
      }),
    ).resolves.toMatchObject({
      changed: true,
      toMemberId: fixture.aiMemberId,
      aiResponseRunId: expect.any(String),
    })

    const [stored] = await db
      .select({
        assigneeMemberId: conversation.assigneeMemberId,
        routingConstraint: conversation.routingConstraint,
      })
      .from(conversation)
      .where(eq(conversation.id, received.conversationId))
    expect(stored).toEqual({
      assigneeMemberId: fixture.aiMemberId,
      routingConstraint: 'ANY_MEMBER',
    })
    expect(
      await db
        .select()
        .from(aiResponseRun)
        .where(
          and(
            eq(aiResponseRun.conversationId, received.conversationId),
            eq(aiResponseRun.memberId, fixture.aiMemberId),
          ),
        ),
    ).toHaveLength(1)
  })

  it('does not create an AI run when the customer input is already answered', async () => {
    const fixture = await createFixture(db)
    await updateMember(db, {
      workspaceId: fixture.workspaceId,
      memberId: fixture.aiMemberId,
      actingUserId: fixture.ownerId,
      autoAssignmentEnabled: false,
    })
    const received = await receive(db, fixture)
    await autoAssignConversation(db, {
      workspaceId: fixture.workspaceId,
      conversationId: received.conversationId,
    })
    await createHumanReply(
      db,
      {
        workspaceId: fixture.workspaceId,
        conversationId: received.conversationId,
        actingUserId: fixture.ownerId,
        text: 'answered',
      },
      async () => true,
    )

    const transfer = await transferConversation(db, {
      workspaceId: fixture.workspaceId,
      conversationId: received.conversationId,
      actingUserId: fixture.ownerId,
      targetMemberId: fixture.aiMemberId,
    })
    expect(transfer.aiResponseRunId).toBeNull()
    expect(
      await db
        .select()
        .from(aiResponseRun)
        .where(eq(aiResponseRun.conversationId, received.conversationId)),
    ).toHaveLength(0)
  })

  it('retries a queued conversation after capacity, availability, access, and auto-routing changes', async () => {
    const fixture = await createFixture(db)
    await updateMember(db, {
      workspaceId: fixture.workspaceId,
      memberId: fixture.aiMemberId,
      actingUserId: fixture.ownerId,
      autoAssignmentEnabled: false,
      maxActiveConversations: 0,
    })
    await setMemberChannelAccess(db, {
      workspaceId: fixture.workspaceId,
      memberId: fixture.aiMemberId,
      actingUserId: fixture.ownerId,
      channelIds: [],
    })
    await updateMember(db, {
      workspaceId: fixture.workspaceId,
      memberId: fixture.ownerMemberId,
      actingUserId: fixture.ownerId,
      available: false,
      maxActiveConversations: 0,
    })

    const received = await receive(db, fixture, 'queued')
    await expect(
      autoAssignConversation(db, {
        workspaceId: fixture.workspaceId,
        conversationId: received.conversationId,
      }),
    ).resolves.toMatchObject({ changed: false, toMemberId: null })

    await updateMember(db, {
      workspaceId: fixture.workspaceId,
      memberId: fixture.ownerMemberId,
      actingUserId: fixture.ownerId,
      available: true,
    })
    await expect(
      autoAssignConversation(db, {
        workspaceId: fixture.workspaceId,
        conversationId: received.conversationId,
      }),
    ).resolves.toMatchObject({ changed: false, toMemberId: null })

    await updateMember(db, {
      workspaceId: fixture.workspaceId,
      memberId: fixture.ownerMemberId,
      actingUserId: fixture.ownerId,
      maxActiveConversations: 1,
    })
    await updateMember(db, {
      workspaceId: fixture.workspaceId,
      memberId: fixture.aiMemberId,
      actingUserId: fixture.ownerId,
      autoAssignmentEnabled: true,
      maxActiveConversations: 1,
    })
    await setMemberChannelAccess(db, {
      workspaceId: fixture.workspaceId,
      memberId: fixture.aiMemberId,
      actingUserId: fixture.ownerId,
      channelIds: [fixture.channelId],
    })
    await expect(
      autoAssignConversation(db, {
        workspaceId: fixture.workspaceId,
        conversationId: received.conversationId,
      }),
    ).resolves.toMatchObject({ changed: true, toMemberId: fixture.aiMemberId })
  })

  it('does not exceed an AI member capacity under concurrent routing', async () => {
    const fixture = await createFixture(db)
    await updateMember(db, {
      workspaceId: fixture.workspaceId,
      memberId: fixture.ownerMemberId,
      actingUserId: fixture.ownerId,
      autoAssignmentEnabled: false,
    })
    await updateMember(db, {
      workspaceId: fixture.workspaceId,
      memberId: fixture.aiMemberId,
      actingUserId: fixture.ownerId,
      maxActiveConversations: 1,
    })
    const first = await receive(db, fixture, 'first', `customer-first-${fixture.ownerId}`)
    const second = await receive(db, fixture, 'second', `customer-second-${fixture.ownerId}`)
    const results = await Promise.all(
      [first, second].map(({ conversationId }) =>
        autoAssignConversation(db, { workspaceId: fixture.workspaceId, conversationId }),
      ),
    )

    expect(results.filter(({ changed }) => changed)).toHaveLength(1)
    expect(results.find(({ changed }) => changed)?.toMemberId).toBe(fixture.aiMemberId)
    expect(results.filter(({ toMemberId }) => toMemberId === null)).toHaveLength(1)
  })
})

async function createFixture(db: ReturnType<typeof createDatabase>) {
  const ownerId = randomUUID()
  const pageId = randomUUID()
  await db.insert(user).values({ id: ownerId, name: 'Owner', email: `${ownerId}@example.com` })
  const workspace = await bootstrapWorkspace(db, {
    userId: ownerId,
    userName: 'Owner',
    name: 'Routing test',
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
  if (!connected) throw new Error('Channel was not created')
  const [owner] = await db.select().from(member).where(eq(member.workspaceId, workspace.id))
  if (!owner) throw new Error('Owner was not created')
  await setMemberChannelAccess(db, {
    workspaceId: workspace.id,
    memberId: owner.id,
    actingUserId: ownerId,
    channelIds: [connected.id],
  })
  const knowledgeBase = await createKnowledgeBase(db, {
    workspaceId: workspace.id,
    createdByUserId: ownerId,
    name: 'Support facts',
  })
  const ai = await createAiMember(db, {
    workspaceId: workspace.id,
    createdByUserId: ownerId,
    displayName: 'Support AI',
    channelIds: [connected.id],
  })
  await updateAiMemberConfig(db, {
    workspaceId: workspace.id,
    memberId: ai.id,
    actingUserId: ownerId,
    instructions: 'Answer support questions.',
    responseLanguage: 'English',
    knowledgeBaseId: knowledgeBase.id,
  })
  await publishAiMemberConfig(db, {
    workspaceId: workspace.id,
    memberId: ai.id,
    actingUserId: ownerId,
    providerConfigured: true,
  })
  return {
    ownerId,
    ownerMemberId: owner.id,
    aiMemberId: ai.id,
    workspaceId: workspace.id,
    pageId,
    channelId: connected.id,
  }
}

async function receive(
  db: ReturnType<typeof createDatabase>,
  fixture: Awaited<ReturnType<typeof createFixture>>,
  text = 'hello',
  externalUserId = `customer-${fixture.ownerId}`,
) {
  const now = new Date()
  const received = await processFacebookInbound(db, {
    ingressId: randomUUID(),
    pageId: fixture.pageId,
    externalUserId,
    externalMessageId: randomUUID(),
    text,
    providerSentAt: now,
    receivedAt: now,
    payloadSha256: 'a'.repeat(64),
    eventFragment: { message: 'hello' },
  })
  if (received.kind !== 'created') throw new Error('Inbound message was not created')
  return received
}
