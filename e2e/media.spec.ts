import {
  connectFacebookPages,
  createDatabase,
  processFacebookInbound,
  setMemberChannelAccess,
} from '@deepsales/db'
import { expect, test } from '@playwright/test'
import { Pool } from 'pg'
import { encryptFacebookToken } from '../apps/worker/src/facebook'
import { signInAndCreateWorkspace } from './auth'

test.skip(!process.env.E2E_BASE_URL, 'Set E2E_BASE_URL to a running test deployment')
test.use({
  launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] },
})

test('previews and cancels recording, edits text drafts and safely sends private media after library deletion', async ({
  page,
  browser,
}) => {
  test.setTimeout(90_000)
  await signInAndCreateWorkspace(page, 'media', 'Media acceptance')
  const me = (await (await page.request.get('/api/me')).json()) as {
    user: { id: string }
    workspace: { id: string; memberId: string }
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  const db = createDatabase(pool)
  const otherContext = await browser.newContext()
  try {
    const token = await encryptFacebookToken(
      'fake-page-token',
      'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    )
    const pageId = crypto.randomUUID()
    const recipient = crypto.randomUUID()
    const [channel] = await connectFacebookPages(db, {
      workspaceId: me.workspace.id,
      actingUserId: me.user.id,
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
    await setMemberChannelAccess(db, {
      workspaceId: me.workspace.id,
      actingUserId: me.user.id,
      memberId: me.workspace.memberId,
      channelIds: [channel.id],
    })
    const received = await processFacebookInbound(db, {
      ingressId: crypto.randomUUID(),
      pageId,
      externalUserId: recipient,
      externalMessageId: crypto.randomUUID(),
      text: 'Media greeting',
      providerSentAt: new Date(),
      receivedAt: new Date(),
      payloadSha256: 'a'.repeat(64),
      eventFragment: {},
    })
    if (received.kind !== 'created') throw new Error('No conversation')
    const base = `/api/workspaces/${me.workspace.id}`
    await page.reload()
    await page.getByText('Media greeting', { exact: true }).first().click()
    await page.getByRole('button', { name: '接管', exact: true }).click()
    await expect(page.getByLabel('回复客户')).toBeEnabled()
    for (const width of [1440, 1024, 768, 320]) {
      await page.setViewportSize({ width, height: 900 })
      const toolbar = page.getByRole('button', { name: '话术与素材', exact: true }).locator('../..')
      await expect(toolbar).toBeVisible()
      const mediaBox = await toolbar.boundingBox()
      const textBox = await page.locator('.reply-composer').boundingBox()
      if (!mediaBox || !textBox) throw new Error('Reply controls missing')
      expect(Math.abs(mediaBox.x - textBox.x)).toBeLessThan(2)
      expect(Math.abs(mediaBox.width - textBox.width)).toBeLessThan(2)
      expect(textBox.y + textBox.height).toBeLessThanOrEqual(900)
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width,
      )
      if (width === 320)
        await page.screenshot({ path: test.info().outputPath('composer-mobile.png') })
    }
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.screenshot({ path: test.info().outputPath('composer-desktop.png') })
    const fileChooser = page.waitForEvent('filechooser')
    await page.getByRole('button', { name: '上传附件', exact: true }).click()
    await (await fileChooser).setFiles({
      name: 'renamed.png',
      mimeType: 'image/png',
      buffer: Buffer.from('RIFF0000WEBPVP8 '),
    })
    const rejectedUpload = page.waitForResponse(
      (r) => r.url().endsWith('/media-assets') && r.request().method() === 'POST',
    )
    await page.getByRole('button', { name: '上传所选附件', exact: true }).click()
    const rejected = await rejectedUpload
    expect(rejected.status()).toBe(400)
    expect((await rejected.json()).error.code).toBe('MEDIA_INVALID_FILE')
    await expect(page.getByRole('alert')).toContainText('改扩展名不会转换文件格式')
    await expect(page.getByText('renamed.png', { exact: false })).toBeVisible()
    await page.getByRole('button', { name: '取消附件草稿', exact: true }).click()
    await page.getByRole('button', { name: '开始录音', exact: true }).click()
    await expect(page.getByText('录音中，最多 60 秒')).toBeVisible()
    await page.getByRole('button', { name: '取消录音', exact: true }).click()
    await expect(page.getByText('recording.wav', { exact: false })).toHaveCount(0)
    await page.getByRole('button', { name: '开始录音', exact: true }).click()
    await expect(page.getByText('录音中，最多 60 秒')).toBeVisible()
    await page.waitForTimeout(500)
    await page.getByRole('button', { name: '停止录音并预览', exact: true }).click()
    await expect(page.getByLabel('录音或音频预览')).toBeVisible()
    await page.getByRole('button', { name: '取消附件草稿', exact: true }).click()
    await page.evaluate(() => {
      const original = window.AudioContext
      Object.defineProperty(window, 'AudioContext', {
        configurable: true,
        get() {
          Object.defineProperty(window, 'AudioContext', {
            configurable: true,
            writable: true,
            value: original,
          })
          throw new Error('Test audio initialization failure')
        },
      })
    })
    await page.getByRole('button', { name: '开始录音', exact: true }).click()
    await expect(page.getByText('录音中，最多 60 秒')).toBeVisible()
    await page.waitForTimeout(500)
    await page.getByRole('button', { name: '停止录音并预览', exact: true }).click()
    await expect(page.getByRole('alert').filter({ hasText: '录音无法处理' })).toBeVisible()
    await expect(page.getByLabel('上传附件')).toBeEnabled()
    const emojiTemplate = await page.request.post(`${base}/reply-templates`, {
      data: { title: 'Emoji greeting', text: '😊' },
    })
    expect(emojiTemplate.status()).toBe(201)
    await page.getByLabel('回复客户').fill('Replace this draft')
    await page.getByRole('button', { name: '话术与素材', exact: true }).click()
    await page.getByLabel('搜索话术和素材').fill('Emoji greeting')
    await page.getByRole('button', { name: '选用话术', exact: true }).click()
    await expect(page.getByLabel('回复客户')).toHaveValue('😊')
    const emoji = (await emojiTemplate.json()) as { template: { id: string } }
    await page.request.delete(`${base}/reply-templates/${emoji.template.id}`)
    await page.getByRole('button', { name: '话术与素材', exact: true }).click()
    await page.getByLabel('搜索话术和素材').fill('')
    await page.getByLabel('话术名称').fill('Support greeting')
    await page.getByLabel('话术内容').fill('Welcome to support.')
    await page.getByRole('button', { name: '创建话术', exact: true }).click()
    await expect(page.getByText('话术已保存', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: '编辑话术', exact: true }).click()
    await page.getByLabel('话术内容').fill('How can we help?')
    await page.getByRole('button', { name: '保存话术修改', exact: true }).click()
    await page.getByLabel('搜索话术和素材').fill('Support greeting')
    await page.getByRole('button', { name: '搜索内容', exact: true }).click()
    await page.getByRole('button', { name: '选用话术', exact: true }).click()
    const textDraft = page.getByLabel('回复客户')
    await expect(textDraft).toHaveValue('How can we help?')
    await textDraft.fill('Edited before sending.')
    await page.getByRole('button', { name: '插入表情', exact: true }).click()
    await expect(textDraft).toHaveValue('Edited before sending.😊')
    const sends = await page.request.get(
      `${process.env.E2E_FAKE_FACEBOOK_URL}/__sent?recipient=${recipient}`,
    )
    expect(await sends.json()).toEqual({ count: 0 })
    await page.getByRole('button', { name: '话术与素材', exact: true }).click()
    await page.getByLabel('搜索话术和素材').fill('')
    await page.getByRole('button', { name: '搜索内容', exact: true }).click()
    await page.getByRole('button', { name: '删除话术', exact: true }).click()
    await page.getByRole('button', { name: '确认删除内容', exact: true }).click()
    await expect(page.getByText('暂无匹配话术。')).toBeVisible()
    await page.getByRole('button', { name: '关闭内容库', exact: true }).click()
    await expect(textDraft).toHaveValue('Edited before sending.😊')
    let failUpload = true
    await page.route(`**${base}/media-assets`, async (route) => {
      if (route.request().method() === 'POST' && failUpload) {
        failUpload = false
        await route.fulfill({ status: 503, body: '{}' })
      } else await route.continue()
    })
    await page.getByLabel('上传附件').setInputFiles({
      name: 'reject-once.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-browser guide'),
    })
    await page.getByRole('button', { name: '上传所选附件', exact: true }).click()
    await expect(page.getByRole('alert').filter({ hasText: '操作未确认成功' })).toBeVisible()
    await page.getByRole('button', { name: '上传所选附件', exact: true }).click()
    await expect(page.getByText('上传已完成，尚未发送。')).toBeVisible()
    await page.getByRole('button', { name: '加入素材库', exact: true }).click()
    await expect(page.getByText('素材已更新', { exact: true })).toBeVisible()
    const assets = (await (await page.request.get(`${base}/media-assets`)).json()) as {
      assets: { id: string }[]
    }
    const assetId = assets.assets[0].id
    const otherPage = await otherContext.newPage()
    await signInAndCreateWorkspace(otherPage, 'media-other', 'Other media workspace')
    expect((await otherPage.request.get(`${base}/media-assets/${assetId}/file`)).status()).toBe(403)
    await page.getByRole('button', { name: '取消附件草稿', exact: true }).click()
    await page.getByRole('button', { name: '话术与素材', exact: true }).click()
    await page.getByLabel('素材名称').fill('Support guide')
    await page.getByRole('heading', { name: '私有素材', exact: true }).click()
    await expect(page.getByText('素材已更新', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: '选用素材', exact: true }).click()
    await expect(page.getByText('附件草稿：reject-once.pdf')).toBeVisible()
    const committed = page.waitForResponse(
      (r) => r.url().endsWith('/replies') && r.request().method() === 'POST',
    )
    await page.getByRole('button', { name: '发送附件', exact: true }).click()
    const response = await committed
    expect((await response.json()).message.deliveryState).toBe('PENDING')
    await page.request.delete(`${base}/media-assets/${assetId}`)
    await expect(page.locator('.inbox-thread').getByText('发送失败', { exact: true })).toBeVisible({
      timeout: 15_000,
    })
    const earlyRetry = page.waitForResponse((r) => r.url().endsWith('/retry'))
    await page.getByRole('button', { name: '检查并重试发送', exact: true }).click()
    expect((await earlyRetry).status()).toBe(400)
    await expect(
      page.locator('.inbox-thread').getByRole('alert').filter({ hasText: '重试间隔至少' }),
    ).toBeVisible()
    await page.waitForTimeout(31_000)
    await page.getByRole('button', { name: '检查并重试发送', exact: true }).click()
    await expect(page.locator('.inbox-thread').getByText('已发送', { exact: true })).toBeVisible({
      timeout: 15_000,
    })
    await expect(textDraft).toHaveValue('Edited before sending.😊')
    const messages = (await (
      await page.request.get(`${base}/conversations/${received.conversationId}/messages`)
    ).json()) as { messages: { direction: string; attachments: { id: string }[] }[] }
    expect(messages.messages.filter((m) => m.direction === 'OUTBOUND')).toHaveLength(1)
    expect(
      (
        await page.request.get(`${base}/attachments/${messages.messages.at(-1)?.attachments[0].id}`)
      ).status(),
    ).toBe(200)
  } finally {
    await otherContext.close()
    await pool.end()
  }
})
