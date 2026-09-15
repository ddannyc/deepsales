import { randomUUID } from 'node:crypto'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import {
  bootstrapWorkspace,
  createAiMember,
  createDatabase,
  createKnowledgeBase,
  getAiMemberConfig,
  listTeam,
  publishAiMemberConfig,
  setMemberChannelAccess,
  updateMember,
  updateAiMemberConfig,
  user,
  channel,
  workspaceUserAccess,
} from '../src'

const connectionString = process.env.DATABASE_URL

describe.skipIf(!connectionString)('AI member configuration', () => {
  const pool = new Pool({ connectionString })
  const db = createDatabase(pool)

  beforeAll(async () => {
    await migrate(db, { migrationsFolder: 'drizzle' })
  })

  afterAll(() => pool.end())

  it('keeps draft edits separate from the published runtime snapshot', async () => {
    const fixture = await createFixture(db)
    await setMemberChannelAccess(db, {
      workspaceId: fixture.workspaceId,
      memberId: fixture.memberId,
      actingUserId: fixture.userId,
      channelIds: [fixture.channelId],
    })

    const draft = await updateAiMemberConfig(db, {
      workspaceId: fixture.workspaceId,
      memberId: fixture.memberId,
      actingUserId: fixture.userId,
      instructions: 'Answer from support facts only.',
      responseLanguage: 'English',
      knowledgeBaseId: fixture.knowledgeBaseId,
      handoffOnCustomerRequest: false,
      handoffOnNoKnowledge: true,
      handoffOnNegativeSentiment: true,
      handoffOnUnableToAnswer: true,
      handoffKeywords: [' Human ', 'HUMAN', '', 'agent'],
    })
    expect(draft).toEqual(
      expect.objectContaining({
        instructions: 'Answer from support facts only.',
        responseLanguage: 'English',
        handoffKeywords: ['human', 'agent'],
        runtimeStatus: 'UNPUBLISHED',
        publishedSnapshot: null,
      }),
    )

    const publishedAt = new Date('2026-09-15T00:00:00.000Z')
    const published = await publishAiMemberConfig(db, {
      workspaceId: fixture.workspaceId,
      memberId: fixture.memberId,
      actingUserId: fixture.userId,
      providerConfigured: true,
      now: publishedAt,
    })
    expect(published).toEqual(
      expect.objectContaining({
        runtimeStatus: 'USABLE',
        publishedAt,
        publishedSnapshot: expect.objectContaining({
          instructions: 'Answer from support facts only.',
          responseLanguage: 'English',
          knowledgeBaseId: fixture.knowledgeBaseId,
          handoffKeywords: ['human', 'agent'],
        }),
      }),
    )

    await updateAiMemberConfig(db, {
      workspaceId: fixture.workspaceId,
      memberId: fixture.memberId,
      actingUserId: fixture.userId,
      instructions: 'Use the updated support policy.',
    })
    const reread = await getAiMemberConfig(db, {
      workspaceId: fixture.workspaceId,
      memberId: fixture.memberId,
      actingUserId: fixture.userId,
    })
    expect(reread.instructions).toBe('Use the updated support policy.')
    expect(reread.publishedSnapshot?.instructions).toBe('Answer from support facts only.')
    expect(reread.runtimeStatus).toBe('USABLE')

    const republished = await publishAiMemberConfig(db, {
      workspaceId: fixture.workspaceId,
      memberId: fixture.memberId,
      actingUserId: fixture.userId,
      providerConfigured: true,
      now: new Date('2026-09-15T00:01:00.000Z'),
    })
    expect(republished.publishedSnapshot?.instructions).toBe('Use the updated support policy.')

    const team = await listTeam(db, fixture.workspaceId)
    expect(team.members.find(({ id }) => id === fixture.memberId)?.configurationStatus).toBe(
      'USABLE',
    )
  })

  it('rejects publishing when runtime eligibility is incomplete', async () => {
    const fixture = await createFixture(db)
    await updateAiMemberConfig(db, {
      workspaceId: fixture.workspaceId,
      memberId: fixture.memberId,
      actingUserId: fixture.userId,
      instructions: 'Answer safely.',
      responseLanguage: 'English',
      knowledgeBaseId: fixture.knowledgeBaseId,
    })

    await expect(
      publishAiMemberConfig(db, {
        workspaceId: fixture.workspaceId,
        memberId: fixture.memberId,
        actingUserId: fixture.userId,
        providerConfigured: true,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' })

    await setMemberChannelAccess(db, {
      workspaceId: fixture.workspaceId,
      memberId: fixture.memberId,
      actingUserId: fixture.userId,
      channelIds: [fixture.channelId],
    })
    await expect(
      publishAiMemberConfig(db, {
        workspaceId: fixture.workspaceId,
        memberId: fixture.memberId,
        actingUserId: fixture.userId,
        providerConfigured: false,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' })

    await updateMember(db, {
      workspaceId: fixture.workspaceId,
      memberId: fixture.memberId,
      actingUserId: fixture.userId,
      status: 'DISABLED',
    })
    await expect(
      publishAiMemberConfig(db, {
        workspaceId: fixture.workspaceId,
        memberId: fixture.memberId,
        actingUserId: fixture.userId,
        providerConfigured: true,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' })
  })

  it('keeps AI configuration manager-only', async () => {
    const fixture = await createFixture(db)
    const agentId = randomUUID()
    await db.insert(user).values({ id: agentId, name: 'Agent', email: `${agentId}@example.com` })
    await db.insert(workspaceUserAccess).values({
      workspaceId: fixture.workspaceId,
      userId: agentId,
      role: 'AGENT',
    })

    await expect(
      getAiMemberConfig(db, {
        workspaceId: fixture.workspaceId,
        memberId: fixture.memberId,
        actingUserId: agentId,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(
      updateAiMemberConfig(db, {
        workspaceId: fixture.workspaceId,
        memberId: fixture.memberId,
        actingUserId: agentId,
        instructions: 'Must not save',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})

async function createFixture(db: ReturnType<typeof createDatabase>) {
  const userId = randomUUID()
  await db.insert(user).values({ id: userId, name: 'Owner', email: `${userId}@example.com` })
  const workspace = await bootstrapWorkspace(db, {
    userId,
    userName: 'Owner',
    name: `AI workspace ${userId}`,
  })
  const [createdChannel] = await db
    .insert(channel)
    .values({
      workspaceId: workspace.id,
      provider: 'FACEBOOK_MESSENGER',
      displayName: 'Messenger',
    })
    .returning({ id: channel.id })
  if (!createdChannel) throw new Error('Channel was not created')
  const knowledgeBase = await createKnowledgeBase(db, {
    workspaceId: workspace.id,
    createdByUserId: userId,
    name: 'Support facts',
  })
  const ai = await createAiMember(db, {
    workspaceId: workspace.id,
    createdByUserId: userId,
    displayName: 'Answer bot',
  })
  return {
    userId,
    workspaceId: workspace.id,
    channelId: createdChannel.id,
    knowledgeBaseId: knowledgeBase.id,
    memberId: ai.id,
  }
}
