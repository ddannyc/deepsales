import { createHmac } from 'node:crypto'
import {
  channel,
  createDatabase,
  facebookChannelConfig,
  member,
  message,
  processFacebookInbound,
} from '@deepsales/db'
import { expect, test } from '@playwright/test'
import { eq } from 'drizzle-orm'
import { Pool } from 'pg'
import { signInAndCreateWorkspace } from './auth'

test.skip(!process.env.E2E_BASE_URL, 'Set E2E_BASE_URL to a running test deployment')

test('pages all conversations and history, confirms visible inputs, and separates real receipt states', async ({
  page,
}) => {
  test.setTimeout(120_000)
  await signInAndCreateWorkspace(page, 'inbox-reading', 'Inbox reading acceptance')
  const { workspace } = (await (await page.request.get('/api/me')).json()) as {
    workspace: { id: string }
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  const db = createDatabase(pool)
  const pageId = crypto.randomUUID()
  const externalUserId = crypto.randomUUID()
  try {
    const [support] = await db
      .insert(channel)
      .values({ workspaceId: workspace.id, provider: 'FACEBOOK_MESSENGER', displayName: 'Support' })
      .returning()
    await db.insert(facebookChannelConfig).values({
      channelId: support.id,
      pageId,
      encryptedPageAccessToken: 'test-cipher',
      tokenIv: 'test-iv',
      tokenKeyVersion: 'v1',
    })
    const inbound = (identity: string, text: string) =>
      processFacebookInbound(db, {
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
    const identities: { externalId: string; conversationId: string }[] = []
    for (let i = 0; i < 64; i += 1) {
      const externalId = crypto.randomUUID()
      const received = await inbound(externalId, `Customer ${i}`)
      if (received.kind !== 'created') throw new Error('Inbound not created')
      identities.push({ externalId, conversationId: received.conversationId })
    }
    const result = await inbound(externalUserId, 'Current customer input')
    if (result.kind !== 'created') throw new Error('Inbound not created')
    const [owner] = await db
      .select({ id: member.id })
      .from(member)
      .where(eq(member.workspaceId, workspace.id))
    await db.insert(message).values(
      Array.from({ length: 203 }, (_, i) => ({
        conversationId: result.conversationId,
        channelId: support.id,
        direction: 'INBOUND' as const,
        senderType: 'CUSTOMER' as const,
        text: `Historical input ${i}`,
        createdAt: new Date(Date.now() - (204 - i) * 60_000),
      })),
    )
    const mid = crypto.randomUUID()
    await db.insert(message).values(
      ['PENDING', 'SENT', 'FAILED'].map((deliveryState, i) => ({
        conversationId: result.conversationId,
        channelId: support.id,
        direction: 'OUTBOUND' as const,
        senderType: 'MEMBER' as const,
        senderMemberId: owner.id,
        text: `Outbound ${deliveryState}`,
        deliveryState: deliveryState as 'PENDING' | 'SENT' | 'FAILED',
        externalMessageId: deliveryState === 'SENT' ? mid : null,
        createdAt: new Date(Date.now() - 1000 + i),
      })),
    )
    await page.getByRole('button', { name: '刷新对话', exact: true }).click()
    await expect(page.locator('.conversation-item')).toHaveCount(50)
    await expect(page.locator('.message-bubble')).toHaveCount(100)
    await expect(page.locator('.message-list')).toContainText('Current customer input')
    await expect(page.locator('.message-list')).toContainText('发送中')
    await expect(page.locator('.message-list')).toContainText('发送失败')
    await expect(page.locator('.message-list')).toContainText('送达状态未知')
    const unread = async () =>
      (
        await (
          await page.request.get(
            `/api/workspaces/${workspace.id}/conversations/${result.conversationId}`,
          )
        ).json()
      ).conversation.unread as boolean
    expect(await unread()).toBe(true)
    await page.getByRole('combobox', { name: '消息筛选', exact: true }).click()
    await page.getByRole('option', { name: '未读', exact: true }).click()
    await expect(page.locator('.conversation-items')).toContainText('Current customer input')
    const loaded = (await (
      await page.request.get(`/api/workspaces/${workspace.id}/conversations`)
    ).json()) as { conversations: { id: string }[] }
    const moved = identities.find(
      (identity) => !loaded.conversations.some((c) => c.id === identity.conversationId),
    )
    if (!moved) throw new Error('No next-page conversation')
    await inbound(moved.externalId, 'Updated while paging')
    let failMore = true
    await page.route('**/conversations?*', async (route) => {
      if (failMore && new URL(route.request().url()).searchParams.has('cursor')) {
        failMore = false
        await route.fulfill({ status: 503, contentType: 'application/json', body: '{}' })
      } else await route.continue()
    })
    await page.getByRole('button', { name: '加载更多对话', exact: true }).click()
    await expect(page.locator('.conversation-item')).toHaveCount(50)
    await expect(page.getByRole('alert').first()).toBeVisible()
    await page.getByRole('button', { name: '加载更多对话', exact: true }).click()
    await expect(page.locator('.conversation-item')).toHaveCount(65)
    await expect(page.locator('.conversation-items')).toContainText('Updated while paging')
    await page.unroute('**/conversations?*')
    await page.getByRole('button', { name: '加载更早消息', exact: true }).click()
    await expect(page.locator('.message-bubble')).toHaveCount(200)
    await page.getByRole('button', { name: '加载更早消息', exact: true }).click()
    await expect(page.locator('.message-bubble')).toHaveCount(207)
    await expect(page.getByRole('button', { name: '加载更早消息', exact: true })).toHaveCount(0)
    const customer = { sender: { id: externalUserId }, recipient: { id: pageId } }
    const body = JSON.stringify({
      object: 'page',
      entry: [
        {
          id: pageId,
          messaging: [
            { ...customer, delivery: { mids: [mid] } },
            { ...customer, read: { watermark: 1700000000001 } },
            {
              sender: { id: pageId },
              recipient: { id: externalUserId },
              timestamp: 1700000000000,
              message: { mid, is_echo: true },
            },
          ],
        },
      ],
    })
    const signature = `sha256=${createHmac('sha256', 'e2e-meta-app-secret').update(body).digest('hex')}`
    expect(
      (
        await page.request.post('/webhooks/facebook', {
          data: body,
          headers: { 'x-hub-signature-256': signature, 'Content-Type': 'application/json' },
        })
      ).status(),
    ).toBe(200)
    await expect
      .poll(
        async () =>
          (
            await (
              await page.request.get(
                `/api/workspaces/${workspace.id}/conversations/${result.conversationId}/messages?history=latest`,
              )
            ).json()
          ).messages.find((m: { externalMessageId: string }) => m.externalMessageId === mid)?.read,
        { timeout: 20_000 },
      )
      .toBe(true)
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect(page.locator('.message-list')).toContainText('客户已读')
    await expect(page.locator('.message-bubble')).toHaveCount(207)
    const visibleIds = await page.locator('[data-customer-message-id]').evaluateAll((elements) =>
      elements
        .filter((element) => {
          const root = element
            .closest('[data-slot="scroll-area-viewport"]')
            ?.getBoundingClientRect()
          const bounds = element.getBoundingClientRect()
          return root && bounds.bottom > root.top && bounds.top < root.bottom
        })
        .map((element) => (element as HTMLElement).dataset.customerMessageId),
    )
    expect(visibleIds.length).toBeGreaterThan(0)
    expect(await unread()).toBe(true)
    const inputs = page.locator('[data-customer-message-id]')
    for (let index = 0; index < (await inputs.count()); index += 1)
      await inputs.nth(index).scrollIntoViewIfNeeded()
    await expect.poll(unread, { timeout: 20_000 }).toBe(false)
    // Bulk read confirmations finish refreshing both list pages before clearing selection.
    await expect(page.locator('.message-bubble')).toHaveCount(0, { timeout: 20_000 })
    await page.reload()
    await expect.poll(unread).toBe(false)
    const readConversation = page
      .locator('.conversation-item')
      .filter({ hasText: 'Current customer input' })
    await expect(readConversation).not.toContainText('未读')
    await readConversation.click()
    await expect(page.locator('.message-list')).toContainText('Current customer input')
    await page.getByRole('button', { name: '接管', exact: true }).click()
    await page.getByRole('button', { name: '更多对话操作', exact: true }).click()
    await page.getByRole('menuitem', { name: '关闭对话', exact: true }).click()
    await page.getByRole('button', { name: '关闭对话', exact: true }).click()
    await page.getByRole('button', { name: '已关闭历史', exact: true }).click()
    await expect(page.locator('.conversation-item')).toHaveCount(1)
    await expect(page.locator('.message-list')).toContainText('Current customer input')
    await expect(page.getByRole('button', { name: '接管', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: '发送回复', exact: true })).toBeDisabled()
    await inbound(externalUserId, 'New conversation input')
    await page.getByRole('button', { name: '全部进行中', exact: true }).click()
    await expect(page.locator('.message-list')).toContainText('New conversation input')
    await page.getByRole('combobox', { name: '消息筛选', exact: true }).click()
    await page.getByRole('option', { name: '未回复', exact: true }).click()
    await expect(page.locator('.conversation-list')).toContainText('New conversation input')
    await page.reload()
    await expect(page.locator('.message-list')).toContainText('New conversation input')
    let release: () => void = () => {}
    let started: () => void = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const requested = new Promise<void>((resolve) => {
      started = resolve
    })
    let holdNext = true
    await page.route('**/conversations?view=all-open*', async (route) => {
      if (!holdNext) return route.continue()
      holdNext = false
      const response = await route.fetch()
      started()
      await held
      await route.fulfill({ response })
    })
    await page.getByRole('button', { name: '刷新对话', exact: true }).click()
    await requested
    await page.getByRole('button', { name: '我的对话', exact: true }).click()
    await expect(page.getByRole('heading', { name: '我的对话', exact: true })).toBeVisible()
    await expect(page.locator('.conversation-item')).toHaveCount(0)
    const response = page.waitForResponse((r) => r.url().includes('conversations?view=all-open'))
    release()
    await response
    await expect(page.locator('.conversation-item')).toHaveCount(0)
    await page.unroute('**/conversations?view=all-open*')
  } finally {
    await pool.end()
  }
})
