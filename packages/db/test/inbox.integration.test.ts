import { randomUUID } from 'node:crypto'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import {
  bootstrapWorkspace,
  channelIdentity,
  connectFacebookPages,
  conversation,
  createDatabase,
  customer,
  disableFacebookChannel,
  facebookMessagingWindow,
  facebookWebhookReceipt,
  listConversations,
  listMessages,
  markFacebookChannelHealth,
  message,
  processFacebookInbound,
  user,
} from '../src'

const connectionString = process.env.DATABASE_URL

describe.skipIf(!connectionString)('durable Facebook inbox intake', () => {
  const pool = new Pool({ connectionString })
  const db = createDatabase(pool)

  beforeAll(async () => {
    await migrate(db, { migrationsFolder: 'drizzle' })
  })

  afterAll(() => pool.end())

  it('deduplicates duplicate mids and concurrent first messages into one open conversation', async () => {
    const ownerId = randomUUID()
    const pageId = randomUUID()
    await db
      .insert(user)
      .values({ id: ownerId, name: 'Inbox owner', email: `${ownerId}@example.com` })
    const workspace = await bootstrapWorkspace(db, {
      userId: ownerId,
      userName: 'Inbox owner',
      name: 'Inbox concurrency',
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
    if (!connected) throw new Error('Facebook channel was not created')
    const runId = randomUUID()

    await expect(
      processFacebookInbound(
        db,
        inbound(randomUUID(), 'unknown-mid', 'ignored', `${runId}-ignored`),
      ),
    ).resolves.toMatchObject({ kind: 'ignored' })

    const duplicateInput = inbound(pageId, 'same-mid', 'first', `${runId}-1`)
    const duplicateResults = await Promise.all([
      processFacebookInbound(db, duplicateInput),
      processFacebookInbound(db, {
        ...duplicateInput,
        ingressId: `${runId}-2`,
        externalUserId: 'customer-2',
      }),
    ])
    expect(duplicateResults.filter((result) => result.kind === 'created')).toHaveLength(1)
    expect(duplicateResults.filter((result) => result.kind === 'duplicate-message')).toHaveLength(1)

    await Promise.all([
      processFacebookInbound(db, inbound(pageId, 'mid-2', 'second', `${runId}-3`)),
      processFacebookInbound(db, inbound(pageId, 'mid-3', 'third', `${runId}-4`)),
    ])

    expect(
      await db.select().from(customer).where(eq(customer.workspaceId, workspace.id)),
    ).toHaveLength(1)
    const identities = await db
      .select()
      .from(channelIdentity)
      .where(eq(channelIdentity.workspaceId, workspace.id))
    expect(identities).toHaveLength(1)
    const conversations = await db
      .select()
      .from(conversation)
      .where(eq(conversation.workspaceId, workspace.id))
    expect(conversations).toHaveLength(1)
    expect(conversations[0]).toEqual(
      expect.objectContaining({
        status: 'OPEN',
        assigneeMemberId: null,
        queueReason: 'NEW_CONVERSATION',
        routingConstraint: 'ANY_MEMBER',
      }),
    )
    expect(await db.select().from(message).where(eq(message.channelId, connected.id))).toHaveLength(
      3,
    )
    expect(
      await db
        .select()
        .from(facebookMessagingWindow)
        .where(eq(facebookMessagingWindow.channelIdentityId, identities[0]?.id ?? '')),
    ).toHaveLength(1)
    const receipts = await db
      .select()
      .from(facebookWebhookReceipt)
      .where(eq(facebookWebhookReceipt.pageId, pageId))
    expect(receipts).toHaveLength(4)
    expect(receipts.every((receipt) => receipt.processedAt)).toBe(true)

    const inbox = await listConversations(db, {
      workspaceId: workspace.id,
      userId: ownerId,
      view: 'unassigned',
    })
    expect(inbox.conversations).toHaveLength(1)
    expect(inbox.conversations[0]).toEqual(
      expect.objectContaining({
        customerName: null,
        channelName: 'Support',
        latestPreview: expect.any(String),
        failedMessage: false,
      }),
    )
    const thread = await listMessages(db, {
      workspaceId: workspace.id,
      userId: ownerId,
      conversationId: conversations[0]?.id ?? '',
    })
    expect(thread.messages).toHaveLength(3)
    expect(thread.messages.map(({ text }) => text)).toEqual(
      expect.arrayContaining(['first', 'second', 'third']),
    )

    await disableFacebookChannel(db, {
      workspaceId: workspace.id,
      channelId: connected.id,
      userId: ownerId,
    })
    await expect(
      processFacebookInbound(db, inbound(pageId, 'disabled-mid', 'ignored', `${runId}-disabled`)),
    ).resolves.toMatchObject({ kind: 'ignored' })
  })

  it('keeps inbound messages when the Facebook connection needs attention', async () => {
    const ownerId = randomUUID()
    const pageId = randomUUID()
    await db
      .insert(user)
      .values({ id: ownerId, name: 'Inbox owner', email: `${ownerId}@example.com` })
    const workspace = await bootstrapWorkspace(db, {
      userId: ownerId,
      userName: 'Inbox owner',
      name: 'Inbox health warning',
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
    if (!connected) throw new Error('Facebook channel was not created')

    await markFacebookChannelHealth(db, {
      workspaceId: workspace.id,
      channelId: connected.id,
      userId: ownerId,
      active: false,
      error: { code: 'FACEBOOK_CHECK_FAILED', message: 'subscription check failed' },
    })

    const result = await processFacebookInbound(
      db,
      inbound(pageId, 'health-warning-mid', 'still received', randomUUID()),
    )
    expect(result).toMatchObject({ kind: 'created', workspaceId: workspace.id })

    const inbox = await listConversations(db, {
      workspaceId: workspace.id,
      userId: ownerId,
      view: 'all-open',
    })
    expect(inbox.conversations).toHaveLength(1)
    expect(inbox.conversations[0]?.latestPreview).toBe('still received')
  })
})

function inbound(pageId: string, externalMessageId: string, text: string, ingressId: string) {
  const receivedAt = new Date()
  return {
    ingressId,
    pageId,
    externalUserId: 'customer-1',
    externalMessageId,
    text,
    providerSentAt: receivedAt,
    receivedAt,
    payloadSha256: 'a'.repeat(64),
    eventFragment: { pageId, externalMessageId },
  }
}
