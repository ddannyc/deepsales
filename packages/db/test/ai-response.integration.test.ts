import { randomUUID } from 'node:crypto'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import {
  aiResponseRun,
  autoAssignConversation,
  bootstrapWorkspace,
  claimAiResponseRun,
  commitAiResponse,
  connectFacebookPages,
  createAiMember,
  createDatabase,
  createKnowledgeBase,
  message,
  processFacebookInbound,
  publishAiMemberConfig,
  updateAiMemberConfig,
  user,
} from '../src'

const connectionString = process.env.DATABASE_URL

describe.skipIf(!connectionString)('AI response runs', () => {
  const pool = new Pool({ connectionString })
  const db = createDatabase(pool)

  beforeAll(async () => {
    await migrate(db, { migrationsFolder: 'drizzle' })
  })

  afterAll(() => pool.end())

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
