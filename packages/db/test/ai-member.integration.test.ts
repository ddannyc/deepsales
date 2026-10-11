import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  aiConfigVersion,
  aiOperation,
  aiProviderAttempt,
  beginAiProviderAttempt,
  bootstrapWorkspace,
  channel,
  createAiMember,
  createDatabase,
  createKnowledgeBase,
  finishAiProviderAttempt,
  getAiBudget,
  getAiMemberConfig,
  knowledgeBase,
  listAiConfigVersions,
  listTeam,
  publishAiMemberConfig,
  recoverAiOperations,
  reserveAiOperation,
  restoreAiConfigVersion,
  saveAiBudget,
  setMemberChannelAccess,
  updateAiMemberConfig,
  updateMember,
  user,
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

  it('restores published reply settings and advertising tables, with legacy defaults', async () => {
    const f = await createFixture(db)
    const identity = { workspaceId: f.workspaceId, memberId: f.memberId, actingUserId: f.userId }
    await setMemberChannelAccess(db, { ...identity, channelIds: [f.channelId] })
    const original = [{ adId: '123', content: 'Original reference.' }]
    await updateAiMemberConfig(db, {
      ...identity,
      instructions: 'Be helpful.',
      responseLanguage: 'English',
      knowledgeBaseId: f.knowledgeBaseId,
      adLearningEnabled: true,
      adMappings: original,
      naturalToneEnabled: true,
      replyWaitEnabled: false,
    })
    const published = await publishAiMemberConfig(db, { ...identity, providerConfigured: true })
    const versionId = published.publishedVersionId as string
    await updateAiMemberConfig(db, {
      ...identity,
      adLearningEnabled: false,
      adMappings: [],
      naturalToneEnabled: false,
      replyWaitEnabled: true,
    })
    expect((await getAiMemberConfig(db, identity)).publishedSnapshot?.adMappings).toEqual(original)
    const restored = await restoreAiConfigVersion(db, { ...identity, versionId })
    expect(restored).toMatchObject({
      adLearningEnabled: true,
      adMappings: original,
      naturalToneEnabled: true,
      replyWaitEnabled: false,
    })
    const snapshot = published.publishedSnapshot
    if (!snapshot) throw new Error('No published snapshot')
    const {
      adLearningEnabled: _enabled,
      adMappings: _mappings,
      naturalToneEnabled: _tone,
      replyWaitEnabled: _wait,
      ...legacy
    } = snapshot
    const [old] = await db
      .insert(aiConfigVersion)
      .values({ memberId: f.memberId, snapshot: legacy })
      .returning()
    expect(await restoreAiConfigVersion(db, { ...identity, versionId: old.id })).toMatchObject({
      adLearningEnabled: false,
      adMappings: [],
      naturalToneEnabled: false,
      replyWaitEnabled: true,
      publishedSnapshot: snapshot,
    })
  })

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

    const identity = {
      workspaceId: fixture.workspaceId,
      memberId: fixture.memberId,
      actingUserId: fixture.userId,
    }
    const history = await listAiConfigVersions(db, identity)
    expect(history).toHaveLength(2)
    const original = history[1]
    if (!original) throw new Error('Original version was not recorded')
    const restored = await restoreAiConfigVersion(db, { ...identity, versionId: original.id })
    expect(restored.instructions).toBe('Answer from support facts only.')
    expect(restored.publishedSnapshot?.instructions).toBe('Use the updated support policy.')
    expect(restored.publishedVersionId).toBe(republished.publishedVersionId)
    expect(await listAiConfigVersions(db, identity)).toEqual(history)

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

  it('reserves a monthly hard limit concurrently and charges retries once', async () => {
    const f = await createFixture(db)
    const identity = { workspaceId: f.workspaceId, actingUserId: f.userId }
    await saveAiBudget(db, { ...identity, monthlyLimit: 1 })
    const id = randomUUID()
    const results = await Promise.allSettled(
      [id, randomUUID()].map((operationId) =>
        reserveAiOperation(db, { id: operationId, workspaceId: f.workspaceId, kind: 'TEST' }),
      ),
    )
    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
    const winner = results.find((r) => r.status === 'fulfilled')
    if (winner?.status !== 'fulfilled') throw new Error('No reservation')
    const operation = winner.value
    const first = await beginAiProviderAttempt(db, { operationId: operation.id, stage: 'LLM' })
    await finishAiProviderAttempt(db, { attemptId: first.id, state: 'FAILED', httpStatus: 429 })
    await reserveAiOperation(db, { id: operation.id, workspaceId: f.workspaceId, kind: 'TEST' })
    const retry = await beginAiProviderAttempt(db, {
      operationId: operation.id,
      stage: 'LLM',
      now: new Date(Date.now() + 31_000),
    })
    await finishAiProviderAttempt(db, { attemptId: retry.id, state: 'SUCCESS', httpStatus: 200 })
    expect(await getAiBudget(db, identity)).toMatchObject({ used: 1, reserved: 0, monthlyLimit: 1 })
    await expect(
      beginAiProviderAttempt(db, { operationId: operation.id, stage: 'LLM' }),
    ).rejects.toMatchObject({ code: 'OPERATION_PAUSED' })
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

  it('restores missing references as a repairable draft and serializes concurrent publications', async () => {
    const f = await createFixture(db)
    const identity = { workspaceId: f.workspaceId, memberId: f.memberId, actingUserId: f.userId }
    await setMemberChannelAccess(db, { ...identity, channelIds: [f.channelId] })
    await updateAiMemberConfig(db, {
      ...identity,
      knowledgeBaseId: f.knowledgeBaseId,
      instructions: 'Be helpful.',
      responseLanguage: 'English',
    })
    await Promise.all([
      publishAiMemberConfig(db, { ...identity, providerConfigured: true }),
      publishAiMemberConfig(db, { ...identity, providerConfigured: true }),
    ])
    const versions = await listAiConfigVersions(db, identity)
    expect(versions).toHaveLength(2)
    const version = versions[0]
    if (!version) throw new Error('No version')
    await db.delete(knowledgeBase).where(eq(knowledgeBase.id, f.knowledgeBaseId))
    expect((await listAiConfigVersions(db, identity))[0]?.invalidReferences).toEqual([
      'knowledgeBaseId',
    ])
    const restored = await restoreAiConfigVersion(db, { ...identity, versionId: version.id })
    expect(restored.knowledgeBaseId).toBeNull()
    expect(restored.publishedSnapshot?.knowledgeBaseId).toBe(f.knowledgeBaseId)
    await expect(
      publishAiMemberConfig(db, { ...identity, providerConfigured: true }),
    ).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' })
  })

  it('recovers unused reservations and interrupted attempts without refunding or repeating calls', async () => {
    const f = await createFixture(db)
    const now = new Date()
    const old = new Date(now.getTime() - 10 * 60_000)
    const unused = randomUUID()
    const started = randomUUID()
    await reserveAiOperation(db, { id: unused, workspaceId: f.workspaceId, kind: 'TEST', now: old })
    await reserveAiOperation(db, {
      id: started,
      workspaceId: f.workspaceId,
      kind: 'TEST',
      now: old,
    })
    await beginAiProviderAttempt(db, { operationId: started, stage: 'LLM', now: old })
    await recoverAiOperations(db, now)
    expect(
      await db
        .select({ state: aiOperation.state, charged: aiOperation.charged })
        .from(aiOperation)
        .where(eq(aiOperation.id, unused)),
    ).toEqual([{ state: 'CANCELLED', charged: false }])
    expect(
      await db
        .select({ state: aiOperation.state, charged: aiOperation.charged })
        .from(aiOperation)
        .where(eq(aiOperation.id, started)),
    ).toEqual([{ state: 'UNKNOWN', charged: true }])
    expect(
      await db
        .select({ state: aiProviderAttempt.state })
        .from(aiProviderAttempt)
        .where(eq(aiProviderAttempt.operationId, started)),
    ).toEqual([{ state: 'UNKNOWN' }])
    await expect(
      beginAiProviderAttempt(db, { operationId: started, stage: 'LLM' }),
    ).rejects.toMatchObject({ code: 'OPERATION_PAUSED' })
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
