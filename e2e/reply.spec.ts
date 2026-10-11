import {
  channel,
  createDatabase,
  facebookChannelConfig,
  setMemberChannelAccess,
} from '@deepsales/db'
import { expect, test } from '@playwright/test'
import { Pool } from 'pg'
import { encryptFacebookToken } from '../apps/worker/src/facebook'
import { signInAndCreateWorkspace } from './auth'

test.skip(!process.env.E2E_BASE_URL, 'Set E2E_BASE_URL to a running DeepSales deployment')

test('human can take over, send a reply, and see SENT or FAILED', async ({ page }) => {
  const suffix = Date.now()
  await signInAndCreateWorkspace(page, 'reply', 'Reply acceptance')
  await expect(page.getByRole('heading', { name: '全部进行中', exact: true })).toBeVisible()

  const me = (await page.request.get('/api/me').then((response) => response.json())) as {
    user: { id: string }
    workspace: { id: string; memberId: string }
  }
  const workspace = me.workspace
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  const db = createDatabase(pool)
  const pageId = `e2e-reply-page-${suffix}`
  try {
    const [createdChannel] = await db
      .insert(channel)
      .values({ workspaceId: workspace.id, provider: 'FACEBOOK_MESSENGER', displayName: 'Support' })
      .returning({ id: channel.id })
    if (!createdChannel) throw new Error('Channel was not created')
    const encrypted = await encryptFacebookToken(
      'fake-page-token',
      'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    )
    await db.insert(facebookChannelConfig).values({
      channelId: createdChannel.id,
      pageId,
      encryptedPageAccessToken: encrypted.ciphertext,
      tokenIv: encrypted.iv,
      tokenKeyVersion: encrypted.keyVersion,
    })
    await setMemberChannelAccess(db, {
      workspaceId: workspace.id,
      memberId: workspace.memberId,
      actingUserId: me.user.id,
      channelIds: [createdChannel.id],
    })
  } finally {
    await pool.end()
  }

  await page.request.patch(`/api/workspaces/${workspace.id}/members/${workspace.memberId}`, {
    data: { autoAssignmentEnabled: false },
  })

  const body = JSON.stringify({
    object: 'page',
    entry: [
      {
        id: pageId,
        messaging: [
          {
            timestamp: Date.now(),
            sender: { id: `e2e-reply-customer-${suffix}` },
            recipient: { id: pageId },
            message: { mid: `e2e-reply-mid-${suffix}`, text: ' hello from Messenger ' },
          },
        ],
      },
    ],
  })
  const signature = await sign(body, 'e2e-meta-app-secret')
  await page.request.post('/webhooks/facebook', {
    headers: { 'x-hub-signature-256': `sha256=${signature}` },
    data: body,
  })

  await expect(page.getByText('hello from Messenger', { exact: true }).first()).toBeVisible({
    timeout: 10_000,
  })
  await page.getByRole('button', { name: '接管', exact: true }).click()
  const composer = page.locator('form.reply-composer')
  await expect(composer).toBeVisible()
  await composer.getByLabel('回复客户').fill('hello from human')
  const replyResponse = page.waitForResponse(
    (response) => response.url().includes('/replies') && response.request().method() === 'POST',
  )
  await composer.getByRole('button', { name: '发送回复', exact: true }).click()
  expect((await (await replyResponse).json()).message.deliveryState).toBe('PENDING')
  await expect(page.getByText('已发送', { exact: true })).toBeVisible({ timeout: 10_000 })

  const incomingTranslation = page.getByRole('region', { name: '消息翻译' }).first()
  await incomingTranslation.getByRole('switch', { name: '显示译文' }).click()
  await incomingTranslation.getByRole('button', { name: '预览译文', exact: true }).click()
  await expect(
    incomingTranslation.getByText('来自 Messenger 的问候', { exact: true }),
  ).toBeVisible()
  await expect(
    page.locator('.inbox-thread').getByText('hello from Messenger', { exact: true }),
  ).toBeVisible()

  await composer.getByRole('switch', { name: '发送前翻译' }).click()
  await composer.getByLabel('回复客户').fill('你好')
  const translation = composer.getByRole('region', { name: '发送翻译' })
  await translation.getByRole('button', { name: '预览译文', exact: true }).click()
  await expect(translation.getByText('Hello', { exact: true })).toBeVisible()
  await expect(composer.getByLabel('回复客户')).toHaveValue('你好')
  await expect(page.locator('.message-bubble').getByText('Hello', { exact: true })).toHaveCount(0)
  await composer.getByLabel('回复客户').press('Enter')
  await expect(page.locator('.message-bubble').getByText('Hello', { exact: true })).toHaveCount(0)
  await composer.getByLabel('回复客户').fill('再见')
  await expect(translation.getByRole('button', { name: '确认发送译文', exact: true })).toHaveCount(
    0,
  )
  await expect(
    translation.getByText('原稿或目标语言已变化，旧译文失效。请重新翻译。'),
  ).toBeVisible()
  await translation.getByRole('button', { name: '预览译文', exact: true }).click()
  await expect(translation.getByText('Goodbye', { exact: true })).toBeVisible()
  await translation.getByRole('button', { name: '确认发送译文', exact: true }).click()
  await expect(composer.getByLabel('回复客户')).toHaveValue('')
  await expect(page.locator('.message-bubble').getByText('Goodbye', { exact: true })).toBeVisible()

  await composer.getByLabel('回复客户').fill('你好')
  await page.route('**/translations', (route) =>
    route.fulfill({ status: 409, json: { error: { code: 'QUOTA_EXHAUSTED' } } }),
  )
  await translation.getByRole('button', { name: '预览译文', exact: true }).click()
  await expect(translation.getByRole('alert')).toContainText('翻译额度不足')
  await expect(composer.getByLabel('回复客户')).toHaveValue('你好')
  await expect(translation.getByRole('button', { name: '确认发送译文', exact: true })).toHaveCount(
    0,
  )
  await page.unroute('**/translations')
  let release: () => void = () => {}
  let received: () => void = () => {}
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  const started = new Promise<void>((resolve) => {
    received = resolve
  })
  await page.route('**/translations', async (route) => {
    const response = await route.fetch()
    received()
    await pending
    await route.fulfill({ response })
  })
  await translation.getByRole('button', { name: '预览译文', exact: true }).click()
  await started
  await composer.getByLabel('回复客户').fill('新原稿')
  release()
  await expect(translation.getByRole('button', { name: '预览译文', exact: true })).toBeEnabled()
  await expect(translation.getByRole('button', { name: '确认发送译文', exact: true })).toHaveCount(
    0,
  )
  await expect(composer.getByLabel('回复客户')).toHaveValue('新原稿')
  await page.unroute('**/translations')
  await composer.getByRole('switch', { name: '发送前翻译' }).click()

  await composer.getByLabel('回复客户').fill('force failure')
  await composer.getByRole('button', { name: '发送回复', exact: true }).click()
  await expect(page.locator('.inbox-thread').getByText('发送失败', { exact: true })).toBeVisible({
    timeout: 10_000,
  })
})

async function sign(body: string, secret: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body))
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  )
}
