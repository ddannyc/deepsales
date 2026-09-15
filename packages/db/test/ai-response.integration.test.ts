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
  commitAiResponse,
  connectFacebookPages,
  createAiMember,
  createDatabase,
  createKnowledgeBase,
  listConversations,
  message,
  processFacebookInbound,
  publishAiMemberConfig,
  recoverStaleAiResponseRuns,
  takeOverConversation,
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
          and query ilike '%conversation%'
          and query ilike '%for update%'`,
    )
    if (Number(result.rows[0]?.count ?? 0) >= expected) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Expected ${expected} conversation lock waiters`)
}
