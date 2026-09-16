import { createHmac } from 'node:crypto'
import { channel, createDatabase, facebookChannelConfig } from '@deepsales/db'
import { expect, test } from '@playwright/test'
import { Pool } from 'pg'

test.skip(!process.env.E2E_BASE_URL, 'Set E2E_BASE_URL to a running DeepSales deployment')

test('fake Messenger text appears in the inbox without reloading', async ({ page }) => {
  const suffix = Date.now()
  const password = 'correct-horse-battery-staple'

  await page.goto('/login')
  await page.getByRole('button', { name: '创建账户视图', exact: true }).click()
  await page.getByLabel('姓名').fill('Ada Lovelace')
  await page.getByLabel('工作邮箱').fill(`inbox-${suffix}@example.com`)
  await page.getByLabel('密码').fill(password)
  await page.getByRole('button', { name: '创建账户', exact: true }).click()
  await page.getByLabel('工作区名称').fill('Inbox acceptance')
  await page.getByRole('button', { name: '创建工作区' }).click()
  await expect(page.getByRole('heading', { name: '全部进行中', exact: true })).toBeVisible()

  const workspace = (
    (await (await page.request.get('/api/me')).json()) as {
      workspace: { id: string }
    }
  ).workspace
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  const db = createDatabase(pool)
  const pageId = `e2e-inbox-page-${suffix}`
  try {
    const [createdChannel] = await db
      .insert(channel)
      .values({ workspaceId: workspace.id, provider: 'FACEBOOK_MESSENGER', displayName: 'Support' })
      .returning({ id: channel.id })
    if (!createdChannel) throw new Error('Channel was not created')
    await db.insert(facebookChannelConfig).values({
      channelId: createdChannel.id,
      pageId,
      encryptedPageAccessToken: 'test-cipher',
      tokenIv: 'test-iv',
      tokenKeyVersion: 'v1',
    })

    const currentUrl = page.url()
    const body = JSON.stringify({
      object: 'page',
      entry: [
        {
          id: pageId,
          messaging: [
            {
              timestamp: Date.now(),
              sender: { id: 'e2e-customer-1' },
              recipient: { id: pageId },
              message: {
                mid: `e2e-mid-${suffix}`,
                text: 'hello from Messenger',
                ...(process.env.E2E_FAKE_FACEBOOK_URL
                  ? {
                      attachments: ['image', 'file', 'audio', 'video'].map((kind) => ({
                        type: kind === 'image' ? 'image' : kind,
                        payload: {
                          url: `${process.env.E2E_FAKE_FACEBOOK_URL}/attachments/${kind}`,
                          filename: `${kind}.fixture`,
                        },
                      })),
                    }
                  : {}),
              },
            },
          ],
        },
      ],
    })
    const response = await page.request.post('/webhooks/facebook', {
      headers: { 'x-hub-signature-256': `sha256=${sign(body, 'e2e-meta-app-secret')}` },
      data: body,
    })
    expect(response.status()).toBe(200)

    await expect(page.getByText('hello from Messenger', { exact: true }).first()).toBeVisible({
      timeout: 10_000,
    })
    if (process.env.E2E_FAKE_FACEBOOK_URL) {
      await expect(page.locator('.attachment-image-link img')).toBeVisible({ timeout: 10_000 })
      for (const kind of ['file', 'audio', 'video']) {
        await expect(page.getByRole('link', { name: `${kind}.fixture` })).toBeVisible({
          timeout: 10_000,
        })
      }
    }
    expect(page.url()).toBe(currentUrl)
  } finally {
    await pool.end()
  }
})

function sign(body: string, secret: string) {
  return createHmac('sha256', secret).update(body).digest('hex')
}
