import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  bootstrapWorkspace,
  campaign,
  campaignRecipient,
  campaignRun,
  channelIdentity,
  connectFacebookPages,
  conversation,
  createDatabase,
  customer,
  facebookMessagingWindow,
  getAiBudget,
  mediaAsset,
  member,
  message,
  processFacebookInbound,
  type readCampaign,
  setMemberChannelAccess,
} from '@deepsales/db'
import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Pool } from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createAuth } from './auth'
import type { Bindings } from './bindings'
import { encryptFacebookToken } from './facebook'
import { app, handleOutboundBatch, handleScheduled } from './index'

const connectionString = process.env.DATABASE_URL
const pool = new Pool({ connectionString })
const db = createDatabase(pool)
const tokenKey = btoa(String.fromCharCode(...new Uint8Array(32)))
const env = {
  APP_URL: 'http://localhost:8787',
  AUTH_RATE_LIMITER: { limit: async () => ({ success: true }) },
  BETTER_AUTH_SECRET: 'test-only-secret-that-is-at-least-32-characters',
  HYPERDRIVE: { connectionString },
  META_APP_ID: 'test-app',
  META_APP_SECRET: 'test-app-secret',
  META_GRAPH_API_VERSION: 'v26.0',
  TOKEN_ENCRYPTION_KEY: tokenKey,
  AI_BASE_URL: 'https://ai.example.com',
  AI_API_KEY: 'test-key',
  LLM_PROVIDER: 'alibaba',
  LLM_MODEL: 'qwen3.8-flash',
} as unknown as Bindings

describe.skipIf(!connectionString)('ordinary campaigns', () => {
  beforeAll(() =>
    migrate(db, {
      migrationsFolder: resolve(
        dirname(fileURLToPath(import.meta.url)),
        '../../../packages/db/drizzle',
      ),
    }),
  )
  afterAll(() => pool.end())
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('saves an explicit deduplicated audience without sending, then executes once without taking ownership', async () => {
    const f = await fixture()
    const id = crypto.randomUUID()
    const created = await f.call('', 'POST', {
      id,
      name: 'Neutral update',
      channelId: f.channelId,
      identityIds: [f.identityId, f.identityId],
      text: 'The library closes at five.',
    })
    expect(created.status).toBe(201)
    expect(await created.json()).toMatchObject({
      campaign: { id, status: 'DRAFT', identityIds: [f.identityId] },
    })
    expect(
      (await db.select().from(message).where(eq(message.conversationId, f.conversationId))).length,
    ).toBe(1)
    expect((await f.call(`/${id}/execute`, 'POST', {})).status).toBe(200)
    expect((await f.call(`/${id}/execute`, 'POST', {})).status).toBe(200)
    const queued: unknown[] = []
    await handleScheduled({
      ...env,
      OUTBOUND_QUEUE: {
        send: async (body: unknown) => {
          queued.push(body)
        },
      } as unknown as Queue,
    })
    const pending = await db
      .select()
      .from(message)
      .where(eq(message.conversationId, f.conversationId))
    expect(pending.filter((m) => m.direction === 'OUTBOUND')).toHaveLength(1)
    const reply = pending.find((m) => m.direction === 'OUTBOUND')
    if (!reply) throw new Error('Campaign message missing')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ message_id: 'neutral-reply' })),
    )
    const item = () => ({
      body: { v: 1, type: 'facebook.outbound', messageId: reply.id },
      ack: vi.fn(),
      retry: vi.fn(),
    })
    await handleOutboundBatch({ messages: [item()] } as unknown as MessageBatch<unknown>, env)
    await handleOutboundBatch({ messages: [item()] } as unknown as MessageBatch<unknown>, env)
    expect(globalThis.fetch).toHaveBeenCalledOnce()
    const provider = vi.mocked(globalThis.fetch)
    expect(JSON.parse(String(provider.mock.calls[0]?.[1]?.body))).toMatchObject({
      messaging_type: 'UPDATE',
    })
    expect(await (await f.call(`/${id}`, 'GET')).json()).toMatchObject({
      runs: [{ recipients: [{ state: 'SUCCESS' }] }],
    })
    const [current] = await db
      .select()
      .from(conversation)
      .where(eq(conversation.id, f.conversationId))
    expect(current.assigneeMemberId).toBeNull()
    expect(queued).toContainEqual({ v: 1, type: 'facebook.outbound', messageId: reply.id })
  })

  it('rechecks authorization and the normal window at delivery without sending revoked messages', async () => {
    for (const revoke of ['ACCESS', 'WINDOW']) {
      const f = await fixture()
      const id = crypto.randomUUID()
      expect(
        (
          await f.call('', 'POST', {
            id,
            name: 'Permission check',
            channelId: f.channelId,
            identityIds: [f.identityId],
            text: 'Neutral update',
          })
        ).status,
      ).toBe(201)
      expect((await f.call(`/${id}/execute`, 'POST', {})).status).toBe(200)
      const messages = await db
        .select()
        .from(message)
        .where(eq(message.conversationId, f.conversationId))
      const reply = messages.find((m) => m.direction === 'OUTBOUND')
      if (!reply) throw new Error('Missing outbound')
      if (revoke === 'ACCESS')
        await setMemberChannelAccess(db, {
          workspaceId: f.workspaceId,
          memberId: f.memberId,
          actingUserId: f.userId,
          channelIds: [],
        })
      else
        await db
          .update(facebookMessagingWindow)
          .set({ eligibleUntil: new Date(0) })
          .where(eq(facebookMessagingWindow.channelIdentityId, f.identityId))
      const fetcher = vi.fn()
      vi.stubGlobal('fetch', fetcher)
      await handleOutboundBatch(
        {
          messages: [
            {
              body: { v: 1, type: 'facebook.outbound', messageId: reply.id },
              ack: vi.fn(),
              retry: vi.fn(),
            },
          ],
        } as unknown as MessageBatch<unknown>,
        env,
      )
      expect(fetcher).not.toHaveBeenCalled()
      const [failed] = await db.select().from(message).where(eq(message.id, reply.id))
      expect(failed.deliveryState).toBe('FAILED')
      expect(failed.failureCode).toBe('CAMPAIGN_NOT_PERMITTED')
    }
  })

  it('rejects foreign identities and serializes concurrent execution against the saved audience', async () => {
    const f = await fixture()
    const foreign = await fixture()
    const id = crypto.randomUUID()
    const input = {
      id,
      name: 'Concurrent update',
      channelId: f.channelId,
      identityIds: [f.identityId],
      text: 'Neutral update',
    }
    expect((await f.call('', 'POST', { ...input, identityIds: [foreign.identityId] })).status).toBe(
      400,
    )
    expect((await f.call('', 'POST', input)).status).toBe(201)
    const executions = await Promise.all([
      f.call(`/${id}/execute`, 'POST', {}),
      f.call(`/${id}/execute`, 'POST', {}),
    ])
    expect(executions.map((r) => r.status)).toEqual([200, 200])
    expect(await (await f.call(`/${id}`)).json()).toMatchObject({
      runs: [{ recipients: [{ channelIdentityId: f.identityId, state: 'WAITING' }] }],
    })
    const messages = await db
      .select()
      .from(message)
      .where(eq(message.conversationId, f.conversationId))
    expect(messages.filter((m) => m.direction === 'OUTBOUND')).toHaveLength(1)
  })

  it('persists a provider retry deadline so duplicate deliveries cannot bypass channel backoff', async () => {
    const f = await fixture()
    const id = crypto.randomUUID()
    await f.call('', 'POST', {
      id,
      name: 'Backoff',
      channelId: f.channelId,
      identityIds: [f.identityId],
      text: 'Neutral update',
    })
    await f.call(`/${id}/execute`, 'POST', {})
    const messages = await db
      .select()
      .from(message)
      .where(eq(message.conversationId, f.conversationId))
    const reply = messages.find((m) => m.direction === 'OUTBOUND')
    if (!reply) throw new Error('Missing reply')
    const fetcher = vi.fn(async () =>
      Response.json(
        { error: { message: 'Slow down', code: 4 } },
        { status: 429, headers: { 'Retry-After': '300' } },
      ),
    )
    vi.stubGlobal('fetch', fetcher)
    const item = () => ({
      body: { v: 1, type: 'facebook.outbound', messageId: reply.id },
      ack: vi.fn(),
      retry: vi.fn(),
    })
    await handleOutboundBatch({ messages: [item()] } as unknown as MessageBatch<unknown>, env)
    const duplicate = item()
    await handleOutboundBatch({ messages: [duplicate] } as unknown as MessageBatch<unknown>, env)
    expect(fetcher).toHaveBeenCalledOnce()
    expect(duplicate.retry).toHaveBeenCalledWith({ delaySeconds: expect.any(Number) })
  })

  it('pauses unknown translations visibly and never regenerates or sends them on duplicate scans', async () => {
    const f = await fixture()
    const id = crypto.randomUUID()
    await f.call('', 'POST', {
      id,
      name: 'Translation pause',
      channelId: f.channelId,
      identityIds: [f.identityId],
      text: 'Neutral update',
      targetLanguage: 'en',
    })
    const fetcher = vi.fn(async () => {
      throw new Error('Unknown transport result')
    })
    vi.stubGlobal('fetch', fetcher)
    await f.call(`/${id}/execute`, 'POST', {})
    await handleScheduled(env)
    expect(fetcher).toHaveBeenCalledOnce()
    expect(await (await f.call(`/${id}`)).json()).toMatchObject({
      campaign: { status: 'PAUSED' },
      runs: [{ recipients: [{ state: 'UNKNOWN' }] }],
    })
    expect(
      (await db.select().from(message).where(eq(message.conversationId, f.conversationId))).filter(
        (m) => m.direction === 'OUTBOUND',
      ),
    ).toHaveLength(0)
  })

  it('keeps random choices stable and sends all rich blocks in order with committed media surviving cancellation', async () => {
    const f = await fixture()
    const assetId = crypto.randomUUID()
    await db.insert(mediaAsset).values({
      id: assetId,
      workspaceId: f.workspaceId,
      title: 'Neutral file',
      filename: 'note.txt',
      kind: 'FILE',
      mimeType: 'text/plain',
      byteSize: 4,
      sha256: 'b'.repeat(64),
      storageKey: `campaign/${assetId}`,
    })
    const id = crypto.randomUUID()
    const blocks = [
      { id: crypto.randomUUID(), text: 'First notice' },
      { id: crypto.randomUUID(), assetId },
    ]
    await f.call('', 'POST', {
      id,
      name: 'Ordered rich update',
      channelId: f.channelId,
      identityIds: [f.identityId],
      content: blocks,
    })
    await f.call(`/${id}/execute`, 'POST', {})
    const first = (
      await db.select().from(message).where(eq(message.conversationId, f.conversationId))
    ).find((m) => m.direction === 'OUTBOUND')
    if (!first) throw new Error('Missing first block')
    const fetcher = vi.fn(async (url: unknown) =>
      String(url).endsWith('/message_attachments')
        ? Response.json({ attachment_id: 'neutral-upload' })
        : Response.json({ message_id: crypto.randomUUID() }),
    )
    vi.stubGlobal('fetch', fetcher)
    await deliver(first.id)
    await handleScheduled(env)
    expect(
      (await db.select().from(message).where(eq(message.conversationId, f.conversationId))).filter(
        (m) => m.direction === 'OUTBOUND',
      ),
    ).toHaveLength(1)
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(Date.now() + 2000))
    await handleScheduled(env)
    const outbound = (
      await db.select().from(message).where(eq(message.conversationId, f.conversationId))
    ).filter((m) => m.direction === 'OUTBOUND')
    expect(outbound).toHaveLength(2)
    const attachment = outbound.find((m) => m.messageType === 'ATTACHMENT')
    if (!attachment) throw new Error('Missing attachment block')
    await f.call(`/${id}/cancel`, 'POST', {})
    await db.update(mediaAsset).set({ deletedAt: new Date() }).where(eq(mediaAsset.id, assetId))
    await deliver(attachment.id, {
      ...env,
      OBJECTS: { get: async () => ({ body: new Response('note').body }) } as unknown as R2Bucket,
    })
    expect(
      (await db.select().from(message).where(eq(message.id, attachment.id)))[0].deliveryState,
    ).toBe('SENT')
    expect(fetcher).toHaveBeenCalledTimes(3)
    vi.useRealTimers()
    const random = crypto.randomUUID()
    await f.call('', 'POST', {
      id: random,
      name: 'Random update',
      channelId: f.channelId,
      identityIds: [f.identityId],
      content: blocks.slice(0, 1).concat([{ id: crypto.randomUUID(), text: 'Second choice' }]),
      selectionMode: 'RANDOM',
    })
    await f.call(`/${random}/execute`, 'POST', {})
    const before = (await (await f.call(`/${random}`)).json()) as Awaited<
      ReturnType<typeof readCampaign>
    >
    await handleScheduled(env)
    const after = (await (await f.call(`/${random}`)).json()) as Awaited<
      ReturnType<typeof readCampaign>
    >
    expect(before.runs[0].recipients[0].content).toHaveLength(1)
    expect(after.runs[0].recipients[0].content).toEqual(before.runs[0].recipients[0].content)
  })

  it('persists per-identity translations once and preserves the source without retranslating on recovery', async () => {
    const f = await fixture()
    const id = crypto.randomUUID()
    const fetcher = vi.fn(async () =>
      Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                decision: 'ANSWER',
                response: 'Translated notice',
                handoffReason: null,
                containsBusinessFacts: false,
                usedChunkIds: [],
              }),
            },
          },
        ],
      }),
    )
    vi.stubGlobal('fetch', fetcher)
    await f.call('', 'POST', {
      id,
      name: 'Translated update',
      channelId: f.channelId,
      identityIds: [f.identityId],
      text: 'Original notice',
      targetLanguage: 'en',
    })
    expect((await f.call(`/${id}/execute`, 'POST', {})).status).toBe(200)
    await handleScheduled(env)
    expect(fetcher).toHaveBeenCalledOnce()
    const result = (await (await f.call(`/${id}`)).json()) as Awaited<
      ReturnType<typeof readCampaign>
    >
    expect(result.runs[0].recipients[0]).toMatchObject({
      content: [{ text: 'Original notice' }],
      translatedContent: [{ text: 'Translated notice' }],
    })
    expect(
      (await db.select().from(message).where(eq(message.conversationId, f.conversationId))).find(
        (m) => m.direction === 'OUTBOUND',
      )?.text,
    ).toBe('Translated notice')
    expect(
      await getAiBudget(db, { workspaceId: f.workspaceId, actingUserId: f.userId }),
    ).toMatchObject({ used: 1 })
  })

  it('creates one scheduled occurrence and skips missed recurring days rather than backfilling', async () => {
    const f = await fixture()
    const first = new Date(Math.ceil((Date.now() + 120_000) / 60_000) * 60_000)
    const id = crypto.randomUUID()
    await f.call('', 'POST', {
      id,
      name: 'Daily neutral update',
      channelId: f.channelId,
      identityIds: [f.identityId],
      text: 'Daily notice',
      calendar: {
        localTime: first.toISOString().slice(0, 16),
        timeZone: 'UTC',
        repeat: 'DAILY',
        maxRuns: 2,
      },
    })
    expect((await f.call(`/${id}/execute`, 'POST', {})).status).toBe(200)
    expect(await (await f.call(`/${id}`)).json()).toMatchObject({ runs: [] })
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(first.getTime() + 1000))
    await Promise.all([handleScheduled(env), handleScheduled(env)])
    expect(await db.select().from(campaignRun).where(eq(campaignRun.campaignId, id))).toHaveLength(
      1,
    )
    const initial = (await (await f.call(`/${id}`)).json()) as Awaited<
      ReturnType<typeof readCampaign>
    >
    expect(initial.runs[0].recipients).toHaveLength(1)
    vi.setSystemTime(new Date(first.getTime() + 3 * 86_400_000 + 1000))
    await handleScheduled(env)
    const [plan] = await db.select().from(campaign).where(eq(campaign.id, id))
    expect(plan.nextRunAt?.toISOString()).toBe(
      new Date(first.getTime() + 4 * 86_400_000).toISOString(),
    )
    expect(await db.select().from(campaignRun).where(eq(campaignRun.campaignId, id))).toHaveLength(
      1,
    )
    expect((await f.call(`/${id}/pause`, 'POST', {})).status).toBe(200)
    vi.setSystemTime(new Date(first.getTime() + 5 * 86_400_000 + 1000))
    await handleScheduled(env)
    expect(await db.select().from(campaignRun).where(eq(campaignRun.campaignId, id))).toHaveLength(
      1,
    )
    expect((await f.call(`/${id}/resume`, 'POST', {})).status).toBe(200)
    expect(await db.select().from(campaignRun).where(eq(campaignRun.campaignId, id))).toHaveLength(
      1,
    )
  })

  it('continues committed work after the recurrence limit and schedules the next pacing tick', async () => {
    const f = await fixture()
    const first = new Date(Math.ceil((Date.now() + 120_000) / 60_000) * 60_000)
    const id = crypto.randomUUID()
    await f.call('', 'POST', {
      id,
      name: 'Finite recurrence',
      channelId: f.channelId,
      identityIds: [f.identityId],
      text: 'Neutral scheduled notice',
      calendar: {
        localTime: first.toISOString().slice(0, 16),
        timeZone: 'UTC',
        repeat: 'DAILY',
        maxRuns: 1,
      },
    })
    await f.call(`/${id}/execute`, 'POST', {})
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(first.getTime() + 1000))
    await handleScheduled(env)
    const messages = await db
      .select()
      .from(message)
      .where(eq(message.conversationId, f.conversationId))
    const reply = messages.find((m) => m.direction === 'OUTBOUND')
    if (!reply) throw new Error('Missing scheduled reply')
    vi.setSystemTime(new Date(first.getTime() + 86_400_000 + 1000))
    await handleScheduled(env)
    const [plan] = await db.select().from(campaign).where(eq(campaign.id, id))
    expect(plan.status).toBe('ACTIVE')
    expect(plan.nextRunAt).toBeNull()
    expect(await db.select().from(campaignRun).where(eq(campaignRun.campaignId, id))).toHaveLength(
      1,
    )
    vi.setSystemTime(new Date(first.getTime() + 2000))
    const tick = vi.fn(async () => {})
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ message_id: 'neutral-scheduled-reply' })),
    )
    await deliver(reply.id, { ...env, MAINTENANCE_QUEUE: { send: tick } as unknown as Queue })
    expect(tick).toHaveBeenCalledWith({ v: 1, type: 'campaign.tick' }, { delaySeconds: 1 })
  })

  it('cancels the unsent tail of a partially completed recipient without undoing the sent block', async () => {
    const f = await fixture()
    const id = crypto.randomUUID()
    await f.call('', 'POST', {
      id,
      name: 'Partial cancellation',
      channelId: f.channelId,
      identityIds: [f.identityId],
      content: [
        { id: crypto.randomUUID(), text: 'First block' },
        { id: crypto.randomUUID(), text: 'Unsent tail' },
      ],
    })
    await f.call(`/${id}/execute`, 'POST', {})
    const first = (
      await db.select().from(message).where(eq(message.conversationId, f.conversationId))
    ).find((m) => m.direction === 'OUTBOUND')
    if (!first) throw new Error('Missing first block')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ message_id: 'partial-first' })),
    )
    await deliver(first.id)
    await f.call(`/${id}/cancel`, 'POST', {})
    expect(await (await f.call(`/${id}`)).json()).toMatchObject({
      campaign: { status: 'CANCELLED' },
      runs: [{ recipients: [{ state: 'SKIPPED', messages: [{ state: 'SENT' }] }] }],
    })
    expect(
      (await db.select().from(message).where(eq(message.conversationId, f.conversationId))).filter(
        (m) => m.direction === 'OUTBOUND',
      ),
    ).toHaveLength(1)
  })

  it('paginates retained recipients and occurrences without expanding the saved authorized scope', async () => {
    const f = await fixture()
    const profiles = await db
      .insert(customer)
      .values(Array.from({ length: 21 }, () => ({ workspaceId: f.workspaceId })))
      .returning({ id: customer.id })
    const identities = await db
      .insert(channelIdentity)
      .values(
        profiles.map((profile) => ({
          workspaceId: f.workspaceId,
          channelId: f.channelId,
          customerId: profile.id,
          externalUserId: crypto.randomUUID(),
        })),
      )
      .returning({ id: channelIdentity.id })
    const id = crypto.randomUUID()
    const content = [{ id: crypto.randomUUID(), text: 'Bounded neutral notice' }]
    await f.call('', 'POST', {
      id,
      name: 'Paged results',
      channelId: f.channelId,
      identityIds: [f.identityId, ...identities.map((i) => i.id)],
      content,
    })
    await f.call(`/${id}/execute`, 'POST', {})
    const [run] = await db.select().from(campaignRun).where(eq(campaignRun.campaignId, id))
    await db.insert(campaignRun).values(
      Array.from({ length: 4 }, (_, index) => ({
        id: crypto.randomUUID(),
        campaignId: id,
        version: 1,
        scheduledAt: new Date(Date.now() - (index + 1) * 86_400_000),
        content,
      })),
    )
    const first = (await (await f.call(`/${id}`)).json()) as {
      runs: { id: string; recipients: { id: string }[]; nextRecipientOrdinal: number | null }[]
      nextRunBefore: string | null
    }
    expect(first.runs).toHaveLength(3)
    expect(first.runs[0].recipients).toHaveLength(20)
    expect(first.runs[0].nextRecipientOrdinal).toBe(19)
    expect(first.nextRunBefore).not.toBeNull()
    const remaining = (await (
      await f.call(`/${id}?runId=${run.id}&afterOrdinal=19`)
    ).json()) as typeof first
    expect(remaining.runs[0].recipients).toHaveLength(2)
    expect(remaining.runs[0].nextRecipientOrdinal).toBeNull()
    const older = (await (
      await f.call(`/${id}?before=${encodeURIComponent(first.nextRunBefore ?? '')}`)
    ).json()) as typeof first
    expect(older.runs).toHaveLength(2)
    expect(
      older.runs.map((r) => r.id).some((runId) => first.runs.some((r) => r.id === runId)),
    ).toBe(false)
    expect(
      await db.select().from(campaignRecipient).where(eq(campaignRecipient.runId, run.id)),
    ).toHaveLength(22)
  })

  it('keeps a channel-wide provider deadline after one campaign exhausts its safe retries', async () => {
    const f = await fixture()
    const id = crypto.randomUUID()
    await f.call('', 'POST', {
      id,
      name: 'Throttled update',
      channelId: f.channelId,
      identityIds: [f.identityId],
      text: 'First update',
    })
    await f.call(`/${id}/execute`, 'POST', {})
    const reply = (
      await db.select().from(message).where(eq(message.conversationId, f.conversationId))
    ).find((m) => m.direction === 'OUTBOUND')
    if (!reply) throw new Error('Missing first campaign message')
    const started = Date.now()
    let calls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          { error: { code: 4, message: 'Rate limited' } },
          { status: 429, headers: { 'Retry-After': ++calls === 3 ? '300' : '1' } },
        ),
      ),
    )
    await deliver(reply.id)
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(started + 31_000))
    await deliver(reply.id)
    vi.setSystemTime(new Date(started + 152_000))
    await deliver(reply.id)
    expect(calls).toBe(3)
    expect((await db.select().from(message).where(eq(message.id, reply.id)))[0].deliveryState).toBe(
      'FAILED',
    )
    const nextId = crypto.randomUUID()
    vi.setSystemTime(new Date(started + 154_000))
    await f.call('', 'POST', {
      id: nextId,
      name: 'Next update',
      channelId: f.channelId,
      identityIds: [f.identityId],
      text: 'Second update',
    })
    await f.call(`/${nextId}/execute`, 'POST', {})
    expect(
      (await db.select().from(message).where(eq(message.conversationId, f.conversationId))).filter(
        (m) => m.direction === 'OUTBOUND',
      ),
    ).toHaveLength(1)
  })
})

function deliver(messageId: string, target = env) {
  return handleOutboundBatch(
    {
      messages: [
        { body: { v: 1, type: 'facebook.outbound', messageId }, ack: vi.fn(), retry: vi.fn() },
      ],
    } as unknown as MessageBatch<unknown>,
    target,
  )
}

async function fixture() {
  const email = `${crypto.randomUUID()}@example.com`
  const password = 'correct-horse-battery-staple'
  const created = await createAuth(db, env).api.signUpEmail({
    body: { email, password, name: 'Campaign owner' },
  })
  const signed = await app.request(
    '/api/auth/sign-in/email',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    },
    env,
  )
  const cookie = signed.headers.get('set-cookie')?.split(';', 1)[0]
  if (!cookie) throw new Error('No session')
  const workspace = await bootstrapWorkspace(db, {
    userId: created.user.id,
    userName: 'Owner',
    name: 'Campaign test',
  })
  const [owner] = await db.select().from(member).where(eq(member.workspaceId, workspace.id))
  if (!owner) throw new Error('No member')
  const pageId = crypto.randomUUID()
  const encrypted = await encryptFacebookToken('test-page-token', tokenKey)
  const [connected] = await connectFacebookPages(db, {
    workspaceId: workspace.id,
    actingUserId: created.user.id,
    pages: [
      {
        pageId,
        displayName: 'Support',
        encryptedPageAccessToken: encrypted.ciphertext,
        tokenIv: encrypted.iv,
        tokenKeyVersion: encrypted.keyVersion,
      },
    ],
  })
  if (!connected) throw new Error('No channel')
  await setMemberChannelAccess(db, {
    workspaceId: workspace.id,
    actingUserId: created.user.id,
    memberId: owner.id,
    channelIds: [connected.id],
  })
  const received = await processFacebookInbound(db, {
    ingressId: crypto.randomUUID(),
    pageId,
    externalUserId: crypto.randomUUID(),
    externalMessageId: crypto.randomUUID(),
    text: 'Hello',
    receivedAt: new Date(),
    providerSentAt: new Date(),
    payloadSha256: 'a'.repeat(64),
    eventFragment: {},
  })
  if (received.kind !== 'created') throw new Error('No inbound')
  const [current] = await db
    .select()
    .from(conversation)
    .where(eq(conversation.id, received.conversationId))
  const [identity] = await db
    .select()
    .from(channelIdentity)
    .where(eq(channelIdentity.id, current.channelIdentityId))
  return {
    workspaceId: workspace.id,
    memberId: owner.id,
    userId: created.user.id,
    conversationId: received.conversationId,
    identityId: identity.id,
    channelId: connected.id,
    call: (path: string, method = 'GET', body?: unknown) =>
      app.request(
        `/api/workspaces/${workspace.id}/campaigns${path}`,
        {
          method,
          headers: { Cookie: cookie, Origin: env.APP_URL, 'Content-Type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
        env,
      ),
  }
}
