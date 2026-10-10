import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  bootstrapWorkspace,
  connectFacebookPages,
  createDatabase,
  customer,
  member,
  processFacebookInbound,
  channelIdentity,
  conversation,
  customerTagDefinition,
  customerTag,
  customerPropertyDefinition,
  customerPropertyValue,
  workspaceUserAccess,
  memberChannelAccess,
  takeOverConversation,
} from '@deepsales/db'
import { and, eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAuth } from './auth'
import type { Bindings } from './bindings'
import { app } from './index'

const connectionString = process.env.DATABASE_URL
const pool = new Pool({ connectionString })
const db = createDatabase(pool)
const env = {
  APP_URL: 'http://localhost:8787',
  AUTH_RATE_LIMITER: { limit: async () => ({ success: true }) },
  BETTER_AUTH_SECRET: 'test-only-secret-that-is-at-least-32-characters',
  HYPERDRIVE: { connectionString },
} as unknown as Bindings

describe.skipIf(!connectionString)('authorized inbox search', () => {
  beforeAll(() =>
    migrate(db, {
      migrationsFolder: resolve(
        dirname(fileURLToPath(import.meta.url)),
        '../../../packages/db/drizzle',
      ),
    }),
  )
  afterAll(() => pool.end())

  it('searches all pages by literal name or notes and combines time and member conditions', async () => {
    const f = await fixture()
    await db
      .update(customer)
      .set({ displayName: 'Archive match', notes: 'Needs 100% coverage' })
      .where(eq(customer.id, f.customerId))
    const unmatched = await f.inbound('Other message', crypto.randomUUID())
    const page = (await (await f.call('/conversations?query=100%25')).json()) as {
      conversations: { id: string }[]
    }
    expect(page.conversations.map((c) => c.id)).toEqual([f.conversationId])
    expect(
      ((await (await f.call('/conversations?query=absent')).json()) as { conversations: unknown[] })
        .conversations,
    ).toEqual([])
    expect(
      (
        (await (await f.call('/conversations?updatedFrom=2099-01-01T00:00:00Z')).json()) as {
          conversations: unknown[]
        }
      ).conversations,
    ).toEqual([])
    expect((await f.call('/conversations?updatedFrom=bad')).status).toBe(400)
    expect((await f.call('/conversations?memberIds=not-a-uuid')).status).toBe(400)
    expect((await f.call(`/conversations?memberIds=${crypto.randomUUID()}`)).status).toBe(400)
    expect(unmatched.conversationId).not.toBe(f.conversationId)
  })

  it('persists personal and public views, isolates users and rejects stale references', async () => {
    const f = await fixture()
    const created = await f.call('/inbox-views', 'POST', {
      name: 'Coverage',
      scope: 'PERSONAL',
      filters: { view: 'all-open', query: 'Archive' },
    })
    expect(created.status).toBe(201)
    const { view } = (await created.json()) as { view: { id: string } }
    const listing = (await (await f.call('/inbox-views')).json()) as {
      views: { id: string; filters: { query: string }; valid: boolean }[]
    }
    expect(listing.views).toMatchObject([
      { id: view.id, filters: { query: 'Archive' }, valid: true },
    ])
    expect(
      (
        await f.call(`/inbox-views/${view.id}`, 'PATCH', {
          name: 'Updated',
          scope: 'PUBLIC',
          filters: { view: 'team', memberIds: [f.memberId] },
        })
      ).status,
    ).toBe(200)
    await db.update(member).set({ status: 'DISABLED' }).where(eq(member.id, f.memberId))
    expect((await f.call('/inbox-views')).status).toBe(403)
    await db.update(member).set({ status: 'ACTIVE' }).where(eq(member.id, f.memberId))
    expect((await f.call(`/inbox-views/${view.id}`, 'DELETE')).status).toBe(204)
    expect(((await (await f.call('/inbox-views')).json()) as { views: unknown[] }).views).toEqual(
      [],
    )
    expect(
      (
        await f.call('/inbox-views', 'POST', {
          name: 'Invalid',
          scope: 'PERSONAL',
          filters: { view: 'all-open', tagIds: [crypto.randomUUID()] },
        })
      ).status,
    ).toBe(400)
  })

  it('keeps every combined condition on later pages and invalidates deleted tag references', async () => {
    const f = await fixture()
    const [tag] = await db
      .insert(customerTagDefinition)
      .values({ workspaceId: f.workspaceId, name: 'Priority', level: 'CONVERSATION' })
      .returning()
    const [definition] = await db
      .insert(customerPropertyDefinition)
      .values({ workspaceId: f.workspaceId, name: 'Score', level: 'CONVERSATION', type: 'NUMBER' })
      .returning()
    const ids: string[] = []
    for (let i = 0; i < 52; i++) {
      const received = await f.inbound(`Input ${i}`, crypto.randomUUID())
      ids.push(received.conversationId)
      const [identity] = await db
        .select({ customerId: channelIdentity.customerId })
        .from(conversation)
        .innerJoin(channelIdentity, eq(channelIdentity.id, conversation.channelIdentityId))
        .where(eq(conversation.id, received.conversationId))
      await db
        .update(customer)
        .set({ displayName: 'Coverage customer' })
        .where(eq(customer.id, identity.customerId))
      await db.insert(customerTag).values({
        tagId: tag.id,
        conversationId: received.conversationId,
        sourceChannelId: f.channelId,
      })
      await db.insert(customerPropertyValue).values({
        definitionId: definition.id,
        conversationId: received.conversationId,
        value: 7,
        sourceChannelId: f.channelId,
      })
    }
    const params = new URLSearchParams({
      query: 'coverage',
      tagIds: tag.id,
      properties: JSON.stringify([{ definitionId: definition.id, value: 7 }]),
      updatedFrom: '2000-01-01T00:00:00Z',
      updatedTo: '2099-01-01T00:00:00Z',
    })
    const first = (await (await f.call(`/conversations?${params}`)).json()) as {
      conversations: { id: string }[]
      nextCursor: string
    }
    expect(first.conversations).toHaveLength(50)
    expect(first.nextCursor).toBeTruthy()
    const second = (await (
      await f.call(`/conversations?${params}&cursor=${encodeURIComponent(first.nextCursor)}`)
    ).json()) as { conversations: { id: string }[]; nextCursor: null }
    expect(second.conversations).toHaveLength(2)
    expect(second.nextCursor).toBeNull()
    expect(new Set([...first.conversations, ...second.conversations].map((c) => c.id))).toEqual(
      new Set(ids),
    )
    const saved = (await (
      await f.call('/inbox-views', 'POST', {
        name: 'Priority',
        scope: 'PERSONAL',
        filters: { view: 'all-open', tagIds: [tag.id] },
      })
    ).json()) as { view: { id: string } }
    await db.delete(customerTagDefinition).where(eq(customerTagDefinition.id, tag.id))
    const listing = (await (await f.call('/inbox-views')).json()) as {
      views: { id: string; valid: boolean }[]
    }
    expect(listing.views).toMatchObject([{ id: saved.view.id, valid: false }])
    expect((await f.call(`/conversations?tagIds=${tag.id}`)).status).toBe(400)
  })

  it('isolates personal views and applies channel authorization when sharing public filters', async () => {
    const f = await fixture()
    const agent = await addAgent(f)
    const other = await fixture()
    const personal = (await (
      await f.call('/inbox-views', 'POST', {
        name: 'Private',
        scope: 'PERSONAL',
        filters: { view: 'all-open' },
      })
    ).json()) as { view: { id: string } }
    expect(
      ((await (await agent.call('/inbox-views')).json()) as { views: unknown[] }).views,
    ).toEqual([])
    expect((await agent.call(`/inbox-views/${personal.view.id}`, 'DELETE')).status).toBe(404)
    const shared = (await (
      await f.call('/inbox-views', 'POST', {
        name: 'Shared',
        scope: 'PUBLIC',
        filters: { view: 'team', memberIds: [f.memberId] },
      })
    ).json()) as { view: { id: string } }
    const body = { name: 'Changed', scope: 'PUBLIC', filters: { view: 'all-open' } }
    expect((await agent.call(`/inbox-views/${shared.view.id}`, 'PATCH', body)).status).toBe(403)
    expect((await agent.call(`/inbox-views/${shared.view.id}`, 'DELETE')).status).toBe(403)
    expect((await agent.call('/inbox-views', 'POST', body)).status).toBe(403)
    expect((await other.call(`/inbox-views/${shared.view.id}`, 'DELETE')).status).toBe(404)
    await takeOverConversation(db, {
      workspaceId: f.workspaceId,
      conversationId: f.conversationId,
      actingUserId: f.userId,
    })
    expect(
      (
        (await (await agent.call(`/conversations?view=team&memberIds=${f.memberId}`)).json()) as {
          conversations: { id: string }[]
        }
      ).conversations,
    ).toMatchObject([{ id: f.conversationId }])
    await db
      .update(customer)
      .set({
        displayName: 'Visible name',
        notes: 'Restricted note',
        profileSourceChannelIds: [other.channelId],
      })
      .where(eq(customer.id, f.customerId))
    expect(
      (
        (await (await agent.call('/conversations?query=Restricted')).json()) as {
          conversations: unknown[]
        }
      ).conversations,
    ).toEqual([])
    await db
      .delete(memberChannelAccess)
      .where(
        and(
          eq(memberChannelAccess.memberId, agent.memberId),
          eq(memberChannelAccess.channelId, f.channelId),
        ),
      )
    const views = (await (await agent.call('/inbox-views')).json()) as {
      views: { id: string; valid: boolean; canEdit: boolean }[]
    }
    expect(views.views).toMatchObject([{ id: shared.view.id, valid: false, canEdit: false }])
    expect(
      (
        (await (await agent.call('/conversations?view=team')).json()) as {
          conversations: unknown[]
        }
      ).conversations,
    ).toEqual([])
    expect((await agent.call(`/conversations?memberIds=${f.memberId}`)).status).toBe(400)
    expect(
      (
        await f.call('/inbox-views', 'POST', {
          name: 'Unsafe',
          scope: 'PERSONAL',
          filters: { view: 'all-open', includeClosed: true },
        })
      ).status,
    ).toBe(400)
  })
})

async function addAgent(f: Awaited<ReturnType<typeof fixture>>) {
  const email = `${crypto.randomUUID()}@example.com`
  const password = 'correct-horse-battery-staple'
  const created = await createAuth(db, env).api.signUpEmail({
    body: { email, password, name: 'Search agent' },
  })
  const [access] = await db
    .insert(workspaceUserAccess)
    .values({ workspaceId: f.workspaceId, userId: created.user.id, role: 'AGENT' })
    .returning()
  const [agent] = await db
    .insert(member)
    .values({
      workspaceId: f.workspaceId,
      workspaceUserAccessId: access.id,
      type: 'HUMAN',
      displayName: 'Search agent',
    })
    .returning()
  await db.insert(memberChannelAccess).values({ memberId: agent.id, channelId: f.channelId })
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
  return {
    memberId: agent.id,
    call: (path: string, method = 'GET', body?: unknown) =>
      app.request(
        `/api/workspaces/${f.workspaceId}${path}`,
        {
          method,
          headers: { Cookie: cookie, 'Content-Type': 'application/json', Origin: env.APP_URL },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
        env,
      ),
  }
}

async function fixture() {
  const auth = createAuth(db, env)
  const email = `${crypto.randomUUID()}@example.com`
  const password = 'correct-horse-battery-staple'
  const created = await auth.api.signUpEmail({ body: { email, password, name: 'Search owner' } })
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
    userName: 'Search owner',
    name: 'Inbox search',
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
