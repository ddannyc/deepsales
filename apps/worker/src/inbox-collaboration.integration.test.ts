import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  bootstrapWorkspace,
  connectFacebookPages,
  createDatabase,
  conversation,
  conversationInternalNote,
  member,
  processFacebookInbound,
  setMemberChannelAccess,
  workspaceUserAccess,
} from '@deepsales/db'
import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createAuth } from './auth'
import type { Bindings } from './bindings'
import { app } from './index'

const connectionString = process.env.DATABASE_URL
const pool = new Pool({ connectionString })
const db = createDatabase(pool)
const outbound = vi.fn()
const env = {
  APP_URL: 'http://localhost:8787',
  AUTH_RATE_LIMITER: { limit: async () => ({ success: true }) },
  BETTER_AUTH_SECRET: 'test-only-secret-that-is-at-least-32-characters',
  HYPERDRIVE: { connectionString },
  OUTBOUND_QUEUE: { send: outbound },
} as unknown as Bindings

describe.skipIf(!connectionString)('inbox team collaboration', () => {
  beforeAll(() =>
    migrate(db, {
      migrationsFolder: resolve(
        dirname(fileURLToPath(import.meta.url)),
        '../../../packages/db/drizzle',
      ),
    }),
  )
  afterAll(() => pool.end())

  it('creates one internal note for concurrent retries without customer messages or outbound jobs', async () => {
    const f = await fixture()
    outbound.mockClear()
    const body = { clientKey: crypto.randomUUID(), text: 'Coordinate with the support team.' }
    const responses = await Promise.all([
      f.call(`/conversations/${f.conversationId}/notes`, 'POST', body),
      f.call(`/conversations/${f.conversationId}/notes`, 'POST', body),
    ])
    expect(responses.map((r) => r.status)).toEqual([201, 201])
    const notes = (await (await f.call(`/conversations/${f.conversationId}/notes`)).json()) as {
      notes: { id: string; text: string; authorName: string; createdAt: string }[]
      olderCursor: string | null
    }
    expect(notes.notes).toHaveLength(1)
    expect(notes.notes[0]).toMatchObject({ text: body.text, authorName: 'Collaboration owner' })
    expect(notes.notes[0].createdAt).toMatch(/^\d{4}-/)
    expect(notes.olderCursor).toBeNull()
    const messages = (await (
      await f.call(`/conversations/${f.conversationId}/messages`)
    ).json()) as { messages: { text: string }[] }
    expect(messages.messages.map((m) => m.text)).toEqual(['Hello'])
    expect(outbound).not.toHaveBeenCalled()
    expect(
      (
        await f.call(`/conversations/${f.conversationId}/notes`, 'POST', {
          ...body,
          text: 'Changed retry',
        })
      ).status,
    ).toBe(400)
  })

  it('persists personal mute filters while continuing inbound messages and retaining assignment', async () => {
    const f = await fixture()
    const [before] = await db
      .select()
      .from(conversation)
      .where(eq(conversation.id, f.conversationId))
    const updated = await f.call(`/conversations/${f.conversationId}/mute`, 'PUT', { muted: true })
    expect(updated.status).toBe(200)
    expect(await updated.json()).toEqual({ muted: true })
    const filtered = (await (await f.call('/conversations?mute=muted')).json()) as {
      conversations: { id: string; muted: boolean }[]
    }
    expect(filtered.conversations).toMatchObject([{ id: f.conversationId, muted: true }])
    expect(
      ((await (await f.call('/conversations?mute=unmuted')).json()) as { conversations: unknown[] })
        .conversations,
    ).toEqual([])
    await f.inbound('Still received')
    const [after] = await db
      .select()
      .from(conversation)
      .where(eq(conversation.id, f.conversationId))
    expect(after.assigneeMemberId).toBe(before.assigneeMemberId)
    expect(after.routingConstraint).toBe(before.routingConstraint)
    const messages = (await (
      await f.call(`/conversations/${f.conversationId}/messages`)
    ).json()) as { messages: { text: string }[] }
    expect(messages.messages.map((m) => m.text)).toEqual(['Hello', 'Still received'])
    expect(
      (await f.call(`/conversations/${f.conversationId}/mute`, 'PUT', { muted: false })).status,
    ).toBe(200)
    expect(
      ((await (await f.call('/conversations?mute=muted')).json()) as { conversations: unknown[] })
        .conversations,
    ).toEqual([])
    expect((await f.call('/conversations?mute=invalid')).status).toBe(400)
  })

  it('paginates notes, protects closed history, and isolates member preferences and channel access', async () => {
    const f = await fixture()
    const other = await fixture()
    const callAsOther = (path: string, method = 'GET', body?: unknown) =>
      app.request(
        `/api/workspaces/${f.workspaceId}/conversations/${f.conversationId}${path}`,
        {
          method,
          headers: {
            Cookie: other.cookie,
            Origin: env.APP_URL,
            'Content-Type': 'application/json',
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
        env,
      )
    expect((await callAsOther('/notes')).status).toBe(403)
    const [access] = await db
      .insert(workspaceUserAccess)
      .values({ workspaceId: f.workspaceId, userId: other.userId, role: 'AGENT' })
      .returning()
    const [agent] = await db
      .insert(member)
      .values({
        workspaceId: f.workspaceId,
        workspaceUserAccessId: access.id,
        type: 'HUMAN',
        displayName: 'Second member',
      })
      .returning()
    expect((await callAsOther('/notes')).status).toBe(403)
    expect((await callAsOther('/mute', 'PUT', { muted: true })).status).toBe(403)
    await setMemberChannelAccess(db, {
      workspaceId: f.workspaceId,
      actingUserId: f.userId,
      memberId: agent.id,
      channelIds: [f.channelId],
    })
    await f.call(`/conversations/${f.conversationId}/mute`, 'PUT', { muted: true })
    const otherList = await app.request(
      `/api/workspaces/${f.workspaceId}/conversations?mute=unmuted`,
      { headers: { Cookie: other.cookie } },
      env,
    )
    expect(await otherList.json()).toMatchObject({
      conversations: [{ id: f.conversationId, muted: false }],
    })
    const firstBody = { clientKey: crypto.randomUUID(), text: 'First note' }
    expect(
      (await f.call(`/conversations/${f.conversationId}/notes`, 'POST', firstBody)).status,
    ).toBe(201)
    await db.insert(conversationInternalNote).values(
      Array.from({ length: 52 }, (_, i) => ({
        conversationId: f.conversationId,
        authorMemberId: f.memberId,
        authorName: 'Collaboration owner',
        clientKey: crypto.randomUUID(),
        text: `Note ${i}`,
        createdAt: new Date(Date.now() + i + 1000),
      })),
    )
    const latest = (await (await f.call(`/conversations/${f.conversationId}/notes`)).json()) as {
      notes: { id: string }[]
      olderCursor: string
    }
    expect(latest.notes).toHaveLength(50)
    const older = (await (
      await f.call(
        `/conversations/${f.conversationId}/notes?before=${encodeURIComponent(latest.olderCursor)}`,
      )
    ).json()) as { notes: { id: string }[]; olderCursor: null }
    expect(older.notes).toHaveLength(3)
    expect(new Set([...older.notes, ...latest.notes].map((n) => n.id)).size).toBe(53)
    expect(older.olderCursor).toBeNull()
    expect((await f.call(`/conversations/${f.conversationId}/takeover`, 'POST', {})).status).toBe(
      200,
    )
    expect((await f.call(`/conversations/${f.conversationId}/close`, 'POST', {})).status).toBe(200)
    expect(
      (await f.call(`/conversations/${f.conversationId}/notes`, 'POST', firstBody)).status,
    ).toBe(201)
    expect(
      (
        await f.call(`/conversations/${f.conversationId}/notes`, 'POST', {
          clientKey: crypto.randomUUID(),
          text: 'Too late',
        })
      ).status,
    ).toBe(400)
    expect((await callAsOther('/notes')).status).toBe(200)
    await setMemberChannelAccess(db, {
      workspaceId: f.workspaceId,
      actingUserId: f.userId,
      memberId: agent.id,
      channelIds: [],
    })
    expect((await callAsOther('/notes')).status).toBe(403)
  })
})

async function fixture() {
  const auth = createAuth(db, env)
  const email = `${crypto.randomUUID()}@example.com`
  const password = 'correct-horse-battery-staple'
  const created = await auth.api.signUpEmail({
    body: { email, password, name: 'Collaboration owner' },
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
  if (!cookie) throw new Error('No sign-in cookie')
  const workspace = await bootstrapWorkspace(db, {
    userId: created.user.id,
    userName: 'Collaboration owner',
    name: 'Inbox collaboration',
  })
  const pageId = crypto.randomUUID()
  const externalUserId = crypto.randomUUID()
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
  const inbound = async (text: string, identity = externalUserId) => {
    const result = await processFacebookInbound(db, {
      ingressId: crypto.randomUUID(),
      pageId,
      externalUserId: identity,
      externalMessageId: crypto.randomUUID(),
      text,
      providerSentAt: new Date(),
      receivedAt: new Date(),
      payloadSha256: 'a'.repeat(64),
      eventFragment: {},
    })
    if (result.kind !== 'created') throw new Error('Inbound not created')
    return result
  }
  const received = await inbound('Hello')
  const [owner] = await db
    .select({ id: member.id })
    .from(member)
    .where(eq(member.workspaceId, workspace.id))
  await setMemberChannelAccess(db, {
    workspaceId: workspace.id,
    actingUserId: created.user.id,
    memberId: owner.id,
    channelIds: [channel.id],
  })
  const detail = await app.request(
    `/api/workspaces/${workspace.id}/conversations/${received.conversationId}`,
    { headers: { Cookie: cookie } },
    env,
  )
  const { conversation } = (await detail.json()) as { conversation: { customerId: string } }
  return {
    cookie,
    workspaceId: workspace.id,
    memberId: owner.id,
    userId: created.user.id,
    channelId: channel.id,
    customerId: conversation.customerId,
    conversationId: received.conversationId,
    inbound,
    call: (path: string, method = 'GET', body?: unknown) =>
      app.request(
        `/api/workspaces/${workspace.id}${path}`,
        {
          method,
          headers: { Cookie: cookie, 'Content-Type': 'application/json', Origin: env.APP_URL },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
        env,
      ),
  }
}
