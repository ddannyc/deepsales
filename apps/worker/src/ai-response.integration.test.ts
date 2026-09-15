import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  aiMemberConfig,
  aiResponseRun,
  autoAssignConversation,
  bootstrapWorkspace,
  connectFacebookPages,
  conversation,
  conversationAssignment,
  createAiMember,
  createDatabase,
  createInlineKnowledgeDocument,
  createKnowledgeBase,
  message,
  processFacebookInbound,
  publishAiMemberConfig,
  updateAiMemberConfig,
  user,
} from '@deepsales/db'
import { and, eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Pool } from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Bindings } from './bindings'
import { handleAiResponseBatch, handleDocumentsBatch } from './index'

const connectionString = process.env.DATABASE_URL
const migrationsFolder = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../packages/db/drizzle',
)

describe.skipIf(!connectionString)('AI response Worker consumer', () => {
  const pool = new Pool({ connectionString })
  const db = createDatabase(pool)

  beforeAll(async () => {
    await migrate(db, { migrationsFolder })
  })

  afterAll(() => pool.end())
  afterEach(() => vi.unstubAllGlobals())

  it('retrieves published knowledge, commits a grounded response, and queues delivery', async () => {
    const fixture = await createFixture(db)
    const document = await createInlineKnowledgeDocument(db, {
      workspaceId: fixture.workspaceId,
      knowledgeBaseId: fixture.knowledgeBaseId,
      createdByUserId: fixture.ownerId,
      name: 'Shipping',
      text: 'Shipping is free.',
    })
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/embeddings')) {
        return Response.json({ data: [{ index: 0, embedding: vector() }] })
      }
      if (url.endsWith('/chat/completions')) {
        const body = JSON.parse(init?.body as string) as {
          messages: Array<{ content: string }>
        }
        const chunkId = /<knowledge_chunk id="([^"]+)">/.exec(body.messages[1]?.content ?? '')?.[1]
        return Response.json({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  decision: 'ANSWER',
                  response: 'Shipping is free.',
                  handoffReason: null,
                  containsBusinessFacts: true,
                  usedChunkIds: chunkId ? [chunkId] : [],
                }),
              },
            },
          ],
        })
      }
      return new Response(null, { status: 404 })
    })
    vi.stubGlobal('fetch', fetcher)

    const documentMessage = queueMessage({
      v: 1,
      type: 'knowledge.document',
      documentId: document.id,
    })
    await handleDocumentsBatch(batch('deepsales-documents', documentMessage), environment())

    const receivedAt = new Date(Date.now() - 10_000)
    const received = await processFacebookInbound(db, {
      ingressId: crypto.randomUUID(),
      pageId: fixture.pageId,
      externalUserId: `customer-${fixture.ownerId}`,
      externalMessageId: crypto.randomUUID(),
      text: 'How much is shipping?',
      providerSentAt: receivedAt,
      receivedAt,
      payloadSha256: 'a'.repeat(64),
      eventFragment: { text: 'How much is shipping?' },
    })
    if (received.kind !== 'created') throw new Error('Inbound message was not created')
    const routed = await autoAssignConversation(db, {
      workspaceId: fixture.workspaceId,
      conversationId: received.conversationId,
      now: receivedAt,
    })
    if (!routed.aiResponseRunId) throw new Error('AI response run was not created')

    const aiMessages = [
      queueMessage({ v: 1, type: 'ai.response', runId: routed.aiResponseRunId }),
      queueMessage({ v: 1, type: 'ai.response', runId: routed.aiResponseRunId }),
    ]
    const outboundQueue = { send: vi.fn().mockResolvedValue(undefined) } as unknown as Queue
    await Promise.all(
      aiMessages.map((aiMessage) =>
        handleAiResponseBatch(batch('deepsales-ai', aiMessage), environment(outboundQueue)),
      ),
    )

    for (const aiMessage of aiMessages) {
      expect(aiMessage.ack).toHaveBeenCalledOnce()
      expect(aiMessage.retry).not.toHaveBeenCalled()
    }
    expect(
      fetcher.mock.calls.filter(([url]) => String(url).endsWith('/chat/completions')),
    ).toHaveLength(1)
    expect(outboundQueue.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'facebook.outbound' }),
    )
    const [run] = await db
      .select({ state: aiResponseRun.state, retrievedChunkIds: aiResponseRun.retrievedChunkIds })
      .from(aiResponseRun)
      .where(eq(aiResponseRun.id, routed.aiResponseRunId))
    expect(run?.state).toBe('COMPLETED')
    expect(run?.retrievedChunkIds).toHaveLength(1)
    expect(
      await db
        .select({ text: message.text, deliveryState: message.deliveryState })
        .from(message)
        .where(
          and(
            eq(message.conversationId, received.conversationId),
            eq(message.senderMemberId, fixture.aiMemberId),
          ),
        ),
    ).toEqual([{ text: 'Shipping is free.', deliveryState: 'PENDING' }])
  })

  it('retries an AI queue delivery until the debounce delay elapses', async () => {
    const fixture = await createFixture(db)
    const received = await processFacebookInbound(db, {
      ingressId: crypto.randomUUID(),
      pageId: fixture.pageId,
      externalUserId: `customer-${fixture.ownerId}`,
      externalMessageId: crypto.randomUUID(),
      text: 'wait for debounce',
      providerSentAt: new Date(),
      receivedAt: new Date(),
      payloadSha256: 'a'.repeat(64),
      eventFragment: { text: 'wait for debounce' },
    })
    if (received.kind !== 'created') throw new Error('Inbound message was not created')
    const routed = await autoAssignConversation(db, {
      workspaceId: fixture.workspaceId,
      conversationId: received.conversationId,
    })
    if (!routed.aiResponseRunId) throw new Error('AI response run was not created')
    await db
      .update(aiResponseRun)
      .set({ scheduledFor: new Date(Date.now() + 10_000) })
      .where(eq(aiResponseRun.id, routed.aiResponseRunId))

    const aiMessage = queueMessage({ v: 1, type: 'ai.response', runId: routed.aiResponseRunId })
    await handleAiResponseBatch(batch('deepsales-ai', aiMessage), environment())

    expect(aiMessage.ack).not.toHaveBeenCalled()
    expect(aiMessage.retry).toHaveBeenCalledWith({ delaySeconds: expect.any(Number) })
  })

  it('hands off an explicit human request before invoking the model', async () => {
    const fixture = await createFixture(db)
    const receivedAt = new Date(Date.now() - 10_000)
    const received = await processFacebookInbound(db, {
      ingressId: crypto.randomUUID(),
      pageId: fixture.pageId,
      externalUserId: `customer-${fixture.ownerId}`,
      externalMessageId: crypto.randomUUID(),
      text: 'I need to speak to a human, please.',
      providerSentAt: receivedAt,
      receivedAt,
      payloadSha256: 'a'.repeat(64),
      eventFragment: { text: 'I need to speak to a human, please.' },
    })
    if (received.kind !== 'created') throw new Error('Inbound message was not created')
    const routed = await autoAssignConversation(db, {
      workspaceId: fixture.workspaceId,
      conversationId: received.conversationId,
      now: receivedAt,
    })
    if (!routed.aiResponseRunId) throw new Error('AI response run was not created')

    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    const outboundQueue = { send: vi.fn().mockResolvedValue(undefined) } as unknown as Queue
    const maintenanceQueue = { send: vi.fn().mockResolvedValue(undefined) } as unknown as Queue
    const queued = queueMessage({ v: 1, type: 'ai.response', runId: routed.aiResponseRunId })
    await handleAiResponseBatch(
      batch('deepsales-ai', queued),
      environment(outboundQueue, maintenanceQueue),
    )

    expect(fetcher).not.toHaveBeenCalled()
    expect(queued.ack).toHaveBeenCalledOnce()
    expect(queued.retry).not.toHaveBeenCalled()
    expect(outboundQueue.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'facebook.outbound' }),
    )
    expect(maintenanceQueue.send).toHaveBeenCalledWith({
      v: 1,
      type: 'routing.conversation',
      workspaceId: fixture.workspaceId,
      conversationId: received.conversationId,
    })
    expect(
      await db
        .select({
          assigneeMemberId: conversation.assigneeMemberId,
          queueReason: conversation.queueReason,
          routingConstraint: conversation.routingConstraint,
        })
        .from(conversation)
        .where(eq(conversation.id, received.conversationId)),
    ).toEqual([
      {
        assigneeMemberId: null,
        queueReason: 'AI_HANDOFF',
        routingConstraint: 'HUMAN_ONLY',
      },
    ])
    expect(
      await db
        .select({ reason: conversationAssignment.reason })
        .from(conversationAssignment)
        .where(eq(conversationAssignment.conversationId, received.conversationId)),
    ).toEqual([{ reason: 'AUTO_ROUTE' }, { reason: 'AI_HANDOFF' }])
  })

  it('uses a factual-free fallback when a structured handoff policy is disabled', async () => {
    const fixture = await createFixture(db)
    const receivedAt = new Date(Date.now() - 10_000)
    await updateAiMemberConfig(db, {
      workspaceId: fixture.workspaceId,
      memberId: fixture.aiMemberId,
      actingUserId: fixture.ownerId,
      handoffOnNegativeSentiment: false,
    })
    await publishAiMemberConfig(db, {
      workspaceId: fixture.workspaceId,
      memberId: fixture.aiMemberId,
      actingUserId: fixture.ownerId,
      providerConfigured: true,
    })
    const received = await processFacebookInbound(db, {
      ingressId: crypto.randomUUID(),
      pageId: fixture.pageId,
      externalUserId: `customer-${fixture.ownerId}`,
      externalMessageId: crypto.randomUUID(),
      text: 'This is terrible.',
      providerSentAt: receivedAt,
      receivedAt,
      payloadSha256: 'a'.repeat(64),
      eventFragment: { text: 'This is terrible.' },
    })
    if (received.kind !== 'created') throw new Error('Inbound message was not created')
    const routed = await autoAssignConversation(db, {
      workspaceId: fixture.workspaceId,
      conversationId: received.conversationId,
      now: receivedAt,
    })
    if (!routed.aiResponseRunId) throw new Error('AI response run was not created')

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).endsWith('/chat/completions')
          ? Response.json({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      decision: 'HANDOFF',
                      response: '',
                      handoffReason: 'NEGATIVE_SENTIMENT',
                      containsBusinessFacts: false,
                      usedChunkIds: [],
                    }),
                  },
                },
              ],
            })
          : new Response(null, { status: 404 }),
      ),
    )
    const outboundQueue = { send: vi.fn().mockResolvedValue(undefined) } as unknown as Queue
    const queued = queueMessage({ v: 1, type: 'ai.response', runId: routed.aiResponseRunId })
    await handleAiResponseBatch(batch('deepsales-ai', queued), environment(outboundQueue))

    expect(queued.ack).toHaveBeenCalledOnce()
    expect(outboundQueue.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'facebook.outbound' }),
    )
    expect(
      await db
        .select({ text: message.text, senderMemberId: message.senderMemberId })
        .from(message)
        .where(
          and(
            eq(message.conversationId, received.conversationId),
            eq(message.senderMemberId, fixture.aiMemberId),
          ),
        ),
    ).toEqual([
      {
        text: "I don't have enough information to answer that accurately.",
        senderMemberId: fixture.aiMemberId,
      },
    ])
    expect(
      await db
        .select({ state: aiResponseRun.state })
        .from(aiResponseRun)
        .where(eq(aiResponseRun.id, routed.aiResponseRunId)),
    ).toEqual([{ state: 'COMPLETED' }])
  })

  it('hands off transient runtime failures without disabling the AI member', async () => {
    const fixture = await createFixture(db)
    const receivedAt = new Date(Date.now() - 10_000)
    const received = await processFacebookInbound(db, {
      ingressId: crypto.randomUUID(),
      pageId: fixture.pageId,
      externalUserId: `customer-${fixture.ownerId}`,
      externalMessageId: crypto.randomUUID(),
      text: 'The provider is unavailable.',
      providerSentAt: receivedAt,
      receivedAt,
      payloadSha256: 'a'.repeat(64),
      eventFragment: { text: 'The provider is unavailable.' },
    })
    if (received.kind !== 'created') throw new Error('Inbound message was not created')
    const routed = await autoAssignConversation(db, {
      workspaceId: fixture.workspaceId,
      conversationId: received.conversationId,
      now: receivedAt,
    })
    if (!routed.aiResponseRunId) throw new Error('AI response run was not created')
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('temporary network failure')))

    const queued = queueMessage({ v: 1, type: 'ai.response', runId: routed.aiResponseRunId })
    await handleAiResponseBatch(batch('deepsales-ai', queued), environment())

    expect(queued.ack).toHaveBeenCalledOnce()
    expect(queued.retry).not.toHaveBeenCalled()
    expect(
      await db
        .select({ state: aiResponseRun.state })
        .from(aiResponseRun)
        .where(eq(aiResponseRun.id, routed.aiResponseRunId)),
    ).toEqual([{ state: 'FAILED' }])
    expect(
      await db
        .select({ runtimeStatus: aiMemberConfig.runtimeStatus })
        .from(aiMemberConfig)
        .where(eq(aiMemberConfig.memberId, fixture.aiMemberId)),
    ).toEqual([{ runtimeStatus: 'USABLE' }])
  })

  it('marks the AI runtime unhealthy for permanent provider configuration failures', async () => {
    const fixture = await createFixture(db)
    const receivedAt = new Date(Date.now() - 10_000)
    const received = await processFacebookInbound(db, {
      ingressId: crypto.randomUUID(),
      pageId: fixture.pageId,
      externalUserId: `customer-${fixture.ownerId}`,
      externalMessageId: crypto.randomUUID(),
      text: 'Can you help me?',
      providerSentAt: receivedAt,
      receivedAt,
      payloadSha256: 'a'.repeat(64),
      eventFragment: { text: 'Can you help me?' },
    })
    if (received.kind !== 'created') throw new Error('Inbound message was not created')
    const routed = await autoAssignConversation(db, {
      workspaceId: fixture.workspaceId,
      conversationId: received.conversationId,
      now: receivedAt,
    })
    if (!routed.aiResponseRunId) throw new Error('AI response run was not created')

    const queued = queueMessage({ v: 1, type: 'ai.response', runId: routed.aiResponseRunId })
    await handleAiResponseBatch(batch('deepsales-ai', queued), { ...environment(), AI_API_KEY: '' })

    expect(queued.ack).toHaveBeenCalledOnce()
    expect(queued.retry).not.toHaveBeenCalled()
    expect(
      await db
        .select({ state: aiResponseRun.state, failureCode: aiResponseRun.failureCode })
        .from(aiResponseRun)
        .where(eq(aiResponseRun.id, routed.aiResponseRunId)),
    ).toEqual([{ state: 'FAILED', failureCode: 'AI_PROVIDER_ERROR' }])
    expect(
      await db
        .select({ runtimeStatus: aiMemberConfig.runtimeStatus })
        .from(aiMemberConfig)
        .where(eq(aiMemberConfig.memberId, fixture.aiMemberId)),
    ).toEqual([{ runtimeStatus: 'UNHEALTHY' }])
  })
})

async function createFixture(db: ReturnType<typeof createDatabase>) {
  const ownerId = crypto.randomUUID()
  const pageId = crypto.randomUUID()
  await db.insert(user).values({ id: ownerId, name: 'Owner', email: `${ownerId}@example.com` })
  const workspace = await bootstrapWorkspace(db, {
    userId: ownerId,
    userName: 'Owner',
    name: `AI response worker ${ownerId}`,
  })
  const [channel] = await connectFacebookPages(db, {
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
  if (!channel) throw new Error('Channel was not created')
  const base = await createKnowledgeBase(db, {
    workspaceId: workspace.id,
    createdByUserId: ownerId,
    name: 'Support facts',
  })
  const ai = await createAiMember(db, {
    workspaceId: workspace.id,
    createdByUserId: ownerId,
    displayName: 'Support AI',
    channelIds: [channel.id],
  })
  await updateAiMemberConfig(db, {
    workspaceId: workspace.id,
    memberId: ai.id,
    actingUserId: ownerId,
    instructions: 'Answer from support facts.',
    responseLanguage: 'English',
    knowledgeBaseId: base.id,
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
    knowledgeBaseId: base.id,
    aiMemberId: ai.id,
  }
}

function environment(outboundQueue?: Queue, maintenanceQueue?: Queue): Bindings {
  return {
    APP_URL: 'http://localhost:8787',
    AUTH_RATE_LIMITER: {} as RateLimit,
    BETTER_AUTH_SECRET: 'test-only-secret-that-is-at-least-32-characters',
    HYPERDRIVE: { connectionString } as Hyperdrive,
    META_APP_ID: 'app-1',
    META_APP_SECRET: 'app-secret',
    META_VERIFY_TOKEN: 'verify-token',
    META_GRAPH_API_VERSION: 'v26.0',
    TOKEN_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    AI_API_KEY: 'test-key',
    AI_BASE_URL: 'http://ai.test/v1',
    EMBEDDING_PROVIDER: 'alibaba',
    EMBEDDING_MODEL: 'qwen3.7-text-embedding',
    EMBEDDING_DIMENSIONS: '1536',
    LLM_PROVIDER: 'alibaba',
    LLM_MODEL: 'qwen3.8-flash',
    OUTBOUND_QUEUE: outboundQueue,
    MAINTENANCE_QUEUE: maintenanceQueue,
  }
}

function batch(queue: string, message: ReturnType<typeof queueMessage>) {
  return { queue, messages: [message] } as unknown as MessageBatch<unknown>
}

function queueMessage(body: unknown) {
  return {
    body,
    ack: vi.fn(),
    retry: vi.fn(),
  }
}

function vector() {
  return Array.from({ length: 1_536 }, (_value, index) => (index === 0 ? 1 : 0))
}
