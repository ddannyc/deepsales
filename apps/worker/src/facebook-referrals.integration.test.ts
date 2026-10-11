import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  bootstrapWorkspace,
  connectFacebookPages,
  createDatabase,
  conversation,
  channelIdentity,
  facebookMessagingWindow,
  message,
  member,
  memberChannelAccess,
  workspaceUserAccess,
  processFacebookInbound,
  processFacebookReferral,
  aiResponseRun,
  facebookReferral,
} from '@deepsales/db'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { and, eq } from 'drizzle-orm'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createAuth } from './auth'
import type { Bindings } from './bindings'
import { app, handleWebhookBatch } from './index'

const connectionString = process.env.DATABASE_URL
const pool = new Pool({ connectionString })
const db = createDatabase(pool)
const queued: unknown[] = []
const env = {
  APP_URL: 'http://localhost:8787',
  AUTH_RATE_LIMITER: { limit: async () => ({ success: true }) },
  BETTER_AUTH_SECRET: 'test-only-secret-that-is-at-least-32-characters',
  META_APP_SECRET: 'test-secret',
  TOKEN_ENCRYPTION_KEY: '07'.repeat(32),
  HYPERDRIVE: { connectionString },
  WEBHOOKS_QUEUE: {
    send: async (body: unknown) => {
      queued.push(body)
    },
  },
} as unknown as Bindings

describe.skipIf(!connectionString)('referral intake and authorized source timeline', () => {
  beforeAll(() =>
    migrate(db, {
      migrationsFolder: resolve(
        dirname(fileURLToPath(import.meta.url)),
        '../../../packages/db/drizzle',
      ),
    }),
  )
  afterAll(() => pool.end())

  it('durably deduplicates signed standalone referrals without messages, routing or window changes, then links a real message', async () => {
    const f = await fixture()
    const source = { source: 'ADS', type: 'OPEN_THREAD', ad_id: 'neutral-ad', ref: 'lamp' }
    const timestamp = 1700000000000
    const standalone = {
      sender: { id: f.visitor },
      recipient: { id: f.pageId },
      timestamp,
      referral: source,
    }
    const jobs = await ingress(f.pageId, [standalone, standalone])
    expect(jobs).toHaveLength(2)
    await Promise.all(jobs.map(consume))
    const [identity] = await db
      .select()
      .from(channelIdentity)
      .where(eq(channelIdentity.channelId, f.channelId))
    expect(identity).toBeDefined()
    expect(
      await db
        .select()
        .from(facebookReferral)
        .where(eq(facebookReferral.channelIdentityId, identity.id)),
    ).toHaveLength(1)
    expect(
      await db.select().from(conversation).where(eq(conversation.workspaceId, f.workspaceId)),
    ).toHaveLength(0)
    expect(await db.select().from(message).where(eq(message.channelId, f.channelId))).toHaveLength(
      0,
    )
    expect(
      await db
        .select()
        .from(facebookMessagingWindow)
        .where(eq(facebookMessagingWindow.channelIdentityId, identity.id)),
    ).toHaveLength(0)
    const incoming = {
      sender: { id: f.visitor },
      recipient: { id: f.pageId },
      timestamp,
      message: { mid: 'neutral-mid', text: 'Tell me about the lamp', referral: source },
    }
    const mixed = await ingress(f.pageId, [incoming])
    for (const job of mixed.reverse()) await consume(job)
    const [current] = await db
      .select()
      .from(conversation)
      .where(eq(conversation.workspaceId, f.workspaceId))
    const response = await f.call(current.id)
    expect(response.status).toBe(200)
    const data = (await response.json()) as {
      referrals: { adId: string; messageId: string | null; adTitle: string | null }[]
    }
    expect(data.referrals).toHaveLength(1)
    expect(data.referrals[0]).toMatchObject({ adId: 'neutral-ad', adTitle: null })
    expect(data.referrals[0].messageId).toBeTruthy()
    expect(
      await db.select().from(aiResponseRun).where(eq(aiResponseRun.conversationId, current.id)),
    ).toHaveLength(0)
    const before = await db
      .select()
      .from(facebookMessagingWindow)
      .where(eq(facebookMessagingWindow.channelIdentityId, identity.id))
    const older = await ingress(f.pageId, [
      { ...standalone, timestamp: timestamp - 1000, referral: { ...source, ad_id: 'older-ad' } },
    ])
    await consume(older[0])
    const timeline = (await (await f.call(current.id)).json()) as { referrals: { adId: string }[] }
    expect(timeline.referrals.map((r) => r.adId)).toEqual(['neutral-ad', 'older-ad'])
    expect(
      await db
        .select()
        .from(facebookMessagingWindow)
        .where(eq(facebookMessagingWindow.channelIdentityId, identity.id)),
    ).toEqual(before)
    expect(await db.select().from(message).where(eq(message.channelId, f.channelId))).toHaveLength(
      1,
    )
  })

  it('isolates sources by the current identity and enforces tenant and channel access', async () => {
    const f = await fixture()
    const incoming = await processFacebookInbound(db, {
      ingressId: crypto.randomUUID(),
      pageId: f.pageId,
      externalUserId: f.visitor,
      externalMessageId: crypto.randomUUID(),
      text: 'Hello',
      providerSentAt: new Date(),
      receivedAt: new Date(),
      payloadSha256: 'a'.repeat(64),
      eventFragment: {},
    })
    if (incoming.kind !== 'created') throw new Error('Missing conversation')
    for (const job of await ingress(f.pageId, [
      {
        sender: { id: f.visitor },
        recipient: { id: f.pageId },
        timestamp: 1700000000000,
        referral: { source: 'SHORTLINK', type: 'OPEN_THREAD', ref: 'neutral-help' },
      },
    ]))
      await consume(job)
    const second = await fixture()
    expect((await second.call(incoming.conversationId)).status).toBe(404)
    const [access] = await db
      .select()
      .from(workspaceUserAccess)
      .where(
        and(
          eq(workspaceUserAccess.workspaceId, f.workspaceId),
          eq(workspaceUserAccess.userId, f.userId),
        ),
      )
    await db
      .update(workspaceUserAccess)
      .set({ role: 'AGENT' })
      .where(eq(workspaceUserAccess.id, access.id))
    await db.delete(memberChannelAccess).where(eq(memberChannelAccess.memberId, f.memberId))
    expect((await f.call(incoming.conversationId)).status).toBe(403)
    await db.insert(memberChannelAccess).values({ memberId: f.memberId, channelId: f.channelId })
    expect((await f.call(incoming.conversationId)).status).toBe(200)
    const [identity] = await db
      .select()
      .from(channelIdentity)
      .where(eq(channelIdentity.channelId, f.channelId))
    expect(identity.externalUserId).toBe(f.visitor)
  })

  it('paginates tied timestamps without gaps and excludes another linked identity', async () => {
    const f = await fixture()
    const incoming = await processFacebookInbound(db, {
      ingressId: crypto.randomUUID(),
      pageId: f.pageId,
      externalUserId: f.visitor,
      externalMessageId: crypto.randomUUID(),
      text: 'Hello',
      providerSentAt: new Date(),
      receivedAt: new Date(),
      payloadSha256: 'a'.repeat(64),
      eventFragment: {},
    })
    if (incoming.kind !== 'created') throw new Error('Missing conversation')
    const source = {
      pageId: f.pageId,
      externalUserId: f.visitor,
      externalMessageId: null,
      providerSentAt: '2026-01-01T12:00:00.000Z',
      receivedAt: new Date(),
      source: 'ADS',
      type: 'OPEN_THREAD',
      ref: null,
      adId: null,
      refererUri: null,
      adTitle: null,
      imageUrl: null,
    }
    await Promise.all(
      Array.from({ length: 52 }, (_, index) =>
        processFacebookReferral(db, { ...source, adId: `neutral-${index}` }),
      ),
    )
    const visitor = crypto.randomUUID()
    await processFacebookReferral(db, {
      ...source,
      externalUserId: visitor,
      adId: 'other-identity',
    })
    const [identity] = await db
      .select()
      .from(channelIdentity)
      .where(
        and(
          eq(channelIdentity.channelId, f.channelId),
          eq(channelIdentity.externalUserId, f.visitor),
        ),
      )
    await db
      .update(channelIdentity)
      .set({ customerId: identity.customerId })
      .where(
        and(
          eq(channelIdentity.channelId, f.channelId),
          eq(channelIdentity.externalUserId, visitor),
        ),
      )
    type Page = { referrals: { id: string; adId: string }[]; nextReferralCursor: string | null }
    const first = (await (await f.call(incoming.conversationId)).json()) as Page
    expect(first.referrals).toHaveLength(50)
    const second = (await (
      await f.call(incoming.conversationId, first.nextReferralCursor ?? '')
    ).json()) as Page
    expect(second.referrals).toHaveLength(2)
    expect(second.nextReferralCursor).toBeNull()
    expect(new Set([...first.referrals, ...second.referrals].map((r) => r.id)).size).toBe(52)
    expect([...first.referrals, ...second.referrals].some((r) => r.adId === 'other-identity')).toBe(
      false,
    )
    const [foreign] = await db
      .select()
      .from(facebookReferral)
      .where(eq(facebookReferral.adId, 'other-identity'))
    expect((await f.call(incoming.conversationId, foreign.id)).status).toBe(400)
    expect((await f.call(incoming.conversationId, 'invalid')).status).toBe(400)
  })

  it('reconciles message timestamp enrichment in either order and sorts timestamp-less duplicates by earliest ingress', async () => {
    const f = await fixture()
    const source = {
      pageId: f.pageId,
      externalUserId: f.visitor,
      externalMessageId: 'stable-mid',
      providerSentAt: null,
      receivedAt: new Date('2026-01-03T00:00:00Z'),
      source: 'ADS',
      type: 'OPEN_THREAD',
      ref: null,
      adId: 'neutral-timestamp',
      refererUri: null,
      adTitle: null,
      imageUrl: null,
    }
    await processFacebookReferral(db, source)
    await processFacebookReferral(db, { ...source, receivedAt: new Date('2026-01-01T00:00:00Z') })
    const [identity] = await db
      .select()
      .from(channelIdentity)
      .where(eq(channelIdentity.channelId, f.channelId))
    let rows = await db
      .select()
      .from(facebookReferral)
      .where(eq(facebookReferral.channelIdentityId, identity.id))
    expect(rows).toHaveLength(1)
    expect(rows[0].eventAt).toEqual(new Date('2026-01-01T00:00:00Z'))
    await processFacebookReferral(db, {
      ...source,
      providerSentAt: '2026-01-02T00:00:00.000Z',
      adTitle: 'Neutral lamp',
    })
    rows = await db
      .select()
      .from(facebookReferral)
      .where(eq(facebookReferral.channelIdentityId, identity.id))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      adTitle: 'Neutral lamp',
      providerSentAt: new Date('2026-01-02T00:00:00Z'),
      eventAt: new Date('2026-01-02T00:00:00Z'),
    })
    await processFacebookReferral(db, {
      ...source,
      externalMessageId: 'reverse-mid',
      adId: 'reverse-ad',
      providerSentAt: '2026-01-02T00:00:00.000Z',
    })
    await processFacebookReferral(db, {
      ...source,
      externalMessageId: 'reverse-mid',
      adId: 'reverse-ad',
    })
    await processFacebookReferral(db, {
      ...source,
      externalMessageId: null,
      adId: 'third-ad',
      providerSentAt: '2026-01-02T00:00:00.000Z',
    })
    await processFacebookReferral(db, {
      ...source,
      externalMessageId: 'third-mid',
      adId: 'third-ad',
    })
    await processFacebookReferral(db, {
      ...source,
      externalMessageId: 'third-mid',
      adId: 'third-ad',
      providerSentAt: '2026-01-02T00:00:00.000Z',
    })
    rows = await db
      .select()
      .from(facebookReferral)
      .where(eq(facebookReferral.channelIdentityId, identity.id))
    expect(rows).toHaveLength(3)
    expect(rows.every((r) => r.providerSentAt !== null && r.externalMessageId !== null)).toBe(true)
  })
})

async function consume(body: unknown) {
  const ack = vi.fn()
  const retry = vi.fn()
  await handleWebhookBatch(
    { messages: [{ body, ack, retry }] } as unknown as MessageBatch<unknown>,
    env,
  )
  expect(retry).not.toHaveBeenCalled()
  expect(ack).toHaveBeenCalledOnce()
}

async function ingress(pageId: string, events: unknown[]) {
  queued.length = 0
  const body = JSON.stringify({ object: 'page', entry: [{ id: pageId, messaging: events }] })
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(env.META_APP_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body))
  const signature = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join(
    '',
  )
  const response = await app.request(
    '/webhooks/facebook',
    { method: 'POST', headers: { 'x-hub-signature-256': `sha256=${signature}` }, body },
    env,
  )
  expect(response.status).toBe(200)
  return [...queued]
}

async function fixture() {
  const auth = createAuth(db, env)
  const email = `${crypto.randomUUID()}@example.com`
  const password = 'correct-horse-battery-staple'
  const created = await auth.api.signUpEmail({ body: { email, password, name: 'Source owner' } })
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
  if (!cookie) throw new Error('Missing test session')
  const workspace = await bootstrapWorkspace(db, {
    userId: created.user.id,
    userName: 'Source owner',
    name: 'Source timeline',
  })
  const pageId = crypto.randomUUID()
  const [channel] = await connectFacebookPages(db, {
    workspaceId: workspace.id,
    actingUserId: created.user.id,
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
  const [owner] = await db.select().from(member).where(eq(member.workspaceId, workspace.id))
  return {
    workspaceId: workspace.id,
    userId: created.user.id,
    memberId: owner.id,
    channelId: channel.id,
    pageId,
    visitor: crypto.randomUUID(),
    call: (conversationId: string, before?: string) =>
      app.request(
        `/api/workspaces/${workspace.id}/conversations/${conversationId}/referrals${before ? `?before=${before}` : ''}`,
        { headers: { Cookie: cookie } },
        env,
      ),
  }
}
