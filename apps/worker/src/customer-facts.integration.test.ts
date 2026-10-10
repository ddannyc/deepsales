import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  bootstrapWorkspace,
  connectFacebookPages,
  createDatabase,
  member,
  channelIdentity,
  customer,
  conversation,
  facebookMessagingWindow,
  processFacebookInbound,
  workspaceUserAccess,
  memberChannelAccess,
  takeOverConversation,
  humanMemberAvailability,
  customerPropertyHistory,
  customerPropertyValue,
} from '@deepsales/db'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Pool } from 'pg'
import { eq } from 'drizzle-orm'
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

describe.skipIf(!connectionString)('customer facts through authenticated routes', () => {
  beforeAll(async () => {
    await migrate(db, {
      migrationsFolder: resolve(
        dirname(fileURLToPath(import.meta.url)),
        '../../../packages/db/drizzle',
      ),
    })
  })
  afterAll(() => pool.end())

  it('persists customer contact details and rejects a stale edit without changing assignment', async () => {
    const f = await fixture()
    const before = await f.call(`/conversations/${f.conversationId}/customer-profile`)
    expect(before.status).toBe(200)
    const initial = (await before.json()) as { customer: { profileRevision: number } }
    const saved = await f.call(`/conversations/${f.conversationId}/customer-profile`, 'PATCH', {
      expectedRevision: initial.customer.profileRevision,
      displayName: 'Alex',
      email: 'alex@example.com',
      phone: '+12025550100',
      preferredLanguage: 'English',
      notes: 'Prefers compact options',
      ownerMemberId: f.memberId,
    })
    expect(saved.status).toBe(200)
    const stale = await f.call(`/conversations/${f.conversationId}/customer-profile`, 'PATCH', {
      expectedRevision: initial.customer.profileRevision,
      notes: 'Stale note',
    })
    expect(stale.status).toBe(409)
    const current = (await (
      await f.call(`/conversations/${f.conversationId}/customer-profile`)
    ).json()) as { customer: unknown }
    expect(current.customer).toMatchObject({
      displayName: 'Alex',
      email: 'alex@example.com',
      phone: '+12025550100',
      preferredLanguage: 'English',
      notes: 'Prefers compact options',
      ownerMemberId: f.memberId,
    })
    const conversation = (await (await f.call(`/conversations/${f.conversationId}`)).json()) as {
      conversation: { assigneeMemberId: string | null }
    }
    expect(conversation.conversation.assigneeMemberId).toBeNull()
    const competing = await Promise.all(
      ['First edit', 'Second edit'].map((notes) =>
        f.call(`/conversations/${f.conversationId}/customer-profile`, 'PATCH', {
          expectedRevision: 1,
          notes,
        }),
      ),
    )
    expect(competing.map((r) => r.status).sort()).toEqual([200, 409])
  })

  it('keeps scoped property values, their human source and edit protection, and refuses deletion with dependencies', async () => {
    const f = await fixture()
    const path = `/conversations/${f.conversationId}`
    const created = await f.call(`${path}/property-definitions`, 'POST', {
      name: 'Preference',
      level: 'CUSTOMER',
      type: 'OPTION',
      options: ['Small', 'Large'],
      maxLength: 100,
    })
    expect(created.status).toBe(200)
    const { definition } = (await created.json()) as { definition: { id: string } }
    expect(
      (
        await f.call(`${path}/properties/${definition.id}`, 'PUT', {
          value: 'Unknown',
          expectedRevision: 0,
          allowAutomaticUpdate: false,
        })
      ).status,
    ).toBe(400)
    expect(
      (
        await f.call(`${path}/properties/${definition.id}`, 'PUT', {
          value: 'Small',
          expectedRevision: 0,
          allowAutomaticUpdate: false,
        })
      ).status,
    ).toBe(200)
    expect(
      (
        await f.call(`${path}/properties/${definition.id}`, 'PUT', {
          value: 'Large',
          expectedRevision: 0,
          allowAutomaticUpdate: true,
        })
      ).status,
    ).toBe(409)
    const profile = (await (await f.call(`${path}/customer-profile`)).json()) as {
      values: { value: string; allowAutomaticUpdate: boolean }[]
      history: { sourceMemberId: string; value: string }[]
    }
    expect(profile.values).toMatchObject([{ value: 'Small', allowAutomaticUpdate: false }])
    expect(profile.history).toMatchObject([{ sourceMemberId: f.memberId, value: 'Small' }])
    expect((await f.call(`${path}/property-definitions/${definition.id}`, 'DELETE')).status).toBe(
      409,
    )
    expect(
      (
        await f.call(`${path}/property-definitions/${definition.id}`, 'PATCH', {
          level: 'CONVERSATION',
        })
      ).status,
    ).toBe(400)
  })

  it('adds a scoped tag once under concurrent requests and filters using the saved association', async () => {
    const f = await fixture()
    const path = `/conversations/${f.conversationId}`
    const created = await f.call(`${path}/tag-definitions`, 'POST', {
      name: 'Priority',
      level: 'CUSTOMER',
    })
    expect(created.status).toBe(200)
    const { tag } = (await created.json()) as { tag: { id: string } }
    const added = await Promise.all([
      f.call(`${path}/tags/${tag.id}`, 'PUT'),
      f.call(`${path}/tags/${tag.id}`, 'PUT'),
    ])
    expect(added.map((r) => r.status)).toEqual([200, 200])
    const profile = (await (await f.call(`${path}/customer-profile`)).json()) as {
      tags: { tagId: string }[]
    }
    expect(profile.tags.filter((t) => t.tagId === tag.id)).toHaveLength(1)
    const filtered = (await (
      await f.call(`/conversations?view=all-open&tagId=${tag.id}`)
    ).json()) as { conversations: { id: string }[] }
    expect(filtered.conversations.map((c) => c.id)).toEqual([f.conversationId])
    expect((await f.call(`${path}/tags/${tag.id}`, 'DELETE')).status).toBe(200)
    const empty = (await (await f.call(`/conversations?view=all-open&tagId=${tag.id}`)).json()) as {
      conversations: unknown[]
    }
    expect(empty.conversations).toEqual([])
  })

  it('previews and confirms identity links, rejects stale relinking, and preserves messages, assignment and send eligibility', async () => {
    const f = await fixture()
    await takeOverConversation(db, {
      workspaceId: f.workspaceId,
      conversationId: f.conversationId,
      actingUserId: f.userId,
    })
    const path = `/conversations/${f.conversationId}`
    const [identity] = await db
      .select()
      .from(channelIdentity)
      .where(eq(channelIdentity.channelId, f.channelId))
    const [target] = await db
      .insert(customer)
      .values({ workspaceId: f.workspaceId, displayName: 'Linked contact' })
      .returning()
    const [beforeWindow] = await db
      .select()
      .from(facebookMessagingWindow)
      .where(eq(facebookMessagingWindow.channelIdentityId, identity.id))
    const preview = await f.call(`${path}/identities/${identity.id}/preview`, 'POST', {
      targetCustomerId: target.id,
      expectedCustomerId: identity.customerId,
    })
    expect(preview.status).toBe(200)
    const linked = await Promise.all([
      f.call(`${path}/identities/${identity.id}`, 'PUT', {
        targetCustomerId: target.id,
        expectedCustomerId: identity.customerId,
        confirmed: true,
      }),
      f.call(`${path}/identities/${identity.id}`, 'PUT', {
        targetCustomerId: target.id,
        expectedCustomerId: identity.customerId,
        confirmed: true,
      }),
    ])
    expect(linked.map((r) => r.status).sort()).toEqual([200, 409])
    const [current] = await db
      .select()
      .from(channelIdentity)
      .where(eq(channelIdentity.id, identity.id))
    expect(current.customerId).toBe(target.id)
    expect(
      (
        await f.call(`${path}/customer-profile`, 'PATCH', {
          expectedRevision: 0,
          notes: 'Stale customer edit',
        })
      ).status,
    ).toBe(409)
    expect(
      (
        await f.call(`${path}/identities/${identity.id}`, 'PUT', {
          targetCustomerId: null,
          expectedCustomerId: target.id,
          confirmed: true,
        })
      ).status,
    ).toBe(200)
    const profile = (await (await f.call(`${path}/customer-profile`)).json()) as {
      customer: { id: string; displayName: string | null }
    }
    expect(profile.customer.id).not.toBe(target.id)
    expect(profile.customer.displayName).toBeNull()
    const [afterWindow] = await db
      .select()
      .from(facebookMessagingWindow)
      .where(eq(facebookMessagingWindow.channelIdentityId, identity.id))
    expect(afterWindow).toEqual(beforeWindow)
    const [thread] = await db
      .select()
      .from(conversation)
      .where(eq(conversation.id, f.conversationId))
    expect(thread.assigneeMemberId).toBe(f.memberId)
    const messages = (await (await f.call(`${path}/messages`)).json()) as {
      messages: { text: string }[]
    }
    expect(messages.messages.map((m) => m.text)).toEqual(['Hello'])
    const foreign = await fixture()
    const foreignProfile = (await (
      await foreign.call(`/conversations/${foreign.conversationId}/customer-profile`)
    ).json()) as { customer: { id: string } }
    expect(
      (
        await f.call(`${path}/identities/${identity.id}`, 'PUT', {
          targetCustomerId: foreignProfile.customer.id,
          expectedCustomerId: profile.customer.id,
          confirmed: true,
        })
      ).status,
    ).toBe(404)
  })
  it('shares only customer scope, validates numeric and text properties, and preserves history on definition deletion', async () => {
    const f = await fixture()
    const path = `/conversations/${f.conversationId}`
    const { definition: text } = (await (
      await f.call(`${path}/property-definitions`, 'POST', {
        name: 'Code',
        level: 'CUSTOMER',
        type: 'TEXT',
        maxLength: 3,
      })
    ).json()) as { definition: { id: string } }
    const { definition: number } = (await (
      await f.call(`${path}/property-definitions`, 'POST', {
        name: 'Score',
        level: 'CONVERSATION',
        type: 'NUMBER',
      })
    ).json()) as { definition: { id: string } }
    expect(
      (
        await f.call(`${path}/properties/${text.id}`, 'PUT', {
          value: 'long',
          expectedRevision: 0,
          allowAutomaticUpdate: false,
        })
      ).status,
    ).toBe(400)
    expect(
      (
        await f.call(`${path}/properties/${text.id}`, 'PUT', {
          value: 'yes',
          expectedRevision: 0,
          allowAutomaticUpdate: false,
        })
      ).status,
    ).toBe(200)
    expect(
      (
        await f.call(`${path}/properties/${number.id}`, 'PUT', {
          value: '1',
          expectedRevision: 0,
          allowAutomaticUpdate: false,
        })
      ).status,
    ).toBe(400)
    expect(
      (
        await f.call(`${path}/properties/${number.id}`, 'PUT', {
          value: 1.5,
          expectedRevision: 0,
          allowAutomaticUpdate: true,
        })
      ).status,
    ).toBe(200)
    const { tag: shared } = (await (
      await f.call(`${path}/tag-definitions`, 'POST', { name: 'Priority', level: 'CUSTOMER' })
    ).json()) as { tag: { id: string } }
    const { tag: local } = (await (
      await f.call(`${path}/tag-definitions`, 'POST', { name: 'Priority', level: 'CONVERSATION' })
    ).json()) as { tag: { id: string } }
    expect(
      (await f.call(`${path}/tag-definitions`, 'POST', { name: 'priority', level: 'CUSTOMER' }))
        .status,
    ).toBe(409)
    await f.call(`${path}/tags/${shared.id}`, 'PUT')
    await f.call(`${path}/tags/${local.id}`, 'PUT')
    const second = await processFacebookInbound(db, {
      ingressId: crypto.randomUUID(),
      pageId: f.pageId,
      externalUserId: crypto.randomUUID(),
      externalMessageId: crypto.randomUUID(),
      text: 'Second thread',
      providerSentAt: new Date(),
      receivedAt: new Date(),
      payloadSha256: 'b'.repeat(64),
      eventFragment: {},
    })
    if (second.kind !== 'created') throw new Error('Second inbound not created')
    const [secondThread] = await db
      .select()
      .from(conversation)
      .where(eq(conversation.id, second.conversationId))
    const [identity] = await db
      .select()
      .from(channelIdentity)
      .where(eq(channelIdentity.id, secondThread.channelIdentityId))
    expect(
      (
        await f.call(`/conversations/${second.conversationId}/identities/${identity.id}`, 'PUT', {
          expectedCustomerId: identity.customerId,
          targetCustomerId: f.customerId,
          confirmed: true,
        })
      ).status,
    ).toBe(200)
    const other = (await (
      await f.call(`/conversations/${second.conversationId}/customer-profile`)
    ).json()) as { values: { definitionId: string; value: unknown }[]; tags: { tagId: string }[] }
    expect(other.values).toMatchObject([{ definitionId: text.id, value: 'yes' }])
    expect(other.values.some((v) => v.definitionId === number.id)).toBe(false)
    expect(other.tags.map((t) => t.tagId)).toEqual([shared.id])
    expect(
      (
        await f.call(`${path}/property-definitions/${number.id}`, 'PATCH', {
          name: 'Rating',
          level: 'CONVERSATION',
          type: 'NUMBER',
          expectedRevision: 0,
        })
      ).status,
    ).toBe(200)
    expect(
      (
        await f.call(`${path}/property-definitions/${number.id}`, 'PATCH', {
          name: 'Stale name',
          level: 'CONVERSATION',
          type: 'NUMBER',
          expectedRevision: 0,
        })
      ).status,
    ).toBe(409)
    expect(
      (
        await f.call(`${path}/properties/${text.id}`, 'PUT', {
          value: null,
          expectedRevision: 1,
          allowAutomaticUpdate: false,
        })
      ).status,
    ).toBe(200)
    expect((await f.call(`${path}/property-definitions/${text.id}`, 'DELETE')).status).toBe(200)
    const latest = (await (await f.call(`${path}/customer-profile`)).json()) as {
      definitions: { id: string }[]
      history: { definitionName: string; value: unknown }[]
    }
    expect(latest.definitions.some((d) => d.id === text.id)).toBe(false)
    expect(latest.history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ definitionName: 'Code', value: 'yes' }),
        expect.objectContaining({ definitionName: 'Code', value: null }),
      ]),
    )
    expect((await f.call(`${path}/tag-definitions/${shared.id}`, 'DELETE')).status).toBe(200)
    const messages = (await (await f.call(`${path}/messages`)).json()) as {
      messages: { text: string }[]
    }
    expect(messages.messages.map((m) => m.text)).toEqual(['Hello'])
    const foreign = await fixture()
    const foreignTag = (await (
      await foreign.call(`/conversations/${foreign.conversationId}/tag-definitions`, 'POST', {
        name: 'Foreign',
        level: 'CUSTOMER',
      })
    ).json()) as { tag: { id: string } }
    expect((await f.call(`${path}/tags/${foreignTag.tag.id}`, 'PUT')).status).toBe(404)
    expect((await f.call(`/conversations?tagId=${foreignTag.tag.id}`)).status).toBe(404)
  })

  it('paginates every historical value without dropping equal timestamps and rejects foreign cursors', async () => {
    const f = await fixture()
    const path = `/conversations/${f.conversationId}`
    const { definition } = (await (
      await f.call(`${path}/property-definitions`, 'POST', {
        name: 'History',
        level: 'CUSTOMER',
        type: 'TEXT',
      })
    ).json()) as { definition: { id: string } }
    await f.call(`${path}/properties/${definition.id}`, 'PUT', {
      value: 'First',
      expectedRevision: 0,
      allowAutomaticUpdate: false,
    })
    const [value] = await db
      .select()
      .from(customerPropertyValue)
      .where(eq(customerPropertyValue.definitionId, definition.id))
    await db.insert(customerPropertyHistory).values(
      Array.from({ length: 104 }, (_, i) => ({
        valueId: value.id,
        definitionName: 'History',
        value: `Value ${i}`,
        revision: i + 2,
        allowAutomaticUpdate: false,
        sourceMemberId: f.memberId,
        sourceName: 'Profile owner',
        sourceChannelId: f.channelId,
      })),
    )
    const first = (await (await f.call(`${path}/customer-profile`)).json()) as {
      history: { id: string }[]
      nextHistoryCursor: string
    }
    expect(first.history).toHaveLength(100)
    const second = (await (
      await f.call(`${path}/property-history?before=${first.nextHistoryCursor}`)
    ).json()) as { history: { id: string }[]; nextHistoryCursor: string | null }
    expect(second.history).toHaveLength(5)
    expect(new Set([...first.history, ...second.history].map((h) => h.id)).size).toBe(105)
    expect(second.nextHistoryCursor).toBeNull()
    const foreign = await fixture()
    expect(
      (
        await foreign.call(
          `/conversations/${foreign.conversationId}/property-history?before=${first.nextHistoryCursor}`,
        )
      ).status,
    ).toBe(404)
    const targets = (await (await f.call(`${path}/customer-link-targets`)).json()) as {
      customers: { id: string }[]
      nextCursor: string | null
    }
    expect(targets.nextCursor).toBeNull()
  })

  it('keeps agent editing inside owned conversations and hides facts from linked restricted channels', async () => {
    const f = await fixture()
    const path = `/conversations/${f.conversationId}`
    const auth = createAuth(db, env)
    const email = `${crypto.randomUUID()}@example.com`
    const password = 'correct-horse-battery-staple'
    const created = await auth.api.signUpEmail({ body: { email, password, name: 'Agent' } })
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
        displayName: 'Agent',
      })
      .returning()
    await db.insert(humanMemberAvailability).values({ memberId: agent.id })
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
    const cookie = signed.headers.get('set-cookie')?.split(';', 1)[0] ?? ''
    const call = (p: string, method = 'GET', body?: unknown) =>
      app.request(
        `/api/workspaces/${f.workspaceId}${p}`,
        {
          method,
          headers: { Cookie: cookie, Origin: env.APP_URL, 'Content-Type': 'application/json' },
          ...customerEditRequest(p, method, body, f.customerId),
        },
        env,
      )
    expect(
      (
        await call(`${path}/customer-profile`, 'PATCH', {
          expectedRevision: 0,
          notes: 'Unowned edit',
        })
      ).status,
    ).toBe(403)
    await takeOverConversation(db, {
      workspaceId: f.workspaceId,
      conversationId: f.conversationId,
      actingUserId: created.user.id,
    })
    expect(
      (
        await call(`${path}/customer-profile`, 'PATCH', {
          expectedRevision: 0,
          notes: 'Agent note',
        })
      ).status,
    ).toBe(200)
    expect(
      (await call(`${path}/tag-definitions`, 'POST', { name: 'Forbidden', level: 'CUSTOMER' }))
        .status,
    ).toBe(403)
    const [profile] = await db
      .select()
      .from(channelIdentity)
      .where(eq(channelIdentity.channelId, f.channelId))
    const [hiddenChannel] = await connectFacebookPages(db, {
      workspaceId: f.workspaceId,
      actingUserId: f.userId,
      pages: [
        {
          pageId: crypto.randomUUID(),
          displayName: 'Restricted',
          encryptedPageAccessToken: 'cipher',
          tokenIv: 'iv',
          tokenKeyVersion: 'v1',
        },
      ],
    })
    const [hiddenIdentity] = await db
      .insert(channelIdentity)
      .values({
        workspaceId: f.workspaceId,
        channelId: hiddenChannel.id,
        customerId: profile.customerId,
        externalUserId: crypto.randomUUID(),
      })
      .returning()
    expect((await call(`${path}/customer-profile`)).status).toBe(403)
    expect(
      (
        await call(`${path}/customer-profile`, 'PATCH', {
          expectedRevision: 1,
          notes: 'Hidden edit',
        })
      ).status,
    ).toBe(403)
    expect(
      (
        await f.call(`${path}/identities/${hiddenIdentity.id}`, 'PUT', {
          targetCustomerId: null,
          expectedCustomerId: profile.customerId,
          confirmed: true,
        })
      ).status,
    ).toBe(200)
    expect((await call(`${path}/customer-profile`)).status).toBe(200)
    const foreign = await fixture()
    expect((await call(`/conversations/${foreign.conversationId}/customer-profile`)).status).toBe(
      404,
    )
    expect(
      (
        await f.call(`${path}/customer-profile`, 'PATCH', {
          expectedRevision: 1,
          ownerMemberId: foreign.memberId,
        })
      ).status,
    ).toBe(400)
  })
})

async function fixture() {
  const auth = createAuth(db, env)
  const email = `${crypto.randomUUID()}@example.com`
  const password = 'correct-horse-battery-staple'
  const created = await auth.api.signUpEmail({ body: { email, password, name: 'Profile owner' } })
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
  if (!cookie) throw new Error('Test sign-in did not set a cookie')
  const workspace = await bootstrapWorkspace(db, {
    userId: created.user.id,
    userName: 'Profile owner',
    name: 'Customer facts',
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
  const received = await processFacebookInbound(db, {
    ingressId: crypto.randomUUID(),
    pageId,
    externalUserId: crypto.randomUUID(),
    externalMessageId: crypto.randomUUID(),
    text: 'Hello',
    providerSentAt: new Date(),
    receivedAt: new Date(),
    payloadSha256: 'a'.repeat(64),
    eventFragment: {},
  })
  if (received.kind !== 'created') throw new Error('Inbound not created')
  const [owner] = await db
    .select({ id: member.id })
    .from(member)
    .where(eq(member.workspaceId, workspace.id))
  const [identity] = await db
    .select({ customerId: channelIdentity.customerId })
    .from(channelIdentity)
    .where(eq(channelIdentity.channelId, channel.id))
  return {
    workspaceId: workspace.id,
    memberId: owner.id,
    customerId: identity.customerId,
    userId: created.user.id,
    channelId: channel.id,
    pageId,
    conversationId: received.conversationId,
    call: (path: string, method = 'GET', body?: unknown) =>
      app.request(
        `/api/workspaces/${workspace.id}${path}`,
        {
          method,
          headers: { Cookie: cookie, 'Content-Type': 'application/json', Origin: env.APP_URL },
          ...customerEditRequest(path, method, body, identity.customerId),
        },
        env,
      ),
  }
}

function customerEditRequest(path: string, method: string, body: unknown, customerId: string) {
  if (method !== 'GET' && /\/(customer-profile|properties\/|tags\/)/.test(path))
    body = { expectedCustomerId: customerId, ...(body as Record<string, unknown>) }
  return body === undefined ? {} : { body: JSON.stringify(body) }
}
