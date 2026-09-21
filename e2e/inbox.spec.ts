import { createHmac } from 'node:crypto'
import { channel, createDatabase, facebookChannelConfig } from '@deepsales/db'
import { expect, test } from '@playwright/test'
import { Pool } from 'pg'
import { e2eOwnerEmail, e2ePassword, signInAndCreateWorkspace } from './auth'

test.skip(!process.env.E2E_BASE_URL, 'Set E2E_BASE_URL to a running DeepSales deployment')

test('fake Messenger text appears in the inbox without reloading', async ({ page }) => {
  await page.clock.install()
  const suffix = Date.now()
  const password = e2ePassword

  await signInAndCreateWorkspace(page, 'inbox', 'Inbox acceptance')
  await expect(page).toHaveURL(/\/inbox$/)
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
    const inboundText = `hello from Messenger ${'long conversation history '.repeat(250)}`
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
                text: inboundText,
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

    await expect(page.locator('.message-bubble').first()).toContainText('hello from Messenger', {
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

    const messageList = page.locator('.message-list')
    const firstMessage = page.locator('.message-bubble').first()
    const messageViewport = page.locator('.message-scroll [data-slot="scroll-area-viewport"]')
    await messageList.evaluate((element) => element.setAttribute('data-poll-check', 'stable'))
    await firstMessage.evaluate((element) => element.setAttribute('data-poll-check', 'stable'))
    const maxScroll = await messageViewport.evaluate(
      (element) => element.scrollHeight - element.clientHeight,
    )
    expect(maxScroll).toBeGreaterThan(0)
    await messageViewport.evaluate((element) => {
      element.scrollTop = Math.floor((element.scrollHeight - element.clientHeight) / 2)
    })
    const scrollTop = await messageViewport.evaluate((element) => element.scrollTop)

    let holdNextMessageRequest = false
    let releaseMessageRequest: (() => void) | undefined
    let resolveMessageRequestStarted: (() => void) | undefined
    let heldMessageRequestUrl = ''
    const messageRequestStarted = new Promise<void>((resolve) => {
      resolveMessageRequestStarted = resolve
    })
    const isMessageRequest = (url: string) => new URL(url).pathname.endsWith('/messages')
    await page.route(
      /\/api\/workspaces\/[^/]+\/conversations\/[^/]+\/messages(?:\?.*)?$/,
      async (route) => {
        if (holdNextMessageRequest) {
          holdNextMessageRequest = false
          heldMessageRequestUrl = route.request().url()
          resolveMessageRequestStarted?.()
          await new Promise<void>((resolve) => {
            releaseMessageRequest = resolve
          })
        }
        await route.continue()
      },
    )
    holdNextMessageRequest = true
    await page.clock.fastForward(30_001)
    await messageRequestStarted
    expect(new URL(heldMessageRequestUrl).searchParams.has('cursor')).toBe(true)
    await expect(messageList).toBeVisible()
    await expect(messageList).toHaveAttribute('data-poll-check', 'stable')
    await expect(page.locator('.message-skeleton')).toHaveCount(0)
    expect(await messageViewport.evaluate((element) => element.scrollTop)).toBe(scrollTop)

    const pollResponse = page.waitForResponse(
      (response) => isMessageRequest(response.url()) && response.request().method() === 'GET',
    )
    releaseMessageRequest?.()
    expect((await pollResponse).status()).toBe(200)

    const nextPollResponse = page.waitForResponse(
      (response) => isMessageRequest(response.url()) && response.request().method() === 'GET',
    )
    await page.clock.fastForward(30_001)
    expect((await nextPollResponse).status()).toBe(200)
    await expect(messageList).toHaveAttribute('data-poll-check', 'stable')
    expect(await messageViewport.evaluate((element) => element.scrollTop)).toBe(scrollTop)

    const sendInboundMessage = async (text: string, messageId: string) => {
      const inboundBody = JSON.stringify({
        object: 'page',
        entry: [
          {
            id: pageId,
            messaging: [
              {
                timestamp: Date.now(),
                sender: { id: 'e2e-customer-1' },
                recipient: { id: pageId },
                message: { mid: messageId, text },
              },
            ],
          },
        ],
      })
      const inboundResponse = await page.request.post('/webhooks/facebook', {
        headers: { 'x-hub-signature-256': `sha256=${sign(inboundBody, 'e2e-meta-app-secret')}` },
        data: inboundBody,
      })
      expect(inboundResponse.status()).toBe(200)
    }

    const nextText = 'new Messenger message'
    await sendInboundMessage(nextText, `e2e-mid-next-${suffix}`)
    await expect(page.locator('.message-bubble').nth(1)).toContainText(nextText, {
      timeout: 10_000,
    })
    await expect(messageList).toHaveAttribute('data-poll-check', 'stable')
    await expect(firstMessage).toHaveAttribute('data-poll-check', 'stable')
    expect(await messageViewport.evaluate((element) => element.scrollTop)).toBe(scrollTop)

    await messageViewport.evaluate((element) => {
      element.scrollTop = element.scrollHeight
    })
    expect(
      await messageViewport.evaluate(
        (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
      ),
    ).toBeLessThanOrEqual(1)

    const bottomText = 'message while at bottom'
    await sendInboundMessage(bottomText, `e2e-mid-bottom-${suffix}`)
    await expect(page.locator('.message-bubble').filter({ hasText: bottomText })).toBeVisible({
      timeout: 10_000,
    })
    await expect
      .poll(() =>
        messageViewport.evaluate(
          (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
        ),
      )
      .toBeLessThanOrEqual(1)

    await page.goto('/login')
    await expect(page).toHaveURL(/\/inbox$/)
    await page.reload()
    await expect(page.locator('.shell')).toBeVisible()
    await page.getByRole('button', { name: '退出登录' }).click()
    await expect(page).toHaveURL(/\/login$/)
    await page.goto('/inbox')
    await expect(page).toHaveURL(/\/login$/)
    await page.getByLabel('工作邮箱').fill(e2eOwnerEmail('inbox'))
    await page.getByLabel('密码').fill(password)
    await page.getByRole('button', { name: '登录', exact: true }).click()
    await expect(page).toHaveURL(/\/inbox$/)
    await expect(page.locator('.shell')).toBeVisible()
  } finally {
    await pool.end()
  }
})

function sign(body: string, secret: string) {
  return createHmac('sha256', secret).update(body).digest('hex')
}
