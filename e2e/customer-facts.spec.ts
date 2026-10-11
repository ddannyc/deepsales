import {
  channel,
  createDatabase,
  customer,
  facebookChannelConfig,
  processFacebookInbound,
  processFacebookReferral,
} from '@deepsales/db'
import { expect, test } from '@playwright/test'
import { Pool } from 'pg'
import { signInAndCreateWorkspace } from './auth'

test.skip(!process.env.E2E_BASE_URL, 'Set E2E_BASE_URL to a running test deployment')

test('customer facts survive refresh and tags and identity changes preserve the thread', async ({
  page,
}) => {
  await signInAndCreateWorkspace(page, 'customer-facts', 'Customer facts acceptance')
  const { workspace } = (await (await page.request.get('/api/me')).json()) as {
    workspace: { id: string }
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  const db = createDatabase(pool)
  const pageId = crypto.randomUUID()
  const visitor = crypto.randomUUID()
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
    await processFacebookInbound(db, {
      ingressId: crypto.randomUUID(),
      pageId,
      externalUserId: visitor,
      externalMessageId: crypto.randomUUID(),
      text: 'Hello from customer',
      providerSentAt: new Date(),
      receivedAt: new Date(),
      payloadSha256: 'a'.repeat(64),
      eventFragment: {},
    })
    await processFacebookReferral(db, {
      pageId,
      externalUserId: visitor,
      externalMessageId: null,
      providerSentAt: '2026-01-01T12:00:00.000Z',
      receivedAt: new Date(),
      source: 'ADS',
      type: 'OPEN_THREAD',
      ref: 'neutral-catalog',
      adId: 'neutral-lamp-ad',
      adTitle: 'Compact desk lamp',
      imageUrl: 'https://example.com/untrusted-photo.png',
      refererUri: null,
    })
    const [target] = await db
      .insert(customer)
      .values({ workspaceId: workspace.id, displayName: 'Second contact' })
      .returning()
    await page.getByRole('button', { name: '刷新对话' }).click()
    await expect(page.getByText('Hello from customer', { exact: true }).last()).toBeVisible()
    await page.getByRole('button', { name: '客户资料', exact: true }).click()
    const sources = page.getByRole('region', { name: '来源轨迹', exact: true })
    await expect(sources).toContainText('Compact desk lamp')
    await expect(sources).toContainText('neutral-lamp-ad')
    await expect(sources).toContainText('来源提供图片（未加载）')
    await expect(sources.locator('img')).toHaveCount(0)
    await sources.screenshot({ path: test.info().outputPath('referral-timeline.png') })
    await page.getByLabel('客户名称', { exact: true }).fill('Alex')
    await page.getByLabel('电子邮箱', { exact: true }).fill('alex@example.com')
    await page.getByRole('button', { name: '保存客户资料', exact: true }).click()
    await expect(page.getByRole('status').filter({ hasText: '已保存' })).toBeVisible()
    await page.getByRole('button', { name: '新增客户属性', exact: true }).click()
    await page.getByLabel('属性名称', { exact: true }).fill('Preference')
    await page.getByRole('button', { name: '保存属性定义', exact: true }).click()
    await page.getByLabel('Preference', { exact: true }).fill('Compact')
    await page.getByRole('button', { name: '保存Preference', exact: true }).click()
    await expect(page.getByRole('region', { name: '属性修改历史' })).toContainText('Compact')
    await page.getByRole('button', { name: '删除Preference定义', exact: true }).click()
    await expect(page.getByRole('dialog').last()).toContainText('现存值依赖：1')
    await expect(page.getByRole('button', { name: '确认删除', exact: true })).toBeDisabled()
    await page.getByRole('button', { name: '取消', exact: true }).click()
    await page.getByRole('button', { name: '新增客户标签', exact: true }).click()
    await page.getByLabel('标签名称', { exact: true }).fill('Priority')
    await page.getByRole('button', { name: '保存标签定义', exact: true }).click()
    await page.getByLabel('Priority', { exact: true }).click()
    await expect(page.getByLabel('Priority', { exact: true })).toBeChecked()
    await page.reload()
    await page.getByRole('button', { name: '客户资料', exact: true }).click()
    await expect(page.getByLabel('客户名称', { exact: true })).toHaveValue('Alex')
    await expect(page.getByLabel('Preference', { exact: true })).toHaveValue('Compact')
    await expect(page.getByLabel('Priority', { exact: true })).toBeChecked()
    await page.getByRole('button', { name: '筛选Priority', exact: true }).click()
    await expect(
      page.getByRole('button', { name: '清除标签筛选：Priority', exact: true }),
    ).toBeVisible()
    await expect(page.locator('.conversation-items')).toContainText('Alex')
    await page.getByRole('button', { name: '清除标签筛选：Priority', exact: true }).click()
    await page.getByRole('button', { name: '客户资料', exact: true }).click()
    await page.getByRole('button', { name: '加载可关联客户', exact: true }).click()
    await page.getByLabel('目标客户', { exact: true }).selectOption(target.id)
    await page.getByRole('button', { name: '预览身份关联', exact: true }).click()
    await expect(page.getByRole('dialog').last()).toContainText('影响该身份的 1 个会话')
    await page.getByRole('button', { name: '确认更改关联', exact: true }).click()
    await expect(page.getByLabel('客户名称', { exact: true })).toHaveValue('Second contact')
    await expect(page.getByRole('button', { name: /解除身份 .* 关联/ })).toBeVisible()
    await page.getByRole('button', { name: /解除身份 .* 关联/ }).click()
    await page.getByRole('button', { name: '确认更改关联', exact: true }).click()
    await expect(page.getByLabel('客户名称', { exact: true })).toHaveValue('')
    await expect(page.getByRole('button', { name: '确认更改关联', exact: true })).toBeHidden()
    await page.getByRole('button', { name: '关闭客户资料', exact: true }).click()
    await expect(page.locator('.message-bubble')).toContainText('Hello from customer')
    let releaseInitial: () => void = () => {}
    let initialStarted: () => void = () => {}
    const heldInitial = new Promise<void>((resolve) => {
      releaseInitial = resolve
    })
    const started = new Promise<void>((resolve) => {
      initialStarted = resolve
    })
    let profileReads = 0
    await page.route('**/customer-profile', async (route) => {
      if (++profileReads === 1) {
        const response = await route.fetch()
        initialStarted()
        await heldInitial
        await route.fulfill({ response })
        return
      }
      await route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'FORBIDDEN' } }),
      })
    })
    await page.getByRole('button', { name: '客户资料', exact: true }).click()
    await started
    await page.getByRole('button', { name: '刷新资料', exact: true }).click()
    await expect(page.getByRole('alert').last()).toContainText('无权查看或编辑')
    const delayedResponse = page.waitForResponse(
      (response) => response.url().endsWith('/customer-profile') && response.status() === 200,
    )
    releaseInitial()
    await delayedResponse
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    )
    await expect(page.getByLabel('客户名称', { exact: true })).toHaveCount(0)
  } finally {
    await pool.end()
  }
})
