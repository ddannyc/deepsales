import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  aiMemberConfig,
  aiResponseRun,
  autoAssignConversation,
  bootstrapWorkspace,
  claimAiResponseRun,
  connectFacebookPages,
  conversation,
  conversationAssignment,
  createAiMember,
  createDatabase,
  createInlineKnowledgeDocument,
  createInternalNote,
  createKnowledgeBase,
  member,
  message,
  processFacebookInbound,
  publishAiMemberConfig,
  setMemberChannelAccess,
  takeOverConversation,
  transferConversation,
  updateAiMemberConfig,
  user,
} from '@deepsales/db'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Pool } from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Bindings } from './bindings'
import { handleAiResponseBatch, handleDocumentsBatch, handleScheduled } from './index'

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

  it('uses the delivered options to retrieve and answer a second-option follow-up', async () => {
    const fixture = await createFixture(db)
    const queries: string[] = []
    const prompts: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(init?.body as string)
        if (String(input).endsWith('/embeddings')) {
          const texts = body.input as string[]
          return Response.json({
            data: texts.map((text, index) => {
              queries.push(text)
              const second =
                text.includes('Torch Two') &&
                (text.includes('second option') || !text.includes('Compare'))
              return { index, embedding: vector().map((_, i) => (i === (second ? 1 : 0) ? 1 : 0)) }
            }),
          })
        }
        const prompt = body.messages[1].content as string
        prompts.push(prompt)
        const second = prompt.includes('Does the second option come in blue?')
        const chunkId = /<knowledge_chunk id="([^"]+)">/.exec(prompt)?.[1]
        return Response.json({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  decision: 'ANSWER',
                  response: second
                    ? 'Torch Two comes in blue.'
                    : 'Option one is Torch One. Option two is Torch Two.',
                  handoffReason: null,
                  containsBusinessFacts: true,
                  usedChunkIds: chunkId ? [chunkId] : [],
                }),
              },
            },
          ],
        })
      }),
    )
    for (const text of ['Torch One comes in red.', 'Torch Two comes in blue.']) {
      const doc = await createInlineKnowledgeDocument(db, {
        workspaceId: fixture.workspaceId,
        knowledgeBaseId: fixture.knowledgeBaseId,
        createdByUserId: fixture.ownerId,
        name: text,
        text,
      })
      await handleDocumentsBatch(
        batch(
          'deepsales-documents',
          queueMessage({
            v: 1,
            type: 'knowledge.document',
            documentId: doc.id,
          }),
        ),
        environment(),
      )
    }
    const receive = async (text: string, now: Date) => {
      const result = await processFacebookInbound(db, {
        ingressId: crypto.randomUUID(),
        pageId: fixture.pageId,
        externalUserId: `customer-${fixture.ownerId}`,
        externalMessageId: crypto.randomUUID(),
        text,
        providerSentAt: now,
        receivedAt: now,
        payloadSha256: 'a'.repeat(64),
        eventFragment: {},
      })
      if (result.kind !== 'created') throw new Error('Inbound was not created')
      return result
    }
    const firstTime = new Date(Date.now() - 30_000)
    const first = await receive('Compare the available options.', firstTime)
    await createInternalNote(db, {
      workspaceId: fixture.workspaceId,
      userId: fixture.ownerId,
      conversationId: first.conversationId,
      clientKey: crypto.randomUUID(),
      text: 'Team-only instruction: arrange an internal review.',
    })
    const assigned = await autoAssignConversation(db, {
      workspaceId: fixture.workspaceId,
      conversationId: first.conversationId,
      now: firstTime,
    })
    await handleAiResponseBatch(
      batch(
        'deepsales-ai',
        queueMessage({
          v: 1,
          type: 'ai.response',
          runId: assigned.aiResponseRunId,
        }),
      ),
      environment(),
    )
    await db
      .update(message)
      .set({
        deliveryState: 'SENT',
        deliveryCompletedAt: new Date(),
      })
      .where(
        and(eq(message.conversationId, first.conversationId), eq(message.direction, 'OUTBOUND')),
      )
    const second = await receive(
      'Does the second option come in blue?',
      new Date(Date.now() - 10_000),
    )
    queries.length = 0
    prompts.length = 0
    await handleAiResponseBatch(
      batch(
        'deepsales-ai',
        queueMessage({
          v: 1,
          type: 'ai.response',
          runId: second.aiResponseRunId,
        }),
      ),
      environment(),
    )
    expect(queries).toHaveLength(1)
    expect(queries[0]).toContain('Option two is Torch Two.')
    expect(queries[0]).toContain('Does the second option come in blue?')
    expect(prompts[0]).toContain('Option two is Torch Two.')
    expect(prompts[0]).toContain('Torch Two comes in blue.')
    expect(prompts.join('\n')).not.toContain('Team-only instruction')
    expect(queries.join('\n')).not.toContain('Team-only instruction')
    expect(
      await db
        .select({ text: message.text })
        .from(message)
        .where(
          and(
            eq(message.conversationId, first.conversationId),
            eq(message.deliveryState, 'PENDING'),
          ),
        ),
    ).toEqual([{ text: 'Torch Two comes in blue.' }])
  })

  it('preserves human origin after transfer and excludes unsent, failed, foreign and later text', async () => {
    const fixture = await createFixture(db)
    const foreign = await createFixture(db)
    const first = await receiveContextInput(db, fixture, 'Which option should I choose?')
    const other = await receiveContextInput(db, foreign, 'FOREIGN SECRET')
    const sameWorkspace = await receiveContextInput(
      db,
      { ...fixture, ownerId: crypto.randomUUID() },
      'OTHER SECRET',
    )
    await db
      .update(message)
      .set({ createdAt: sql`'2025-12-31T23:59:59Z'::timestamptz` })
      .where(inArray(message.id, [other.messageId, sameWorkspace.messageId]))
    const [human] = await db
      .select({ id: member.id })
      .from(member)
      .where(and(eq(member.workspaceId, fixture.workspaceId), eq(member.type, 'HUMAN')))
    await setMemberChannelAccess(db, {
      workspaceId: fixture.workspaceId,
      actingUserId: fixture.ownerId,
      memberId: human.id,
      channelIds: [fixture.channelId],
    })
    await autoAssignConversation(db, {
      workspaceId: fixture.workspaceId,
      conversationId: first.conversationId,
      now: new Date(Date.now() - 10_000),
    })
    await takeOverConversation(db, {
      workspaceId: fixture.workspaceId,
      conversationId: first.conversationId,
      actingUserId: fixture.ownerId,
    })
    const sent = await db
      .insert(message)
      .values({
        conversationId: first.conversationId,
        channelId: fixture.channelId,
        direction: 'OUTBOUND',
        senderType: 'MEMBER',
        senderMemberId: human.id,
        messageType: 'TEXT',
        deliveryState: 'SENT',
        text: 'Do you prefer the compact Torch Two?',
        deliveryCompletedAt: new Date(),
      })
      .returning({ id: message.id })
    for (const deliveryState of ['PENDING', 'FAILED'] as const) {
      await db.insert(message).values({
        conversationId: first.conversationId,
        channelId: fixture.channelId,
        direction: 'OUTBOUND',
        senderType: 'MEMBER',
        senderMemberId: human.id,
        messageType: 'TEXT',
        deliveryState,
        text: `EXCLUDED ${deliveryState}`,
        createdAt: sql`'2026-01-01T00:00:00.000002Z'::timestamptz`,
      })
    }
    const current = await receiveContextInput(db, fixture, 'Yes, that one.')
    const transferred = await transferConversation(db, {
      workspaceId: fixture.workspaceId,
      conversationId: current.conversationId,
      actingUserId: fixture.ownerId,
      targetMemberId: fixture.aiMemberId,
    })
    // Distinct PostgreSQL microseconds must not collapse to JavaScript milliseconds.
    for (const [id, timestamp] of [
      [first.messageId, '2026-01-01T00:00:00.000001Z'],
      [sent[0].id, '2026-01-01T00:00:00.000002Z'],
      [current.messageId, '2026-01-01T00:00:00.000003Z'],
    ]) {
      await db
        .update(message)
        .set({ createdAt: sql`${timestamp}::timestamptz` })
        .where(eq(message.id, id))
    }
    await db
      .update(message)
      .set({ deliveryCompletedAt: sql`'2026-01-01T00:00:00.000002Z'::timestamptz` })
      .where(eq(message.id, sent[0].id))
    const tiedId = crypto.randomUUID()
    await db.insert(message).values([
      {
        id: tiedId,
        conversationId: current.conversationId,
        channelId: fixture.channelId,
        direction: 'OUTBOUND',
        senderType: 'MEMBER',
        senderMemberId: human.id,
        messageType: 'TEXT',
        deliveryState: 'SENT',
        text: 'A second human reply at the same timestamp',
        createdAt: sql`'2026-01-01T00:00:00.000002Z'::timestamptz`,
        deliveryCompletedAt: sql`'2026-01-01T00:00:00.000002Z'::timestamptz`,
      },
      {
        conversationId: current.conversationId,
        channelId: fixture.channelId,
        direction: 'OUTBOUND',
        senderType: 'MEMBER',
        senderMemberId: human.id,
        messageType: 'TEXT',
        deliveryState: 'SENT',
        text: 'EXCLUDED late completion',
        createdAt: sql`'2026-01-01T00:00:00.000002Z'::timestamptz`,
        deliveryCompletedAt: sql`'2026-01-01T00:00:00.000004Z'::timestamptz`,
      },
    ])
    await db.insert(message).values({
      conversationId: first.conversationId,
      channelId: fixture.channelId,
      direction: 'OUTBOUND',
      senderType: 'MEMBER',
      senderMemberId: human.id,
      messageType: 'TEXT',
      deliveryState: 'SENT',
      text: 'LATER SECRET',
    })
    // The late row must not redefine the claimed input; it simulates a delayed delivery record.
    await db
      .update(message)
      .set({ createdAt: new Date(Date.now() + 60_000) })
      .where(
        and(eq(message.text, 'LATER SECRET'), eq(message.conversationId, current.conversationId)),
      )
    expect(transferred.toMemberId).toBe(fixture.aiMemberId)
    const claimed = await claimAiResponseRun(db, {
      runId: transferred.aiResponseRunId as string,
      now: new Date(Date.now() + 3_000),
    })
    expect(claimed).toMatchObject({
      kind: 'CLAIMED',
      inputMessages: [{ id: current.messageId, text: 'Yes, that one.' }],
      history: [
        { id: first.messageId, origin: 'CUSTOMER', direction: 'INBOUND' },
        ...[sent[0].id, tiedId].sort().map((id) => ({
          id,
          origin: 'HUMAN',
          direction: 'OUTBOUND',
          senderMemberId: human.id,
        })),
      ],
    })
    expect(JSON.stringify(claimed)).not.toMatch(/EXCLUDED|SECRET/)
    expect(other.conversationId).not.toBe(current.conversationId)
  })

  it('retains 48 complete messages after a scan-boundary orphan reply and mixed captions', async () => {
    const fixture = await createFixture(db)
    const current = await receiveContextInput(db, fixture, 'What about that one?')
    const base = Date.now() - 60_000
    await db.insert(message).values({
      conversationId: current.conversationId,
      channelId: fixture.channelId,
      direction: 'OUTBOUND',
      senderType: 'MEMBER',
      senderMemberId: fixture.aiMemberId,
      messageType: 'TEXT',
      deliveryState: 'SENT',
      text: 'Orphan reply',
      createdAt: new Date(base),
    })
    for (let index = 0; index < 24; index++) {
      await db.insert(message).values([
        {
          conversationId: current.conversationId,
          channelId: fixture.channelId,
          direction: 'INBOUND',
          senderType: 'CUSTOMER',
          messageType: 'ATTACHMENT',
          text: `Caption-${index}`,
          createdAt: new Date(base + index * 100 + 1),
        },
        {
          conversationId: current.conversationId,
          channelId: fixture.channelId,
          direction: 'OUTBOUND',
          senderType: 'MEMBER',
          senderMemberId: fixture.aiMemberId,
          messageType: 'TEXT',
          deliveryState: 'SENT',
          text: `Reply-${index}`,
          createdAt: new Date(base + index * 100 + 2),
        },
      ])
    }
    const routed = await autoAssignConversation(db, {
      workspaceId: fixture.workspaceId,
      conversationId: current.conversationId,
      now: new Date(Date.now() - 10_000),
    })
    const claimed = await claimAiResponseRun(db, { runId: routed.aiResponseRunId as string })
    if (claimed?.kind !== 'CLAIMED') throw new Error('Run not claimed')
    expect(claimed.history).toHaveLength(48)
    expect(claimed.history[0]?.text).toBe('Caption-0')
    expect(claimed.history.at(-1)?.text).toBe('Reply-23')
  })

  it('keeps nearest complete turns within the Unicode history budget', async () => {
    const fixture = await createFixture(db)
    const current = await receiveContextInput(db, fixture, 'What about that one?')
    for (let index = 0; index < 30; index++) {
      const createdAt = new Date(Date.now() - 60_000 + index * 100)
      await db.insert(message).values([
        {
          conversationId: current.conversationId,
          channelId: fixture.channelId,
          direction: 'INBOUND',
          senderType: 'CUSTOMER',
          messageType: 'TEXT',
          text: `question-${index} ${'🙂'.repeat(300)}`,
          createdAt,
        },
        {
          conversationId: current.conversationId,
          channelId: fixture.channelId,
          direction: 'OUTBOUND',
          senderType: 'MEMBER',
          senderMemberId: fixture.aiMemberId,
          messageType: 'TEXT',
          deliveryState: 'SENT',
          text: `answer-${index} ${'🙂'.repeat(300)}`,
          createdAt: new Date(createdAt.getTime() + 1),
          deliveryCompletedAt: createdAt,
        },
      ])
    }
    const routed = await autoAssignConversation(db, {
      workspaceId: fixture.workspaceId,
      conversationId: current.conversationId,
      now: new Date(Date.now() - 10_000),
    })
    const claimed = await claimAiResponseRun(db, { runId: routed.aiResponseRunId as string })
    if (claimed?.kind !== 'CLAIMED') throw new Error('Run not claimed')
    expect(claimed.inputMessages).toMatchObject([{ text: 'What about that one?' }])
    expect(claimed.history.at(-1)?.text).toContain('answer-29')
    expect(claimed.history[0]?.origin).toBe('CUSTOMER')
    expect(claimed.history.some(({ text }) => text.startsWith('question-0 '))).toBe(false)
    expect(
      claimed.history.reduce((sum, { text }) => sum + Array.from(text).length, 0),
    ).toBeLessThanOrEqual(8_000)
    expect(claimed.history.length % 2).toBe(0)
  })

  it.each([8_000, 8_001])(
    'keeps %i current Unicode code points intact or safely hands off',
    async (size) => {
      const fixture = await createFixture(db)
      const current = await receiveContextInput(db, fixture, '🙂'.repeat(size))
      const routed = await autoAssignConversation(db, {
        workspaceId: fixture.workspaceId,
        conversationId: current.conversationId,
        now: new Date(Date.now() - 10_000),
      })
      const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(init?.body as string)
        expect(body.messages[1].content).toContain('🙂'.repeat(8_000))
        return Response.json({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  decision: 'ANSWER',
                  response: 'Could you clarify your question?',
                  handoffReason: null,
                  containsBusinessFacts: false,
                  usedChunkIds: [],
                }),
              },
            },
          ],
        })
      })
      vi.stubGlobal('fetch', fetcher)
      await handleAiResponseBatch(
        batch(
          'deepsales-ai',
          queueMessage({
            v: 1,
            type: 'ai.response',
            runId: routed.aiResponseRunId,
          }),
        ),
        environment(),
      )
      if (size === 8_000) expect(fetcher).toHaveBeenCalledOnce()
      else expect(fetcher).not.toHaveBeenCalled()
      expect(
        await db
          .select({ state: aiResponseRun.state, failureCode: aiResponseRun.failureCode })
          .from(aiResponseRun)
          .where(eq(aiResponseRun.id, routed.aiResponseRunId as string)),
      ).toEqual([
        {
          state: size === 8_000 ? 'COMPLETED' : 'HANDOFF',
          failureCode: size === 8_000 ? null : 'AI_INPUT_LIMIT',
        },
      ])
    },
  )

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

  it('answers a knowledge-free joke without handing off to a human', async () => {
    const fixture = await createFixture(db)
    const receivedAt = new Date(Date.now() - 10_000)
    const received = await processFacebookInbound(db, {
      ingressId: crypto.randomUUID(),
      pageId: fixture.pageId,
      externalUserId: `customer-${fixture.ownerId}`,
      externalMessageId: crypto.randomUUID(),
      text: '讲个笑话',
      providerSentAt: receivedAt,
      receivedAt,
      payloadSha256: 'a'.repeat(64),
      eventFragment: { text: '讲个笑话' },
    })
    if (received.kind !== 'created') throw new Error('Inbound message was not created')
    const routed = await autoAssignConversation(db, {
      workspaceId: fixture.workspaceId,
      conversationId: received.conversationId,
      now: receivedAt,
    })
    if (!routed.aiResponseRunId) throw new Error('AI response run was not created')

    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/embeddings')) {
        return Response.json({ data: [{ index: 0, embedding: vector() }] })
      }
      if (url.endsWith('/chat/completions')) {
        const body = JSON.parse(init?.body as string) as {
          messages: Array<{ content: string }>
        }
        const supportsKnowledgeFreeConversation = body.messages[0]?.content.includes(
          'For greetings, jokes, small talk, and other non-business requests, answer normally even when no knowledge chunks are available.',
        )
        return Response.json({
          choices: [
            {
              message: {
                content: JSON.stringify(
                  supportsKnowledgeFreeConversation
                    ? {
                        decision: 'ANSWER',
                        response: 'Here is a joke.',
                        handoffReason: null,
                        containsBusinessFacts: false,
                        usedChunkIds: [],
                      }
                    : {
                        decision: 'HANDOFF',
                        response: '',
                        handoffReason: 'NO_KNOWLEDGE',
                        containsBusinessFacts: false,
                        usedChunkIds: [],
                      },
                ),
              },
            },
          ],
        })
      }
      return new Response(null, { status: 404 })
    })
    vi.stubGlobal('fetch', fetcher)

    const outboundQueue = { send: vi.fn().mockResolvedValue(undefined) } as unknown as Queue
    const queued = queueMessage({ v: 1, type: 'ai.response', runId: routed.aiResponseRunId })
    await handleAiResponseBatch(batch('deepsales-ai', queued), environment(outboundQueue))

    expect(queued.ack).toHaveBeenCalledOnce()
    expect(queued.retry).not.toHaveBeenCalled()
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
    ).toEqual([{ text: 'Here is a joke.', senderMemberId: fixture.aiMemberId }])
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
        assigneeMemberId: fixture.aiMemberId,
        queueReason: null,
        routingConstraint: 'ANY_MEMBER',
      },
    ])
    expect(
      await db
        .select({ state: aiResponseRun.state, failureCode: aiResponseRun.failureCode })
        .from(aiResponseRun)
        .where(eq(aiResponseRun.id, routed.aiResponseRunId)),
    ).toEqual([{ state: 'COMPLETED', failureCode: null }])
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

  it('retries transient runtime failures without disabling the AI member', async () => {
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

    expect(queued.ack).not.toHaveBeenCalled()
    expect(queued.retry).toHaveBeenCalledOnce()
    expect(
      await db
        .select({ state: aiResponseRun.state, startedAt: aiResponseRun.startedAt })
        .from(aiResponseRun)
        .where(eq(aiResponseRun.id, routed.aiResponseRunId)),
    ).toEqual([{ state: 'QUEUED', startedAt: null }])
    expect(
      await db
        .select({ runtimeStatus: aiMemberConfig.runtimeStatus })
        .from(aiMemberConfig)
        .where(eq(aiMemberConfig.memberId, fixture.aiMemberId)),
    ).toEqual([{ runtimeStatus: 'USABLE' }])
  })

  it('hands off stale generations during scheduled recovery', async () => {
    const fixture = await createFixture(db)
    const receivedAt = new Date(Date.now() - 10_000)
    const received = await processFacebookInbound(db, {
      ingressId: crypto.randomUUID(),
      pageId: fixture.pageId,
      externalUserId: `customer-${fixture.ownerId}`,
      externalMessageId: crypto.randomUUID(),
      text: 'Please recover this run.',
      providerSentAt: receivedAt,
      receivedAt,
      payloadSha256: 'a'.repeat(64),
      eventFragment: { text: 'Please recover this run.' },
    })
    if (received.kind !== 'created') throw new Error('Inbound message was not created')
    const routed = await autoAssignConversation(db, {
      workspaceId: fixture.workspaceId,
      conversationId: received.conversationId,
      now: receivedAt,
    })
    if (!routed.aiResponseRunId) throw new Error('AI response run was not created')

    const claimed = await claimAiResponseRun(db, {
      runId: routed.aiResponseRunId,
      now: new Date(),
    })
    if (claimed?.kind !== 'CLAIMED') throw new Error('AI response run was not claimed')
    const staleStartedAt = new Date(Date.now() - 6 * 60 * 1_000)
    await db
      .update(aiResponseRun)
      .set({ startedAt: staleStartedAt, updatedAt: staleStartedAt })
      .where(eq(aiResponseRun.id, routed.aiResponseRunId))

    await handleScheduled(environment())

    expect(
      await db
        .select({ state: aiResponseRun.state, failureCode: aiResponseRun.failureCode })
        .from(aiResponseRun)
        .where(eq(aiResponseRun.id, routed.aiResponseRunId)),
    ).toEqual([{ state: 'FAILED', failureCode: 'AI_GENERATION_TIMEOUT' }])
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
      { assigneeMemberId: null, queueReason: 'AI_HANDOFF', routingConstraint: 'HUMAN_ONLY' },
    ])
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
    channelId: channel.id,
  }
}

async function receiveContextInput(
  db: ReturnType<typeof createDatabase>,
  fixture: Awaited<ReturnType<typeof createFixture>>,
  text: string,
) {
  const receivedAt = new Date(Date.now() - 10_000)
  const result = await processFacebookInbound(db, {
    ingressId: crypto.randomUUID(),
    pageId: fixture.pageId,
    externalUserId: `customer-${fixture.ownerId}`,
    externalMessageId: crypto.randomUUID(),
    text,
    providerSentAt: receivedAt,
    receivedAt,
    payloadSha256: 'a'.repeat(64),
    eventFragment: {},
  })
  if (result.kind !== 'created') throw new Error('Inbound was not created')
  return result
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
