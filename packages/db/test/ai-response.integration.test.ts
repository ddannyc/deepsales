import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  aiResponseRun,
  autoAssignConversation,
  bootstrapWorkspace,
  claimAiResponseRun,
  claimOutboundMessage,
  completeOutboundMessage,
  failOutboundMessage,
  aiOperationForMessage,
  commitAiResponse,
  getAiDiagnostics,
  getAiAnalytics,
  connectFacebookPages,
  createAiMember,
  createDatabase,
  createKnowledgeBase,
  listConversations,
  message,
  mediaAsset,
  messageAttachment,
  knowledgeDocument,
  knowledgeChunk,
  recordAiResponseRetrievedChunks,
  processFacebookInbound,
  publishAiMemberConfig,
  retryAiResponseRun,
  recoverStaleAiResponseRuns,
  takeOverConversation,
  handoffAiConversation,
  transferConversation,
  updateAiMemberConfig,
  user,
  channel,
  conversation,
  channelIdentity,
  customerPropertyDefinition,
  customerPropertyValue,
  customerTagDefinition,
  customerTag,
} from '../src'

const connectionString = process.env.DATABASE_URL

describe.skipIf(!connectionString)('AI response runs', () => {
  const pool = new Pool({ connectionString })
  const db = createDatabase(pool)

  beforeAll(async () => {
    await migrate(db, { migrationsFolder: 'drizzle' })
  })

  afterAll(() => pool.end())

  it('keeps condition-stopped conversations assigned and stores later input without replying', async () => {
    const f = await createFixture(db)
    await updateAiMemberConfig(db, {
      workspaceId: f.workspaceId,
      memberId: f.aiMemberId,
      actingUserId: f.ownerId,
      stopRules: {
        groups: [[{ kind: 'REPLIES', minimum: 0 }]],
        periods: [],
        endingText: '',
        endingMediaAssetId: null,
      },
    })
    await publishAiMemberConfig(db, {
      workspaceId: f.workspaceId,
      memberId: f.aiMemberId,
      actingUserId: f.ownerId,
      providerConfigured: true,
    })
    const run = await createGeneratingRun(db, f, 'Hello')
    expect(
      await commitAiResponse(db, { runId: run.runId, text: 'Normal reply', stopCheckOnly: true }),
    ).toMatchObject({ kind: 'STOPPED', reason: 'CONDITION' })
    const conversations = await listConversations(db, {
      workspaceId: f.workspaceId,
      userId: f.ownerId,
      view: 'all-open',
    })
    expect(conversations.conversations[0]).toMatchObject({
      assigneeMemberId: f.aiMemberId,
      routingConstraint: 'ANY_MEMBER',
    })
    const later = await receive(db, f, 'Another message', new Date(run.now.getTime() + 5000))
    expect(later.conversationId).toBe(run.conversationId)
    await updateAiMemberConfig(db, {
      workspaceId: f.workspaceId,
      memberId: f.aiMemberId,
      actingUserId: f.ownerId,
      stopRules: { groups: [], periods: [], endingText: '', endingMediaAssetId: null },
    })
    await publishAiMemberConfig(db, {
      workspaceId: f.workspaceId,
      memberId: f.aiMemberId,
      actingUserId: f.ownerId,
      providerConfigured: true,
    })
    await claimAiResponseRun(db, {
      runId: later.aiResponseRunId as string,
      now: new Date(run.now.getTime() + 7000),
    })
    expect(
      await commitAiResponse(db, { runId: later.aiResponseRunId as string, text: 'Not sent' }),
    ).toMatchObject({ kind: 'STOPPED', reason: 'CONDITION' })
    expect(
      await db
        .select()
        .from(message)
        .where(
          and(eq(message.conversationId, run.conversationId), eq(message.direction, 'OUTBOUND')),
        ),
    ).toEqual([])
  })

  it('resumes a schedule stop only on a new input outside the period', async () => {
    const f = await createFixture(db)
    const at = new Date()
    await updateAiMemberConfig(db, {
      workspaceId: f.workspaceId,
      memberId: f.aiMemberId,
      actingUserId: f.ownerId,
      timeZone: 'UTC',
      stopRules: {
        groups: [],
        periods: [{ day: at.getUTCDay(), start: '00:00', end: '24:00' }],
        endingText: '',
        endingMediaAssetId: null,
      },
    })
    await publishAiMemberConfig(db, {
      workspaceId: f.workspaceId,
      memberId: f.aiMemberId,
      actingUserId: f.ownerId,
      providerConfigured: true,
    })
    const run = await createGeneratingRun(db, f, 'Hello')
    expect(
      await commitAiResponse(db, { runId: run.runId, text: 'Not sent', now: at }),
    ).toMatchObject({ kind: 'STOPPED', reason: 'SCHEDULE' })
    const during = await receive(db, f, 'During the stop', new Date(at.getTime() + 5000))
    const nextDay = new Date(at.getTime() + 86400000)
    await claimAiResponseRun(db, { runId: during.aiResponseRunId as string, now: nextDay })
    expect(
      await commitAiResponse(db, {
        runId: during.aiResponseRunId as string,
        text: 'Not sent',
        now: nextDay,
      }),
    ).toMatchObject({ kind: 'STOPPED' })
    const after = await receive(db, f, 'After the period', nextDay)
    await db.update(message).set({ createdAt: nextDay }).where(eq(message.id, after.messageId))
    await claimAiResponseRun(db, {
      runId: after.aiResponseRunId as string,
      now: new Date(nextDay.getTime() + 2000),
    })
    expect(
      await commitAiResponse(db, {
        runId: after.aiResponseRunId as string,
        text: 'Welcome back',
        now: nextDay,
      }),
    ).toMatchObject({ kind: 'COMMITTED', message: { text: 'Welcome back' } })
    const inbox = await listConversations(db, {
      workspaceId: f.workspaceId,
      userId: f.ownerId,
      view: 'all-open',
    })
    expect(inbox.conversations[0].aiStopState).toBeNull()
  })

  it('checks deleted condition references when a schedule-stopped conversation resumes', async () => {
    const f = await createFixture(db)
    const at = new Date()
    const [property] = await db
      .insert(customerPropertyDefinition)
      .values({
        workspaceId: f.workspaceId,
        name: 'Stage',
        level: 'CONVERSATION',
        type: 'TEXT',
      })
      .returning()
    await updateAiMemberConfig(db, {
      workspaceId: f.workspaceId,
      memberId: f.aiMemberId,
      actingUserId: f.ownerId,
      timeZone: 'UTC',
      stopRules: {
        groups: [[{ kind: 'PROPERTY', definitionId: property.id, value: 'done' }]],
        periods: [{ day: at.getUTCDay(), start: '00:00', end: '24:00' }],
        endingText: '',
        endingMediaAssetId: null,
      },
    })
    await publishAiMemberConfig(db, {
      workspaceId: f.workspaceId,
      memberId: f.aiMemberId,
      actingUserId: f.ownerId,
      providerConfigured: true,
    })
    const run = await createGeneratingRun(db, f, 'Hello')
    expect(
      await commitAiResponse(db, { runId: run.runId, text: '', stopCheckOnly: true, now: at }),
    ).toMatchObject({ kind: 'STOPPED', reason: 'SCHEDULE' })
    await db
      .update(customerPropertyDefinition)
      .set({ deletedAt: new Date() })
      .where(eq(customerPropertyDefinition.id, property.id))
    const nextDay = new Date(at.getTime() + 86400000)
    const after = await receive(db, f, 'After the period', nextDay)
    await db.update(message).set({ createdAt: nextDay }).where(eq(message.id, after.messageId))
    await claimAiResponseRun(db, {
      runId: after.aiResponseRunId as string,
      now: new Date(nextDay.getTime() + 2000),
    })
    await expect(
      commitAiResponse(db, {
        runId: after.aiResponseRunId as string,
        text: 'Not sent',
        now: nextDay,
      }),
    ).rejects.toMatchObject({ code: 'STOP_REFERENCE_UNAVAILABLE' })
    expect(
      await db
        .select()
        .from(message)
        .where(
          and(eq(message.conversationId, run.conversationId), eq(message.direction, 'OUTBOUND')),
        ),
    ).toEqual([])
  })

  it('does not count a handoff notice after transfer back to AI', async () => {
    const f = await createFixture(db)
    await updateAiMemberConfig(db, {
      workspaceId: f.workspaceId,
      memberId: f.aiMemberId,
      actingUserId: f.ownerId,
      stopRules: {
        groups: [[{ kind: 'REPLIES', minimum: 1 }]],
        periods: [],
        endingText: '',
        endingMediaAssetId: null,
      },
    })
    await publishAiMemberConfig(db, {
      workspaceId: f.workspaceId,
      memberId: f.aiMemberId,
      actingUserId: f.ownerId,
      providerConfigured: true,
    })
    const run = await createGeneratingRun(db, f, 'Human please')
    const handoff = await handoffAiConversation(db, {
      workspaceId: f.workspaceId,
      conversationId: run.conversationId,
      memberId: f.aiMemberId,
      runId: run.runId,
      reason: 'CUSTOMER_REQUEST',
      noticeText: 'Connecting you to our team.',
    })
    expect(handoff.messageId).toBeTruthy()
    await takeOverConversation(db, {
      workspaceId: f.workspaceId,
      conversationId: run.conversationId,
      actingUserId: f.ownerId,
    })
    const transferred = await transferConversation(db, {
      workspaceId: f.workspaceId,
      conversationId: run.conversationId,
      actingUserId: f.ownerId,
      targetMemberId: f.aiMemberId,
      confirmOverride: true,
    })
    const next = await receive(db, f, 'Back to AI', new Date(Date.now() + 5000))
    expect(transferred.changed).toBe(true)
    await claimAiResponseRun(db, {
      runId: next.aiResponseRunId as string,
      now: new Date(Date.now() + 7000),
    })
    expect(
      await commitAiResponse(db, {
        runId: next.aiResponseRunId as string,
        text: '',
        stopCheckOnly: true,
      }),
    ).toMatchObject({ kind: 'CONTINUE' })
    expect(
      await commitAiResponse(db, { runId: next.aiResponseRunId as string, text: 'Welcome back' }),
    ).toMatchObject({ kind: 'COMMITTED' })
  })

  it('commits an image-only ending once under concurrent stop checks', async () => {
    const f = await createFixture(db)
    const [asset] = await db
      .insert(mediaAsset)
      .values({
        id: randomUUID(),
        workspaceId: f.workspaceId,
        title: 'Closed',
        filename: 'closed.png',
        kind: 'IMAGE',
        mimeType: 'image/png',
        byteSize: 12,
        sha256: 'c'.repeat(64),
        storageKey: 'test/closed',
        inLibrary: true,
      })
      .returning()
    await updateAiMemberConfig(db, {
      workspaceId: f.workspaceId,
      memberId: f.aiMemberId,
      actingUserId: f.ownerId,
      stopRules: {
        groups: [[{ kind: 'REPLIES', minimum: 0 }]],
        periods: [],
        endingText: '',
        endingMediaAssetId: asset.id,
      },
    })
    await publishAiMemberConfig(db, {
      workspaceId: f.workspaceId,
      memberId: f.aiMemberId,
      actingUserId: f.ownerId,
      providerConfigured: true,
    })
    const run = await createGeneratingRun(db, f, 'Hello')
    const results = await Promise.all([
      commitAiResponse(db, { runId: run.runId, text: '', stopCheckOnly: true }),
      commitAiResponse(db, { runId: run.runId, text: '', stopCheckOnly: true }),
    ])
    const committed = results.find((r) => r?.kind === 'COMMITTED')
    if (committed?.kind !== 'COMMITTED') throw new Error('Image ending was not committed')
    expect(results.filter(Boolean)).toHaveLength(1)
    expect(committed.messages).toHaveLength(1)
    expect(committed.message.messageType).toBe('ATTACHMENT')
    await db.update(mediaAsset).set({ deletedAt: new Date() }).where(eq(mediaAsset.id, asset.id))
    await takeOverConversation(db, {
      workspaceId: f.workspaceId,
      conversationId: run.conversationId,
      actingUserId: f.ownerId,
    })
    expect(await claimOutboundMessage(db, { messageId: committed.message.id })).toMatchObject({
      messageType: 'ATTACHMENT',
    })
    expect(
      await db
        .select({ key: messageAttachment.storageKey })
        .from(messageAttachment)
        .where(eq(messageAttachment.messageId, committed.message.id)),
    ).toEqual([{ key: 'test/closed' }])
  })

  it('matches authorized property and tag groups at commit, without treating each segment as a reply', async () => {
    const f = await createFixture(db)
    const [property] = await db
      .insert(customerPropertyDefinition)
      .values({ workspaceId: f.workspaceId, name: 'Stage', level: 'CONVERSATION', type: 'TEXT' })
      .returning()
    const [tag] = await db
      .insert(customerTagDefinition)
      .values({ workspaceId: f.workspaceId, name: 'Done', level: 'CUSTOMER' })
      .returning()
    await updateAiMemberConfig(db, {
      workspaceId: f.workspaceId,
      memberId: f.aiMemberId,
      actingUserId: f.ownerId,
      splitRepliesEnabled: true,
      stopRules: {
        groups: [
          [
            { kind: 'PROPERTY', definitionId: property.id, value: 'finished' },
            { kind: 'TAG', tagId: tag.id },
          ],
          [{ kind: 'REPLIES', minimum: 2 }],
        ],
        periods: [],
        endingText: '',
        endingMediaAssetId: null,
      },
    })
    await publishAiMemberConfig(db, {
      workspaceId: f.workspaceId,
      memberId: f.aiMemberId,
      actingUserId: f.ownerId,
      providerConfigured: true,
    })
    const run = await createGeneratingRun(db, f, 'Hello')
    const [identity] = await db
      .select({ customerId: channelIdentity.customerId, channelId: channelIdentity.channelId })
      .from(conversation)
      .innerJoin(channelIdentity, eq(conversation.channelIdentityId, channelIdentity.id))
      .where(eq(conversation.id, run.conversationId))
    await db.insert(customerPropertyValue).values({
      definitionId: property.id,
      conversationId: run.conversationId,
      value: 'finished',
      sourceChannelId: identity.channelId,
    })
    expect(
      await commitAiResponse(db, { runId: run.runId, text: '', stopCheckOnly: true }),
    ).toMatchObject({ kind: 'CONTINUE' })
    const first = await commitAiResponse(db, { runId: run.runId, text: 'x'.repeat(1200) })
    if (first?.kind !== 'COMMITTED') throw new Error('Split answer missing')
    expect(first.messages).toHaveLength(3)
    const laterAt = new Date(Date.now() + 5000)
    const next = await receive(db, f, 'Another question', laterAt)
    await claimAiResponseRun(db, {
      runId: next.aiResponseRunId as string,
      now: new Date(laterAt.getTime() + 2000),
    })
    expect(
      await commitAiResponse(db, {
        runId: next.aiResponseRunId as string,
        text: '',
        stopCheckOnly: true,
      }),
    ).toMatchObject({ kind: 'CONTINUE' })
    const [hidden] = await db
      .insert(channel)
      .values({
        workspaceId: f.workspaceId,
        provider: 'FACEBOOK_MESSENGER',
        displayName: 'Hidden',
        status: 'ACTIVE',
      })
      .returning()
    await db.insert(customerTag).values({
      tagId: tag.id,
      customerId: identity.customerId,
      sourceChannelId: hidden.id,
    })
    expect(
      await commitAiResponse(db, {
        runId: next.aiResponseRunId as string,
        text: '',
        stopCheckOnly: true,
      }),
    ).toMatchObject({ kind: 'CONTINUE' })
    await db
      .update(customerTag)
      .set({ sourceChannelId: identity.channelId })
      .where(eq(customerTag.tagId, tag.id))
    expect(
      await commitAiResponse(db, {
        runId: next.aiResponseRunId as string,
        text: 'Generation made before tagging',
      }),
    ).toMatchObject({ kind: 'STOPPED', reason: 'CONDITION' })
  })

  it('stays stopped when the published ending image is revoked before commit', async () => {
    const f = await createFixture(db)
    const [asset] = await db
      .insert(mediaAsset)
      .values({
        id: randomUUID(),
        workspaceId: f.workspaceId,
        title: 'Closed',
        filename: 'closed.png',
        kind: 'IMAGE',
        mimeType: 'image/png',
        byteSize: 12,
        sha256: 'd'.repeat(64),
        storageKey: 'test/revoked-ending',
        inLibrary: true,
      })
      .returning()
    const identity = { workspaceId: f.workspaceId, memberId: f.aiMemberId, actingUserId: f.ownerId }
    await updateAiMemberConfig(db, {
      ...identity,
      stopRules: {
        groups: [[{ kind: 'REPLIES', minimum: 0 }]],
        periods: [],
        endingText: '',
        endingMediaAssetId: asset.id,
      },
    })
    await publishAiMemberConfig(db, { ...identity, providerConfigured: true })
    await db.update(mediaAsset).set({ deletedAt: new Date() }).where(eq(mediaAsset.id, asset.id))
    await expect(
      publishAiMemberConfig(db, { ...identity, providerConfigured: true }),
    ).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' })
    const run = await createGeneratingRun(db, f, 'Hello')
    expect(
      await commitAiResponse(db, { runId: run.runId, text: '', stopCheckOnly: true }),
    ).toMatchObject({ kind: 'STOPPED' })
    expect((await getAiDiagnostics(db, { ...identity, id: run.runId })).run?.failureCode).toBe(
      'AI_STOP_ENDING_UNAVAILABLE',
    )
    const inbox = await listConversations(db, {
      workspaceId: f.workspaceId,
      userId: f.ownerId,
      view: 'all-open',
    })
    expect(inbox.conversations[0]).toMatchObject({
      aiStopState: { reason: 'CONDITION' },
      assigneeMemberId: f.aiMemberId,
      routingConstraint: 'ANY_MEMBER',
    })
  })

  it('does not latch a stop or send an ending from stale customer input', async () => {
    const f = await createFixture(db)
    await updateAiMemberConfig(db, {
      workspaceId: f.workspaceId,
      memberId: f.aiMemberId,
      actingUserId: f.ownerId,
      stopRules: {
        groups: [[{ kind: 'REPLIES', minimum: 0 }]],
        periods: [],
        endingText: 'Ending',
        endingMediaAssetId: null,
      },
    })
    await publishAiMemberConfig(db, {
      workspaceId: f.workspaceId,
      memberId: f.aiMemberId,
      actingUserId: f.ownerId,
      providerConfigured: true,
    })
    const run = await createGeneratingRun(db, f, 'First')
    await receive(db, f, 'New input', new Date(run.now.getTime() + 5000))
    expect(
      await commitAiResponse(db, { runId: run.runId, text: '', stopCheckOnly: true }),
    ).toBeNull()
    const inbox = await listConversations(db, {
      workspaceId: f.workspaceId,
      userId: f.ownerId,
      view: 'all-open',
    })
    expect(inbox.conversations[0].aiStopState).toBeNull()
  })

  it('commits retrieved private media with its reply and preserves committed bytes after deletion', async () => {
    const f = await createFixture(db)
    const run = await createGeneratingRun(db, f, 'Please send the guide.')
    const [claim] = await db
      .select({ snapshot: aiResponseRun.configSnapshot })
      .from(aiResponseRun)
      .where(eq(aiResponseRun.id, run.runId))
    const assetId = randomUUID()
    await db.insert(mediaAsset).values({
      id: assetId,
      workspaceId: f.workspaceId,
      title: 'Guide',
      filename: 'guide.pdf',
      kind: 'FILE',
      mimeType: 'application/pdf',
      byteSize: 12,
      sha256: 'a'.repeat(64),
      storageKey: 'test/private-guide',
      inLibrary: true,
    })
    const [doc] = await db
      .insert(knowledgeDocument)
      .values({
        workspaceId: f.workspaceId,
        knowledgeBaseId: claim.snapshot?.knowledgeBaseId as string,
        name: 'Guide',
        sourceType: 'TEXT',
        sourceText: 'Setup guide',
        mediaAssetId: assetId,
        status: 'READY',
      })
      .returning()
    const [chunk] = await db
      .insert(knowledgeChunk)
      .values({
        workspaceId: f.workspaceId,
        knowledgeBaseId: doc.knowledgeBaseId,
        knowledgeDocumentId: doc.id,
        ordinal: 0,
        text: 'Setup guide',
        embedding: Array.from({ length: 1536 }, (_, i) => (i === 0 ? 1 : 0)),
      })
      .returning()
    await expect(
      commitAiResponse(db, { runId: run.runId, text: 'Here is the guide.', mediaAssetId: assetId }),
    ).rejects.toMatchObject({ code: 'MEDIA_UNAVAILABLE' })
    await recordAiResponseRetrievedChunks(db, { runId: run.runId, chunkIds: [chunk.id] })
    const reply = await commitAiResponse(db, {
      runId: run.runId,
      text: 'Here is the guide.',
      mediaAssetId: assetId,
    })
    if (reply?.kind !== 'COMMITTED') throw new Error('Media not committed')
    expect(reply.messages.map((part) => part.messageType)).toEqual(['TEXT', 'ATTACHMENT'])
    expect(reply.messages[1].replyAfterMessageId).toBe(reply.messages[0].id)
    await db.delete(knowledgeDocument).where(eq(knowledgeDocument.id, doc.id))
    await db.update(mediaAsset).set({ deletedAt: new Date() }).where(eq(mediaAsset.id, assetId))
    await takeOverConversation(db, {
      workspaceId: f.workspaceId,
      conversationId: run.conversationId,
      actingUserId: f.ownerId,
    })
    const sentAt = new Date()
    const text = await claimOutboundMessage(db, { messageId: reply.messages[0].id, now: sentAt })
    if (!text) throw new Error('Text not claimed')
    await completeOutboundMessage(db, {
      messageId: text.id,
      attemptId: text.attemptId,
      externalMessageId: randomUUID(),
      now: sentAt,
    })
    expect(
      await claimOutboundMessage(db, {
        messageId: reply.messages[1].id,
        now: new Date(sentAt.getTime() + 1000),
      }),
    ).toMatchObject({ messageType: 'ATTACHMENT' })
    expect(
      await db
        .select({ storageKey: messageAttachment.storageKey })
        .from(messageAttachment)
        .where(eq(messageAttachment.messageId, reply.messages[1].id)),
    ).toEqual([{ storageKey: 'test/private-guide' }])
    expect(
      await commitAiResponse(db, {
        runId: run.runId,
        text: 'Here is the guide.',
        mediaAssetId: assetId,
      }),
    ).toBeNull()
  })

  it('commits an ordered split reply once without losing its tail', async () => {
    const f = await createFixture(db)
    await updateAiMemberConfig(db, {
      workspaceId: f.workspaceId,
      memberId: f.aiMemberId,
      actingUserId: f.ownerId,
      splitRepliesEnabled: true,
    })
    await publishAiMemberConfig(db, {
      workspaceId: f.workspaceId,
      memberId: f.aiMemberId,
      actingUserId: f.ownerId,
      providerConfigured: true,
    })
    const run = await createGeneratingRun(db, f, 'Please explain.')
    const text = `${'A'.repeat(499)}${'🙂'.repeat(250)}${'B'.repeat(650)}THE END`
    const result = await commitAiResponse(db, { runId: run.runId, text })
    expect(result?.kind).toBe('COMMITTED')
    if (result?.kind !== 'COMMITTED') throw new Error('Reply not committed')
    expect(result.messages).toHaveLength(3)
    expect(result.messages.map((part) => part.text).join('')).toBe(text)
    expect(result.messages[0].text).toBe(`${'A'.repeat(499)}🙂`)
    expect(result.messages[1].text).toBe(`${'🙂'.repeat(249)}${'B'.repeat(251)}`)
    expect(result.messages.map((part) => part.replySegmentIndex)).toEqual([1, 2, 3])
    expect(await commitAiResponse(db, { runId: run.runId, text })).toBeNull()
    await takeOverConversation(db, {
      workspaceId: f.workspaceId,
      conversationId: run.conversationId,
      actingUserId: f.ownerId,
    })
    const sentAt = new Date()
    await expect(
      claimOutboundMessage(db, { messageId: result.messages[2].id, now: sentAt }),
    ).rejects.toMatchObject({ code: 'RETRY_LATER' })
    const first = await claimOutboundMessage(db, { messageId: result.messages[0].id, now: sentAt })
    if (!first) throw new Error('First segment not claimed')
    await completeOutboundMessage(db, {
      messageId: first.id,
      attemptId: first.attemptId,
      externalMessageId: 'split-first',
      now: sentAt,
    })
    await expect(
      claimOutboundMessage(db, {
        messageId: result.messages[1].id,
        now: new Date(sentAt.getTime() + 999),
      }),
    ).rejects.toMatchObject({ code: 'RETRY_LATER', retryAfterMs: 1 })
    const second = await claimOutboundMessage(db, {
      messageId: result.messages[1].id,
      now: new Date(sentAt.getTime() + 1000),
    })
    if (!second) throw new Error('Second segment not claimed')
    await failOutboundMessage(db, {
      messageId: second.id,
      attemptId: second.attemptId,
      failureCode: 'AMBIGUOUS_DELIVERY',
      failureMessage: 'Unknown send result',
    })
    expect(await claimOutboundMessage(db, { messageId: second.id })).toBeNull()
    expect(await claimOutboundMessage(db, { messageId: result.messages[2].id })).toBeNull()
    expect(
      (
        await aiOperationForMessage(db, {
          workspaceId: f.workspaceId,
          actingUserId: f.ownerId,
          messageId: result.messages[2].id,
        })
      ).segments.map((part) => part.deliveryState),
    ).toEqual(['SENT', 'FAILED', 'FAILED'])
    expect(
      (
        await getAiDiagnostics(db, {
          workspaceId: f.workspaceId,
          actingUserId: f.ownerId,
          id: run.runId,
        })
      ).output,
    ).toMatchObject({ text, deliveryState: 'FAILED' })
    expect(
      (
        await getAiAnalytics(db, {
          workspaceId: f.workspaceId,
          actingUserId: f.ownerId,
          from: new Date(Date.now() - 60_000),
          to: new Date(Date.now() + 60_000),
          timezone: 'UTC',
        })
      ).replies,
    ).toEqual([{ sender: 'AI', replies: 1, sent: 0, failed: 1 }])
  })

  it('retains the automatic language across runs and commits a requested switch only for current input', async () => {
    const f = await createFixture(db)
    await updateAiMemberConfig(db, {
      workspaceId: f.workspaceId,
      memberId: f.aiMemberId,
      actingUserId: f.ownerId,
      automaticLanguageEnabled: true,
      replyWaitEnabled: false,
      timeZone: 'America/New_York',
    })
    await publishAiMemberConfig(db, {
      workspaceId: f.workspaceId,
      memberId: f.aiMemberId,
      actingUserId: f.ownerId,
      providerConfigured: true,
    })
    const start = new Date()
    const first = await receive(db, f, 'I need help with my account.', start)
    const routed = await autoAssignConversation(db, {
      workspaceId: f.workspaceId,
      conversationId: first.conversationId,
      now: start,
    })
    const runId = routed.aiResponseRunId as string
    expect(await claimAiResponseRun(db, { runId, now: start })).toMatchObject({
      replyLanguage: null,
      publishedSnapshot: { automaticLanguageEnabled: true, timeZone: 'America/New_York' },
    })
    await commitAiResponse(db, {
      runId,
      text: 'How can I help?',
      languageSelection: { language: 'en', explicitSwitch: false },
    })
    const next = await receive(db, f, 'Please reply in French.', new Date(start.getTime() + 3000))
    const nextRun = next.aiResponseRunId as string
    expect(
      await claimAiResponseRun(db, { runId: nextRun, now: new Date(start.getTime() + 3000) }),
    ).toMatchObject({ replyLanguage: 'en' })
    const later = await receive(
      db,
      f,
      'Please keep using English.',
      new Date(start.getTime() + 4000),
    )
    expect(
      await commitAiResponse(db, {
        runId: nextRun,
        text: 'Bonjour.',
        languageSelection: { language: 'fr', explicitSwitch: true },
      }),
    ).toBeNull()
    const lastRun = later.aiResponseRunId as string
    expect(
      await claimAiResponseRun(db, { runId: lastRun, now: new Date(start.getTime() + 4000) }),
    ).toMatchObject({ replyLanguage: 'en' })
    await commitAiResponse(db, {
      runId: lastRun,
      text: 'Bien sûr.',
      languageSelection: { language: 'fr', explicitSwitch: true },
    })
    const lowInfo = await receive(db, f, '🙂', new Date(start.getTime() + 5000))
    expect(
      await claimAiResponseRun(db, {
        runId: lowInfo.aiResponseRunId as string,
        now: new Date(start.getTime() + 5000),
      }),
    ).toMatchObject({ replyLanguage: 'fr' })
  })

  it.each(['existing', 'new'])(
    'uses the published wait setting during a concurrent %s run update',
    async (kind) => {
      const f = await createFixture(db)
      const start = new Date()
      const first = await receive(db, f, 'First question.', start)
      const routed = await autoAssignConversation(db, {
        workspaceId: f.workspaceId,
        conversationId: first.conversationId,
        now: start,
      })
      const runId = routed.aiResponseRunId as string
      if (kind === 'new') {
        await db
          .update(aiResponseRun)
          .set({ state: 'CANCELLED' })
          .where(eq(aiResponseRun.id, runId))
      }
      const identity = {
        workspaceId: f.workspaceId,
        memberId: f.aiMemberId,
        actingUserId: f.ownerId,
      }
      await updateAiMemberConfig(db, { ...identity, replyWaitEnabled: false })
      const blocker = await pool.connect()
      let publication: ReturnType<typeof publishAiMemberConfig> | undefined
      let inbound: ReturnType<typeof receive> | undefined
      const nextAt = new Date(start.getTime() + 1000)
      try {
        await blocker.query('begin')
        await blocker.query(
          kind === 'existing'
            ? 'select id from ai_response_run where id = $1 for update'
            : 'select id from member where id = $1 for update',
          [kind === 'existing' ? runId : f.aiMemberId],
        )
        publication = publishAiMemberConfig(db, { ...identity, providerConfigured: true })
        await waitForSqlLock(
          pool,
          kind === 'existing' ? 'update "ai_response_run"%' : '%from "member"%for update%',
        )
        inbound = receive(db, f, 'Next question.', nextAt)
        await waitForSqlLock(
          pool,
          kind === 'existing'
            ? '%from "ai_response_run"%for update%'
            : 'insert into "ai_response_run"%',
        )
        await blocker.query('rollback')
        await publication
        const received = await inbound
        expect(
          await claimAiResponseRun(db, { runId: received.aiResponseRunId as string, now: nextAt }),
        ).toMatchObject({
          kind: 'CLAIMED',
          publishedSnapshot: { replyWaitEnabled: false },
        })
      } finally {
        await blocker.query('rollback').catch(() => undefined)
        blocker.release()
        await Promise.allSettled([publication, inbound])
      }
    },
  )

  it('keeps retry backoff separate from waiting and starts a fresh run for later input', async () => {
    const f = await createFixture(db)
    const identity = { workspaceId: f.workspaceId, memberId: f.aiMemberId, actingUserId: f.ownerId }
    const start = new Date()
    const first = await receive(db, f, 'First question.', start)
    const routed = await autoAssignConversation(db, {
      workspaceId: f.workspaceId,
      conversationId: first.conversationId,
      now: start,
    })
    const runId = routed.aiResponseRunId as string
    await claimAiResponseRun(db, { runId, now: new Date(start.getTime() + 2000) })
    await retryAiResponseRun(db, { runId, now: new Date(start.getTime() + 33_000) })
    await updateAiMemberConfig(db, { ...identity, replyWaitEnabled: false })
    await publishAiMemberConfig(db, { ...identity, providerConfigured: true })
    expect(
      await claimAiResponseRun(db, { runId, now: new Date(start.getTime() + 4000) }),
    ).toMatchObject({ kind: 'DELAYED', retryAfterMs: 29_000 })
    const second = await receive(db, f, 'A new question.', new Date(start.getTime() + 5000))
    expect(second.aiResponseRunId).not.toBe(runId)
    expect(
      await claimAiResponseRun(db, {
        runId: second.aiResponseRunId as string,
        now: new Date(start.getTime() + 5000),
      }),
    ).toMatchObject({ kind: 'CLAIMED', publishedSnapshot: { replyWaitEnabled: false } })
  })

  it('applies wait changes only on publication and reschedules the existing waiting run', async () => {
    const f = await createFixture(db)
    const identity = { workspaceId: f.workspaceId, memberId: f.aiMemberId, actingUserId: f.ownerId }
    const start = new Date()
    const first = await receive(db, f, 'Hello', start)
    const routed = await autoAssignConversation(db, {
      workspaceId: f.workspaceId,
      conversationId: first.conversationId,
      now: start,
    })
    const runId = routed.aiResponseRunId as string
    await updateAiMemberConfig(db, {
      ...identity,
      replyWaitEnabled: false,
      naturalToneEnabled: true,
    })
    expect(await claimAiResponseRun(db, { runId, now: start })).toMatchObject({
      kind: 'DELAYED',
      retryAfterMs: 2000,
    })
    await publishAiMemberConfig(db, { ...identity, providerConfigured: true })
    const claimed = await claimAiResponseRun(db, { runId, now: start })
    expect(claimed).toMatchObject({
      kind: 'CLAIMED',
      publishedSnapshot: { replyWaitEnabled: false, naturalToneEnabled: true },
    })
    expect(
      await claimAiResponseRun(db, { runId, now: new Date(start.getTime() + 3000) }),
    ).toBeNull()
    await takeOverConversation(db, {
      workspaceId: f.workspaceId,
      conversationId: first.conversationId,
      actingUserId: f.ownerId,
    })
    expect(await commitAiResponse(db, { runId, text: 'Hello.' })).toBeNull()
  })

  it('caps continuous input waiting at thirty seconds without duplicate claims or replies', async () => {
    const f = await createFixture(db)
    const start = new Date()
    const first = await receive(db, f, 'First part.', start)
    const routed = await autoAssignConversation(db, {
      workspaceId: f.workspaceId,
      conversationId: first.conversationId,
      now: start,
    })
    const runId = routed.aiResponseRunId as string
    let latest = first.messageId
    for (let seconds = 1; seconds <= 29; seconds += 1) {
      const inbound = await receive(
        db,
        f,
        `Part ${seconds}.`,
        new Date(start.getTime() + seconds * 1000),
      )
      expect(inbound.aiResponseRunId).toBe(runId)
      latest = inbound.messageId
    }
    expect(
      await claimAiResponseRun(db, { runId, now: new Date(start.getTime() + 29_000) }),
    ).toMatchObject({ kind: 'DELAYED', retryAfterMs: 1000 })
    const attempts = await Promise.all(
      [1, 2].map(() => claimAiResponseRun(db, { runId, now: new Date(start.getTime() + 30_000) })),
    )
    expect(attempts.filter((run) => run?.kind === 'CLAIMED')).toHaveLength(1)
    const claimed = attempts.find((run) => run?.kind === 'CLAIMED')
    expect(claimed).toMatchObject({ inputLastMessageId: latest })
    const results = await Promise.all(
      [1, 2].map(() => commitAiResponse(db, { runId, text: 'Received all parts.' })),
    )
    expect(results.filter((result) => result?.kind === 'COMMITTED')).toHaveLength(1)
    expect(
      await db
        .select()
        .from(message)
        .where(
          and(eq(message.conversationId, first.conversationId), eq(message.direction, 'OUTBOUND')),
        ),
    ).toHaveLength(1)
  })

  it('claims the published input and commits one pending AI message', async () => {
    const fixture = await createFixture(db)
    const now = new Date('2026-09-15T00:00:00.000Z')
    const received = await processFacebookInbound(db, {
      ingressId: randomUUID(),
      pageId: fixture.pageId,
      externalUserId: `customer-${fixture.ownerId}`,
      externalMessageId: randomUUID(),
      text: 'How much is shipping?',
      providerSentAt: now,
      receivedAt: now,
      payloadSha256: 'a'.repeat(64),
      eventFragment: { text: 'How much is shipping?' },
    })
    if (received.kind !== 'created') throw new Error('Inbound message was not created')

    const routed = await autoAssignConversation(db, {
      workspaceId: fixture.workspaceId,
      conversationId: received.conversationId,
      now,
    })
    expect(routed.aiResponseRunId).toBeTruthy()

    const claimed = await claimAiResponseRun(db, {
      runId: routed.aiResponseRunId as string,
      now: new Date(now.getTime() + 2_000),
    })
    expect(claimed).toMatchObject({
      kind: 'CLAIMED',
      memberId: fixture.aiMemberId,
      inputFirstMessageId: received.messageId,
      inputLastMessageId: received.messageId,
      publishedSnapshot: expect.objectContaining({ knowledgeBaseId: fixture.knowledgeBaseId }),
      inputMessages: [{ id: received.messageId, text: 'How much is shipping?' }],
    })
    if (claimed?.kind !== 'CLAIMED') throw new Error('Run was not claimed')
    const identity = {
      workspaceId: fixture.workspaceId,
      actingUserId: fixture.ownerId,
      memberId: fixture.aiMemberId,
    }
    await updateAiMemberConfig(db, { ...identity, instructions: 'A later policy.' })
    const later = await publishAiMemberConfig(db, { ...identity, providerConfigured: true })
    const diagnostic = await getAiDiagnostics(db, { ...identity, id: claimed.id })
    expect(diagnostic.run?.configVersionId).toBe(claimed.configVersionId)
    expect(diagnostic.run?.configVersionId).not.toBe(later.publishedVersionId)
    expect(diagnostic.run?.configSnapshot).toEqual(claimed.publishedSnapshot)

    const committed = await commitAiResponse(db, {
      runId: routed.aiResponseRunId as string,
      text: 'Shipping is free.',
      now: new Date(now.getTime() + 3_000),
    })
    expect(committed).toMatchObject({
      kind: 'COMMITTED',
      message: {
        direction: 'OUTBOUND',
        senderType: 'MEMBER',
        senderMemberId: fixture.aiMemberId,
        deliveryState: 'PENDING',
        text: 'Shipping is free.',
      },
    })

    const runs = await db
      .select({ state: aiResponseRun.state })
      .from(aiResponseRun)
      .where(eq(aiResponseRun.id, routed.aiResponseRunId as string))
    expect(runs).toEqual([{ state: 'COMPLETED' }])
    expect(
      await db
        .select({ id: message.id })
        .from(message)
        .where(
          and(
            eq(message.conversationId, received.conversationId),
            eq(message.senderMemberId, fixture.aiMemberId),
          ),
        ),
    ).toHaveLength(1)
  })

  it('cancels stale generation and queues one fresh run for new customer input', async () => {
    const fixture = await createFixture(db)
    const firstAt = new Date()
    const first = await receive(db, fixture, 'first question', firstAt)
    const routed = await autoAssignConversation(db, {
      workspaceId: fixture.workspaceId,
      conversationId: first.conversationId,
      now: firstAt,
    })
    const oldRunId = routed.aiResponseRunId
    if (!oldRunId) throw new Error('AI response run was not created')
    await expect(
      claimAiResponseRun(db, {
        runId: oldRunId,
        now: new Date(firstAt.getTime() + 2_000),
      }),
    ).resolves.toMatchObject({ kind: 'CLAIMED' })

    const secondAt = new Date(firstAt.getTime() + 3_000)
    const second = await receive(db, fixture, 'second question', secondAt)
    expect(second.aiResponseRunId).toBeTruthy()
    expect(second.aiResponseRunId).not.toBe(oldRunId)

    const runs = await db
      .select({
        id: aiResponseRun.id,
        state: aiResponseRun.state,
        inputFirstMessageId: aiResponseRun.inputFirstMessageId,
        inputLastMessageId: aiResponseRun.inputLastMessageId,
        scheduledFor: aiResponseRun.scheduledFor,
        cancellationReason: aiResponseRun.cancellationReason,
      })
      .from(aiResponseRun)
      .where(eq(aiResponseRun.conversationId, first.conversationId))
    expect(runs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: oldRunId,
          state: 'CANCELLED',
          cancellationReason: 'NEW_CUSTOMER_MESSAGE',
        }),
        expect.objectContaining({
          id: second.aiResponseRunId,
          state: 'QUEUED',
          inputFirstMessageId: first.messageId,
          inputLastMessageId: second.messageId,
          scheduledFor: new Date(secondAt.getTime() + 2_000),
        }),
      ]),
    )
    expect(runs).toHaveLength(2)
    expect(
      await db
        .select({ id: message.id })
        .from(message)
        .where(
          and(eq(message.conversationId, first.conversationId), eq(message.direction, 'OUTBOUND')),
        ),
    ).toHaveLength(0)
  })

  it('keeps freshness aligned when provider timestamps arrive out of order', async () => {
    const fixture = await createFixture(db)
    const firstAt = new Date()
    const first = await receive(db, fixture, 'first question', firstAt)
    const routed = await autoAssignConversation(db, {
      workspaceId: fixture.workspaceId,
      conversationId: first.conversationId,
      now: firstAt,
    })
    const oldRunId = routed.aiResponseRunId
    if (!oldRunId) throw new Error('AI response run was not created')

    const second = await receive(
      db,
      fixture,
      'second question received later but sent earlier',
      new Date(firstAt.getTime() - 1_000),
      new Date(firstAt.getTime() + 3_000),
    )
    expect(second.aiResponseRunId).toBe(oldRunId)

    const [run] = await db
      .select({ state: aiResponseRun.state, inputLastMessageId: aiResponseRun.inputLastMessageId })
      .from(aiResponseRun)
      .where(eq(aiResponseRun.id, oldRunId))
    expect(run).toEqual({ state: 'QUEUED', inputLastMessageId: second.messageId })
    await expect(
      commitAiResponse(db, { runId: oldRunId, text: 'not claimed yet' }),
    ).resolves.toBeNull()
  })

  it('cancels before takeover, but keeps a committed AI message after takeover', async () => {
    const cancelledFixture = await createFixture(db)
    const cancelledAt = new Date()
    const cancelledInput = await receive(db, cancelledFixture, 'takeover first', cancelledAt)
    const cancelledRoute = await autoAssignConversation(db, {
      workspaceId: cancelledFixture.workspaceId,
      conversationId: cancelledInput.conversationId,
      now: cancelledAt,
    })
    const cancelledRunId = cancelledRoute.aiResponseRunId
    if (!cancelledRunId) throw new Error('AI response run was not created')
    await claimAiResponseRun(db, {
      runId: cancelledRunId,
      now: new Date(cancelledAt.getTime() + 2_000),
    })

    await takeOverConversation(db, {
      workspaceId: cancelledFixture.workspaceId,
      conversationId: cancelledInput.conversationId,
      actingUserId: cancelledFixture.ownerId,
      now: new Date(cancelledAt.getTime() + 3_000),
    })
    expect(
      await db
        .select({
          state: aiResponseRun.state,
          cancellationReason: aiResponseRun.cancellationReason,
        })
        .from(aiResponseRun)
        .where(eq(aiResponseRun.id, cancelledRunId)),
    ).toEqual([{ state: 'CANCELLED', cancellationReason: 'OWNERSHIP_CHANGED' }])
    await expect(
      listConversations(db, {
        workspaceId: cancelledFixture.workspaceId,
        userId: cancelledFixture.ownerId,
        view: 'all-open',
        conversationId: cancelledInput.conversationId,
      }),
    ).resolves.toMatchObject({ conversations: [{ aiGenerating: false }] })
    await expect(
      commitAiResponse(db, { runId: cancelledRunId, text: 'late AI reply' }),
    ).resolves.toBeNull()
    expect(
      await db
        .select({ id: message.id })
        .from(message)
        .where(
          and(
            eq(message.conversationId, cancelledInput.conversationId),
            eq(message.direction, 'OUTBOUND'),
          ),
        ),
    ).toHaveLength(0)

    const committedFixture = await createFixture(db)
    const committedAt = new Date()
    const committedInput = await receive(db, committedFixture, 'takeover after', committedAt)
    const committedRoute = await autoAssignConversation(db, {
      workspaceId: committedFixture.workspaceId,
      conversationId: committedInput.conversationId,
      now: committedAt,
    })
    const committedRunId = committedRoute.aiResponseRunId
    if (!committedRunId) throw new Error('AI response run was not created')
    await claimAiResponseRun(db, {
      runId: committedRunId,
      now: new Date(committedAt.getTime() + 2_000),
    })
    const committed = await commitAiResponse(db, {
      runId: committedRunId,
      text: 'AI reply already committed',
      now: new Date(committedAt.getTime() + 3_000),
    })
    expect(committed?.kind).toBe('COMMITTED')

    await takeOverConversation(db, {
      workspaceId: committedFixture.workspaceId,
      conversationId: committedInput.conversationId,
      actingUserId: committedFixture.ownerId,
      now: new Date(committedAt.getTime() + 4_000),
    })
    expect(
      await db
        .select({ state: aiResponseRun.state })
        .from(aiResponseRun)
        .where(eq(aiResponseRun.id, committedRunId)),
    ).toEqual([{ state: 'COMPLETED' }])
    expect(
      await db
        .select({ text: message.text, deliveryState: message.deliveryState })
        .from(message)
        .where(
          and(
            eq(message.conversationId, committedInput.conversationId),
            eq(message.direction, 'OUTBOUND'),
          ),
        ),
    ).toEqual([{ text: 'AI reply already committed', deliveryState: 'PENDING' }])
  })

  it('serializes takeover and AI commit in either lock order', async () => {
    const takeoverFixture = await createFixture(db)
    const takeoverRun = await createGeneratingRun(db, takeoverFixture, 'takeover wins')
    const [takeover, cancelledCommit] = await raceOnConversationLock(
      pool,
      takeoverRun.conversationId,
      () =>
        takeOverConversation(db, {
          workspaceId: takeoverFixture.workspaceId,
          conversationId: takeoverRun.conversationId,
          actingUserId: takeoverFixture.ownerId,
          now: new Date(takeoverRun.now.getTime() + 3_000),
        }),
      () =>
        commitAiResponse(db, {
          runId: takeoverRun.runId,
          text: 'late AI reply',
          now: new Date(takeoverRun.now.getTime() + 3_000),
        }),
    )
    expect(takeover.changed).toBe(true)
    expect(cancelledCommit).toBeNull()

    const commitFixture = await createFixture(db)
    const commitRun = await createGeneratingRun(db, commitFixture, 'commit wins')
    const [committed, takeoverAfterCommit] = await raceOnConversationLock(
      pool,
      commitRun.conversationId,
      () =>
        commitAiResponse(db, {
          runId: commitRun.runId,
          text: 'AI reply before takeover',
          now: new Date(commitRun.now.getTime() + 3_000),
        }),
      () =>
        takeOverConversation(db, {
          workspaceId: commitFixture.workspaceId,
          conversationId: commitRun.conversationId,
          actingUserId: commitFixture.ownerId,
          now: new Date(commitRun.now.getTime() + 3_000),
        }),
    )
    expect(committed).toMatchObject({ kind: 'COMMITTED' })
    expect(takeoverAfterCommit.changed).toBe(true)
    expect(
      await db
        .select({ text: message.text, deliveryState: message.deliveryState })
        .from(message)
        .where(
          and(
            eq(message.conversationId, commitRun.conversationId),
            eq(message.direction, 'OUTBOUND'),
          ),
        ),
    ).toEqual([{ text: 'AI reply before takeover', deliveryState: 'PENDING' }])
  })

  it('deduplicates claims and fails stale generation before a late commit', async () => {
    const fixture = await createFixture(db)
    const startedAt = new Date()
    const received = await receive(db, fixture, 'recover me', startedAt)
    const routed = await autoAssignConversation(db, {
      workspaceId: fixture.workspaceId,
      conversationId: received.conversationId,
      now: startedAt,
    })
    const runId = routed.aiResponseRunId
    if (!runId) throw new Error('AI response run was not created')

    const claims = await Promise.all([
      claimAiResponseRun(db, { runId, now: new Date(startedAt.getTime() + 2_000) }),
      claimAiResponseRun(db, { runId, now: new Date(startedAt.getTime() + 2_000) }),
    ])
    expect(claims.filter((claim) => claim?.kind === 'CLAIMED')).toHaveLength(1)
    expect(claims.filter((claim) => claim === null)).toHaveLength(1)

    const recoveredAt = new Date(startedAt.getTime() + 5 * 60 * 1_000 + 2_001)
    await expect(recoverStaleAiResponseRuns(db, { now: recoveredAt })).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ runId, conversationId: received.conversationId }),
      ]),
    )
    expect(
      await db
        .select({ state: aiResponseRun.state, failureCode: aiResponseRun.failureCode })
        .from(aiResponseRun)
        .where(eq(aiResponseRun.id, runId)),
    ).toEqual([{ state: 'FAILED', failureCode: 'AI_GENERATION_TIMEOUT' }])
    await expect(
      commitAiResponse(db, { runId, text: 'late response', now: recoveredAt }),
    ).resolves.toBeNull()
  })
})

async function createFixture(db: ReturnType<typeof createDatabase>) {
  const ownerId = randomUUID()
  const pageId = randomUUID()
  await db.insert(user).values({ id: ownerId, name: 'Owner', email: `${ownerId}@example.com` })
  const workspace = await bootstrapWorkspace(db, {
    userId: ownerId,
    userName: 'Owner',
    name: `AI response ${ownerId}`,
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
    instructions: 'Answer from support facts.',
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
    workspaceId: workspace.id,
    pageId,
    knowledgeBaseId: knowledgeBase.id,
    aiMemberId: ai.id,
  }
}

async function receive(
  db: ReturnType<typeof createDatabase>,
  fixture: Awaited<ReturnType<typeof createFixture>>,
  text: string,
  at: Date,
  receivedAt = at,
) {
  const received = await processFacebookInbound(db, {
    ingressId: randomUUID(),
    pageId: fixture.pageId,
    externalUserId: `customer-${fixture.ownerId}`,
    externalMessageId: randomUUID(),
    text,
    providerSentAt: at,
    receivedAt,
    payloadSha256: 'a'.repeat(64),
    eventFragment: { text },
  })
  if (received.kind !== 'created') throw new Error('Inbound message was not created')
  return received
}

async function createGeneratingRun(
  db: ReturnType<typeof createDatabase>,
  fixture: Awaited<ReturnType<typeof createFixture>>,
  text: string,
) {
  const now = new Date()
  const received = await receive(db, fixture, text, now)
  const routed = await autoAssignConversation(db, {
    workspaceId: fixture.workspaceId,
    conversationId: received.conversationId,
    now,
  })
  if (!routed.aiResponseRunId) throw new Error('AI response run was not created')
  const claimed = await claimAiResponseRun(db, {
    runId: routed.aiResponseRunId,
    now: new Date(now.getTime() + 2_000),
  })
  if (claimed?.kind !== 'CLAIMED') throw new Error('AI response run was not claimed')
  return { conversationId: received.conversationId, runId: routed.aiResponseRunId, now }
}

async function raceOnConversationLock<First, Second>(
  pool: Pool,
  conversationId: string,
  first: () => Promise<First>,
  second: () => Promise<Second>,
) {
  const client = await pool.connect()
  let firstPromise: Promise<First> | undefined
  let secondPromise: Promise<Second> | undefined
  try {
    await client.query('begin')
    await client.query('select id from conversation where id = $1 for update', [conversationId])
    firstPromise = first()
    await waitForConversationLockWaiters(pool, 1)
    secondPromise = second()
    await waitForConversationLockWaiters(pool, 2)
    await client.query('rollback')
    if (!firstPromise || !secondPromise) throw new Error('Lock race was not started')
    return await Promise.all([firstPromise, secondPromise])
  } finally {
    await client.query('rollback').catch(() => undefined)
    client.release()
    await Promise.allSettled(
      [firstPromise, secondPromise].filter((promise): promise is Promise<First> | Promise<Second> =>
        Boolean(promise),
      ),
    )
  }
}

async function waitForConversationLockWaiters(pool: Pool, expected: number) {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const result = await pool.query<{ count: string }>(
      `select count(*)::text as count
         from pg_stat_activity
        where wait_event_type = 'Lock'
          and state = 'active'
          and (query ilike '%conversation%' or query ilike '%workspace%')
          and query ilike '%for update%'`,
    )
    if (Number(result.rows[0]?.count ?? 0) >= expected) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Expected ${expected} conversation lock waiters`)
}

async function waitForSqlLock(pool: Pool, queryPattern: string) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const result = await pool.query(
      "select 1 from pg_stat_activity where wait_event_type = 'Lock' and state = 'active' and query ilike $1",
      [queryPattern],
    )
    if (result.rowCount) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Expected a lock waiter for ${queryPattern}`)
}
