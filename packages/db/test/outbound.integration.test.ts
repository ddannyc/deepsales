import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  bootstrapWorkspace,
  channelIdentity,
  claimOutboundMessage,
  completeMessageTranslation,
  completeOutboundMessage,
  completeReplySuggestion,
  connectFacebookPages,
  conversation,
  conversationAssignment,
  createAiMember,
  createDatabase,
  createFacebookHumanReply as createHumanReply,
  createKnowledgeBase,
  createMessageTranslation,
  createReplySuggestion,
  deliveryAttempt,
  facebookMessagingWindow,
  member,
  message,
  processFacebookInbound,
  publishAiMemberConfig,
  recoverStaleOutboundMessages,
  setMemberChannelAccess,
  takeOverConversation,
  updateAiMemberConfig,
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

  it('requires confirmation of the exact translated draft and sends the persisted version once', async () => {
    const f = await createFixture(db)
    await takeOverConversation(db, { ...f, actingUserId: f.ownerId })
    const sourceVersion = randomUUID()
    const translated = await createMessageTranslation(db, {
      ...f,
      userId: f.ownerId,
      id: randomUUID(),
      sourceText: '你好',
      sourceVersion,
      targetLanguage: 'en',
    })
    await completeMessageTranslation(db, {
      ...f,
      userId: f.ownerId,
      id: translated.id,
      text: 'Hello',
    })
    const reply = {
      ...f,
      actingUserId: f.ownerId,
      text: 'Hello',
      clientKey: translated.id,
      translation: { id: translated.id, sourceText: '你好', sourceVersion, targetLanguage: 'en' },
    }
    await expect(
      createHumanReply(db, { ...reply, translation: { ...reply.translation, sourceText: '再见' } }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    const first = await createHumanReply(db, reply)
    expect(first.message.text).toBe('Hello')
    expect((await createHumanReply(db, reply)).message.id).toBe(first.message.id)
  })

  it('keeps translation inputs and results immutable under concurrent completions', async () => {
    const f = await createFixture(db)
    await takeOverConversation(db, { ...f, actingUserId: f.ownerId })
    const input = {
      ...f,
      userId: f.ownerId,
      id: randomUUID(),
      sourceText: '你好',
      sourceVersion: randomUUID(),
      targetLanguage: 'en',
    }
    const record = await createMessageTranslation(db, input)
    await expect(
      createMessageTranslation(db, { ...input, sourceText: '再见' }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    const results = await Promise.allSettled([
      completeMessageTranslation(db, { ...input, id: record.id, text: 'Hello' }),
      completeMessageTranslation(db, { ...input, id: record.id, text: 'Goodbye' }),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
  })

  it('keeps AI suggestions internal and rejects confirmation after a newer customer input', async () => {
    const f = await createFixture(db)
    await takeOverConversation(db, { ...f, actingUserId: f.ownerId })
    const base = await createKnowledgeBase(db, {
      workspaceId: f.workspaceId,
      createdByUserId: f.ownerId,
      name: 'Facts',
    })
    const ai = await createAiMember(db, {
      workspaceId: f.workspaceId,
      createdByUserId: f.ownerId,
      displayName: 'Assistant',
    })
    await updateAiMemberConfig(db, {
      workspaceId: f.workspaceId,
      memberId: ai.id,
      actingUserId: f.ownerId,
      instructions: 'Answer from facts.',
      responseLanguage: 'English',
      knowledgeBaseId: base.id,
    })
    const [identity] = await db
      .select()
      .from(channelIdentity)
      .where(eq(channelIdentity.id, f.channelIdentityId))
    await setMemberChannelAccess(db, {
      workspaceId: f.workspaceId,
      actingUserId: f.ownerId,
      memberId: ai.id,
      channelIds: [identity.channelId],
    })
    await publishAiMemberConfig(db, {
      providerConfigured: true,
      workspaceId: f.workspaceId,
      memberId: ai.id,
      actingUserId: f.ownerId,
    })
    const input = { ...f, userId: f.ownerId, id: randomUUID(), aiMemberId: ai.id }
    const suggestion = await createReplySuggestion(db, input)
    await completeReplySuggestion(db, { ...input, text: 'Hello, how can I help?', chunkIds: [] })
    expect(
      await db
        .select()
        .from(message)
        .where(
          and(eq(message.conversationId, f.conversationId), eq(message.direction, 'OUTBOUND')),
        ),
    ).toEqual([])
    const reply = {
      ...f,
      actingUserId: f.ownerId,
      text: 'Hello, how may I help?',
      clientKey: suggestion.id,
      suggestionId: suggestion.id,
    }
    expect((await createHumanReply(db, reply)).message.text).toBe(reply.text)
    expect((await createHumanReply(db, reply)).message.id).toBe(
      (await createHumanReply(db, reply)).message.id,
    )
    const second = await createReplySuggestion(db, { ...input, id: randomUUID() })
    await completeReplySuggestion(db, { ...input, id: second.id, text: 'Hello', chunkIds: [] })
    await db.insert(message).values({
      conversationId: f.conversationId,
      channelId: identity.channelId,
      direction: 'INBOUND',
      senderType: 'CUSTOMER',
      text: 'A new question',
    })
    await expect(
      createHumanReply(db, { ...reply, suggestionId: second.id, clientKey: second.id }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })

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
