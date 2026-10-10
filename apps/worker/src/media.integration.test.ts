import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  bootstrapWorkspace,
  createDatabase,
  connectFacebookPages,
  member,
  listConversations,
  deliveryAttempt,
  setMemberChannelAccess,
  processFacebookInbound,
} from '@deepsales/db'
import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Pool } from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createAuth } from './auth'
import type { Bindings } from './bindings'
import { app, handleOutboundBatch } from './index'
import { encryptFacebookToken } from './facebook'

const connectionString = process.env.DATABASE_URL
const pool = new Pool({ connectionString })
const db = createDatabase(pool)
const objects = new Map<string, Uint8Array>()
const tokenKey = btoa(String.fromCharCode(...new Uint8Array(32)))
const env = {
  APP_URL: 'http://localhost:8787',
  AUTH_RATE_LIMITER: { limit: async () => ({ success: true }) },
  BETTER_AUTH_SECRET: 'test-only-secret-that-is-at-least-32-characters',
  HYPERDRIVE: { connectionString },
  META_APP_ID: 'test-app',
  META_APP_SECRET: 'test-secret',
  META_GRAPH_API_VERSION: 'v26.0',
  TOKEN_ENCRYPTION_KEY: tokenKey,
  OUTBOUND_QUEUE: { send: async () => {} },
  OBJECTS: {
    put: async (key: string, body: Uint8Array) => {
      objects.set(key, body)
    },
    get: async (key: string) =>
      objects.has(key)
        ? { body: new Blob([(objects.get(key) ?? new Uint8Array()).slice().buffer]).stream() }
        : null,
    delete: async (key: string) => {
      objects.delete(key)
    },
  },
} as unknown as Bindings

describe.skipIf(!connectionString)('private media and team reply content', () => {
  beforeAll(() =>
    migrate(db, {
      migrationsFolder: resolve(
        dirname(fileURLToPath(import.meta.url)),
        '../../../packages/db/drizzle',
      ),
    }),
  )
  afterAll(() => pool.end())
  afterEach(() => vi.unstubAllGlobals())

  it('uploads an immutable private asset idempotently and isolates its download by workspace', async () => {
    const f = await fixture()
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
    const id = crypto.randomUUID()
    const upload = () =>
      f.call('/media-assets', {
        method: 'POST',
        headers: {
          'Content-Type': 'image/png',
          'X-Filename': 'diagram.png',
          'X-Upload-Id': id,
          'X-Library': 'true',
        },
        body: bytes,
      })
    expect(
      (
        await f.call('/media-assets', {
          method: 'POST',
          headers: { 'Content-Type': 'image/png', 'X-Filename': '%bad', 'X-Upload-Id': id },
          body: bytes,
        })
      ).status,
    ).toBe(400)
    const first = await upload()
    expect(first.status).toBe(201)
    const result = (await first.json()) as { asset: { id: string; storageKey?: string } }
    expect(result.asset.id).toBe(id)
    expect(result.asset.storageKey).toBeUndefined()
    expect((await upload()).status).toBe(201)
    expect(
      ((await (await f.call('/media-assets?query=diagram')).json()) as { assets: unknown[] })
        .assets,
    ).toHaveLength(1)
    const download = await f.call(`/media-assets/${id}/file`)
    expect(download.status).toBe(200)
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(bytes)
    const other = await fixture()
    expect((await other.call(`/media-assets/${id}/file`)).status).toBe(404)
    expect((await f.call(`/media-assets/${id}`, { method: 'DELETE' })).status).toBe(200)
    expect((await f.call(`/media-assets/${id}/file`)).status).toBe(404)
    expect(
      (
        await other.call(
          `/conversations/${crypto.randomUUID()}/messages/${crypto.randomUUID()}/retry`,
          { method: 'POST' },
        )
      ).status,
    ).toBe(404)
  })

  it('commits media once, preserves submitted bytes after library deletion and delivers once', async () => {
    const f = await fixture()
    const token = await encryptFacebookToken('page-token', tokenKey)
    const pageId = crypto.randomUUID()
    const [channel] = await connectFacebookPages(db, {
      workspaceId: f.workspaceId,
      actingUserId: f.userId,
      pages: [
        {
          pageId,
          displayName: 'Support',
          encryptedPageAccessToken: token.ciphertext,
          tokenIv: token.iv,
          tokenKeyVersion: token.keyVersion,
        },
      ],
    })
    const [owner] = await db.select().from(member).where(eq(member.workspaceId, f.workspaceId))
    await setMemberChannelAccess(db, {
      workspaceId: f.workspaceId,
      actingUserId: f.userId,
      memberId: owner.id,
      channelIds: [channel.id],
    })
    const received = await processFacebookInbound(db, {
      ingressId: crypto.randomUUID(),
      pageId,
      externalUserId: crypto.randomUUID(),
      externalMessageId: crypto.randomUUID(),
      text: 'Send the guide',
      providerSentAt: new Date(),
      receivedAt: new Date(),
      payloadSha256: 'a'.repeat(64),
      eventFragment: {},
    })
    if (received.kind !== 'created') throw new Error('No conversation')
    const base = `/conversations/${received.conversationId}`
    expect((await f.call(`${base}/takeover`, { method: 'POST' })).status).toBe(200)
    const assetId = crypto.randomUUID()
    const bytes = new TextEncoder().encode('%PDF-guide')
    expect(
      (
        await f.call('/media-assets', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/pdf',
            'X-Filename': 'guide.pdf',
            'X-Upload-Id': assetId,
            'X-Library': 'true',
          },
          body: bytes,
        })
      ).status,
    ).toBe(201)
    const body = { assetId, clientKey: crypto.randomUUID() }
    const reply = () =>
      f.call(`${base}/replies`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    const replies = await Promise.all([reply(), reply()])
    expect(replies.map((r) => r.status)).toEqual([201, 201])
    const sent = (await replies[0].json()) as { message: { id: string; deliveryState: string } }
    const unanswered = () =>
      listConversations(db, {
        workspaceId: f.workspaceId,
        userId: f.userId,
        view: 'all-open',
        attention: 'unanswered',
      })
    expect((await unanswered()).conversations).toHaveLength(1)
    expect(sent.message.deliveryState).toBe('PENDING')
    expect(((await replies[1].json()) as { message: { id: string } }).message.id).toBe(
      sent.message.id,
    )
    await f.call(`/media-assets/${assetId}`, { method: 'DELETE' })
    const fakeFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/message_attachments')) {
        const form = init?.body as FormData
        expect(new Uint8Array(await (form.get('filedata') as File).arrayBuffer())).toEqual(bytes)
        return Response.json({ attachment_id: 'provider-guide' })
      }
      expect(JSON.parse(init?.body as string).message).toEqual({
        attachment: { type: 'file', payload: { attachment_id: 'provider-guide' } },
      })
      return Response.json({ message_id: 'delivered-guide' })
    })
    vi.stubGlobal('fetch', fakeFetch)
    const batch = {
      queue: 'deepsales-outbound',
      messages: [
        {
          body: { v: 1, type: 'facebook.outbound', messageId: sent.message.id },
          ack: vi.fn(),
          retry: vi.fn(),
        },
      ],
    } as unknown as MessageBatch<unknown>
    await handleOutboundBatch(batch, env)
    await handleOutboundBatch(batch, env)
    expect(fakeFetch).toHaveBeenCalledTimes(2)
    expect((await unanswered()).conversations).toHaveLength(0)
    expect(
      (
        await f.call(`${base}/replies`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ assetId, clientKey: crypto.randomUUID() }),
        })
      ).status,
    ).toBe(404)
    const messages = (await (await f.call(`${base}/messages`)).json()) as {
      messages: { direction: string; attachments: { id: string }[] }[]
    }
    expect(
      messages.messages.filter((m: { direction: string }) => m.direction === 'OUTBOUND'),
    ).toHaveLength(1)
    expect(messages.messages.at(-1)).toMatchObject({
      deliveryState: 'SENT',
      externalMessageId: 'delivered-guide',
      attachments: [{ filename: 'guide.pdf', storageState: 'READY' }],
    })
    expect(
      (
        await f.call(
          `/attachments/${messages.messages[messages.messages.length - 1].attachments[0].id}`,
        )
      ).status,
    ).toBe(200)
    const secondAsset = crypto.randomUUID()
    await f.call('/media-assets', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/pdf',
        'X-Filename': 'guide.pdf',
        'X-Upload-Id': secondAsset,
      },
      body: bytes,
    })
    const submit = async (clientKey: string) => {
      const response = await f.call(`${base}/replies`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assetId: secondAsset, clientKey }),
      })
      expect(response.status).toBe(201)
      return ((await response.json()) as { message: { id: string } }).message.id
    }
    const rejectedId = await submit(crypto.randomUUID())
    const rejected = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ attachment_id: 'uploaded-retry' }))
      .mockResolvedValueOnce(
        Response.json(
          { error: { code: 100, message: 'Rejected' } },
          { status: 400, headers: { 'Retry-After': '300' } },
        ),
      )
      .mockResolvedValueOnce(Response.json({ message_id: 'retry-delivered' }))
    vi.stubGlobal('fetch', rejected)
    const job = (id: string) =>
      ({
        queue: 'deepsales-outbound',
        messages: [
          {
            body: { v: 1, type: 'facebook.outbound', messageId: id },
            ack: vi.fn(),
            retry: vi.fn(),
          },
        ],
      }) as unknown as MessageBatch<unknown>
    await handleOutboundBatch(job(rejectedId), env)
    expect((await f.call(`${base}/messages/${rejectedId}/retry`, { method: 'POST' })).status).toBe(
      400,
    )
    await db
      .update(deliveryAttempt)
      .set({ completedAt: new Date(Date.now() - 31_000) })
      .where(eq(deliveryAttempt.messageId, rejectedId))
    expect((await f.call(`${base}/messages/${rejectedId}/retry`, { method: 'POST' })).status).toBe(
      400,
    )
    await db
      .update(deliveryAttempt)
      .set({ retryNotBefore: new Date(Date.now() - 1_000) })
      .where(eq(deliveryAttempt.messageId, rejectedId))
    expect((await f.call(`${base}/messages/${rejectedId}/retry`, { method: 'POST' })).status).toBe(
      200,
    )
    await handleOutboundBatch(job(rejectedId), env)
    expect(rejected).toHaveBeenCalledTimes(3)
    expect(String(rejected.mock.calls[2][0])).toMatch(/\/messages$/)
    const uncertainId = await submit(crypto.randomUUID())
    const uncertain = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ attachment_id: 'uncertain-upload' }))
      .mockRejectedValueOnce(new TypeError('Network disconnected'))
    vi.stubGlobal('fetch', uncertain)
    await handleOutboundBatch(job(uncertainId), env)
    expect((await f.call(`${base}/messages/${uncertainId}/retry`, { method: 'POST' })).status).toBe(
      400,
    )
    const final = (await (await f.call(`${base}/messages`)).json()) as {
      messages: { id: string; failureCode: string }[]
    }
    expect(final.messages.find((m) => m.id === uncertainId)).toMatchObject({
      failureCode: 'AMBIGUOUS_DELIVERY',
    })
    const preparationId = await submit(crypto.randomUUID())
    const uploadFailure = vi.fn().mockRejectedValue(new TypeError('Upload disconnected'))
    vi.stubGlobal('fetch', uploadFailure)
    for (let attempt = 1; attempt <= 3; attempt++) {
      await handleOutboundBatch(job(preparationId), env)
      const failed = (await (await f.call(`${base}/messages`)).json()) as {
        messages: { id: string; failureCode: string }[]
      }
      expect(failed.messages.find((m) => m.id === preparationId)?.failureCode).toBe(
        'FACEBOOK_MEDIA_PREPARATION_FAILED',
      )
      await db
        .update(deliveryAttempt)
        .set({ completedAt: new Date(Date.now() - 121_000) })
        .where(eq(deliveryAttempt.messageId, preparationId))
      const retry = await f.call(`${base}/messages/${preparationId}/retry`, { method: 'POST' })
      expect(retry.status).toBe(attempt < 3 ? 200 : 400)
      if (attempt === 3)
        expect(await retry.json()).toMatchObject({ error: { code: 'RETRY_LIMIT_REACHED' } })
    }
    expect(uploadFailure).toHaveBeenCalledTimes(3)
    expect(
      uploadFailure.mock.calls.every(([url]) => String(url).endsWith('/message_attachments')),
    ).toBe(true)
    await setMemberChannelAccess(db, {
      workspaceId: f.workspaceId,
      actingUserId: f.userId,
      memberId: owner.id,
      channelIds: [],
    })
    expect((await reply()).status).toBe(403)
  })

  it('creates, searches, edits and deletes team text templates without sending a message', async () => {
    const f = await fixture()
    const first = await f.call('/reply-templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Greeting', text: 'Hello, how can we help?' }),
    })
    expect(first.status).toBe(201)
    const { template } = (await first.json()) as { template: { id: string } }
    expect(
      ((await (await f.call('/reply-templates?query=Greeting')).json()) as { templates: unknown[] })
        .templates,
    ).toHaveLength(1)
    const other = await fixture()
    expect((await other.call(`/reply-templates/${template.id}`, { method: 'DELETE' })).status).toBe(
      404,
    )
    expect(
      (
        await f.call(`/reply-templates/${template.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: 'Support greeting', text: 'Welcome to support.' }),
        })
      ).status,
    ).toBe(200)
    expect(
      (
        (await (await f.call('/reply-templates?query=Welcome')).json()) as {
          templates: { text: string }[]
        }
      ).templates,
    ).toMatchObject([{ text: 'Welcome to support.' }])
    expect((await f.call(`/reply-templates/${template.id}`, { method: 'DELETE' })).status).toBe(200)
    expect(
      ((await (await f.call('/reply-templates')).json()) as { templates: unknown[] }).templates,
    ).toEqual([])
  })
})

async function fixture() {
  const email = `${crypto.randomUUID()}@example.com`
  const password = 'correct-horse-battery-staple'
  const created = await createAuth(db, env).api.signUpEmail({
    body: { email, password, name: 'Media owner' },
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
  if (!cookie) throw new Error('No cookie')
  const workspace = await bootstrapWorkspace(db, {
    userId: created.user.id,
    userName: 'Media owner',
    name: 'Media acceptance',
  })
  return {
    workspaceId: workspace.id,
    userId: created.user.id,
    call: (path: string, init: RequestInit = {}) =>
      app.request(
        `/api/workspaces/${workspace.id}${path}`,
        { ...init, headers: { Cookie: cookie, Origin: env.APP_URL, ...init.headers } },
        env,
      ),
  }
}
