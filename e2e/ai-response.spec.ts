import { createHmac } from 'node:crypto'
import {
  channel,
  createDatabase,
  facebookChannelConfig,
  setMemberChannelAccess,
} from '@deepsales/db'
import { expect, type Page, test } from '@playwright/test'
import { Pool } from 'pg'
import { encryptFacebookToken } from '../apps/worker/src/facebook'
import { signInAndCreateWorkspace } from './auth'

test.skip(!process.env.E2E_BASE_URL, 'Set E2E_BASE_URL to a running DeepSales deployment')
test.setTimeout(60_000)

test('new inbound input receives a grounded AI reply and reaches SENT', async ({ page }) => {
  test.setTimeout(240_000)
  const suffix = Date.now()
  await signInAndCreateWorkspace(page, 'ai-response', 'AI response acceptance')
  await expect(page.locator('.shell')).toBeVisible()

  const me = (await page.request.get('/api/me').then((response) => response.json())) as {
    user: { id: string }
    workspace: { id: string; memberId: string }
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  const db = createDatabase(pool)
  const pageId = `e2e-ai-response-page-${suffix}`
  let channelId = ''
  try {
    const [createdChannel] = await db
      .insert(channel)
      .values({
        workspaceId: me.workspace.id,
        provider: 'FACEBOOK_MESSENGER',
        displayName: 'Support',
      })
      .returning({ id: channel.id })
    if (!createdChannel) throw new Error('Channel was not created')
    channelId = createdChannel.id
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
      workspaceId: me.workspace.id,
      memberId: me.workspace.memberId,
      actingUserId: me.user.id,
      channelIds: [createdChannel.id],
    })
  } finally {
    await pool.end()
  }

  const baseResponse = await page.request.post(
    `/api/workspaces/${me.workspace.id}/knowledge-bases`,
    {
      data: { name: 'Support facts' },
    },
  )
  expect(baseResponse.ok()).toBeTruthy()
  const base = (await baseResponse.json()) as { knowledgeBase: { id: string } }
  const documentResponse = await page.request.post(
    `/api/workspaces/${me.workspace.id}/knowledge-bases/${base.knowledgeBase.id}/documents/text`,
    { data: { name: 'Shipping', text: 'Shipping is free.' } },
  )
  expect(documentResponse.ok()).toBeTruthy()

  await expect
    .poll(
      async () => {
        const response = await page.request.get(
          `/api/workspaces/${me.workspace.id}/knowledge-bases/${base.knowledgeBase.id}/documents`,
        )
        const data = (await response.json()) as { documents: Array<{ status: string }> }
        return data.documents[0]?.status
      },
      { timeout: 20_000 },
    )
    .toBe('READY')

  const aiResponse = await page.request.post(`/api/workspaces/${me.workspace.id}/members`, {
    data: { displayName: 'Support AI', channelIds: [channelId] },
  })
  expect(aiResponse.ok()).toBeTruthy()
  const ai = (await aiResponse.json()) as { member: { id: string } }
  const configResponse = await page.request.patch(
    `/api/workspaces/${me.workspace.id}/ai-members/${ai.member.id}/config`,
    {
      data: {
        instructions: 'Answer from support facts.',
        responseLanguage: 'English',
        knowledgeBaseId: base.knowledgeBase.id,
      },
    },
  )
  expect(configResponse.ok()).toBeTruthy()
  const publishResponse = await page.request.post(
    `/api/workspaces/${me.workspace.id}/ai-members/${ai.member.id}/publish`,
  )
  expect(publishResponse.ok()).toBeTruthy()
  const optionsDocument = await page.request.post(
    `/api/workspaces/${me.workspace.id}/knowledge-bases/${base.knowledgeBase.id}/documents/text`,
    { data: { name: 'Torch options', text: 'Torch One comes in red. Torch Two comes in blue.' } },
  )
  expect(optionsDocument.ok()).toBeTruthy()
  await expect
    .poll(
      async () => {
        const result = await page.request.get(
          `/api/workspaces/${me.workspace.id}/knowledge-bases/${base.knowledgeBase.id}/documents`,
        )
        const data = (await result.json()) as { documents: Array<{ status: string }> }
        return data.documents.every(({ status }) => status === 'READY')
      },
      { timeout: 20_000 },
    )
    .toBe(true)

  await page.goto('/inbox')
  const inboundText = `What is shipping? ${suffix}`
  await sendInbound(page, pageId, `customer-${suffix}`, `mid-${suffix}`, inboundText)
  await expect(page.getByText('AI 正在生成', { exact: true }).first()).toBeVisible({
    timeout: 20_000,
  })
  await expect(page.getByText('Shipping is free.', { exact: true }).first()).toBeVisible({
    timeout: 20_000,
  })
  await expect(page.getByText('已发送', { exact: true }).first()).toBeVisible({ timeout: 20_000 })

  const conversationsResponse = await page.request.get(
    `/api/workspaces/${me.workspace.id}/conversations?view=all-open`,
  )
  const conversations = (await conversationsResponse.json()) as {
    conversations: Array<{ id: string; latestPreview: string | null }>
  }
  const conversation = conversations.conversations.find(
    ({ latestPreview }) => latestPreview === inboundText,
  )
  if (!conversation) throw new Error('AI conversation was not found')
  await page.locator('.conversation-items button').first().click()
  const upload = await page.request.post(`/api/workspaces/${me.workspace.id}/media-assets`, {
    headers: {
      'Content-Type': 'image/png',
      'X-Filename': 'setup-guide.png',
      'X-Upload-Id': crypto.randomUUID(),
      'X-Library': 'true',
    },
    data: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZuoAAAAASUVORK5CYII=',
      'base64',
    ),
  })
  expect(upload.ok()).toBeTruthy()
  const asset = (await upload.json()) as { asset: { id: string; title: string } }
  await page.goto('/knowledge')
  await page.getByRole('button', { name: '引用素材', exact: true }).click()
  const assetDialog = page.getByRole('dialog', { name: '添加文本' })
  await assetDialog.getByLabel('文档名称').fill('Setup illustration')
  await assetDialog
    .getByLabel('文本内容')
    .fill('Setup guide illustration with connection instructions.')
  await expect(assetDialog.getByRole('combobox', { name: '引用私有素材（可选）' })).toBeEnabled()
  await assetDialog.getByRole('combobox', { name: '引用私有素材（可选）' }).click()
  await page.getByRole('option', { name: asset.asset.title, exact: true }).click()
  await assetDialog.getByRole('button', { name: '添加文本', exact: true }).click()
  const assetRow = page.getByRole('row').filter({ hasText: 'Setup illustration' })
  await expect(assetRow.getByText('素材描述', { exact: true })).toBeVisible()
  await expect(assetRow.getByText('已就绪', { exact: true })).toBeVisible({ timeout: 20_000 })
  await page.goto('/inbox')
  await page.locator('.conversation-items button').first().click()
  await sendInbound(page, pageId, `customer-${suffix}`, `mid-asset-${suffix}`, 'Send setup guide')
  const assetMessage = page
    .locator('.message-bubble')
    .filter({ has: page.getByAltText('setup-guide.png') })
  await expect(assetMessage.getByText('已发送', { exact: true })).toBeVisible({ timeout: 30_000 })
  const removal = await page.request.delete(
    `/api/workspaces/${me.workspace.id}/media-assets/${asset.asset.id}`,
  )
  expect(removal.ok()).toBeTruthy()
  await page.goto('/knowledge')
  await expect(assetRow.getByText('已就绪', { exact: true })).toBeVisible()
  await expect(assetRow.getByText('引用素材已失效', { exact: true })).toBeVisible()
  await page.goto('/inbox')
  await page.locator('.conversation-items button').first().click()
  await expect(assetMessage.getByAltText('setup-guide.png')).toBeVisible()
  const waitSent = async (text: string, count = 1) => {
    await expect
      .poll(
        async () => {
          const result = await page.request.get(
            `/api/workspaces/${me.workspace.id}/conversations/${conversation.id}/messages`,
          )
          const data = (await result.json()) as {
            messages: Array<{ text: string | null; deliveryState: string | null }>
          }
          return data.messages.filter((item) => item.text === text && item.deliveryState === 'SENT')
            .length
        },
        { timeout: 30_000 },
      )
      .toBe(count)
  }
  await sendInbound(
    page,
    pageId,
    `customer-${suffix}`,
    `mid-options-${suffix}`,
    'Compare Torch options',
  )
  await waitSent('Option one is Torch One. Option two is Torch Two.')
  await sendInbound(
    page,
    pageId,
    `customer-${suffix}`,
    `mid-second-${suffix}`,
    'Does the second option come in blue?',
  )
  await waitSent('Torch Two comes in blue.')
  await expect(
    page.locator('.message-bubble').filter({ hasText: 'Torch Two comes in blue.' }).first(),
  ).toBeVisible()

  await page.goto(`/ai-member/${ai.member.id}`)
  const split = page.getByRole('switch', { name: '拆分长回复' })
  await expect(split).not.toBeChecked()
  await split.click()
  await page.getByRole('button', { name: '保存草稿' }).click()
  await expect(page.getByRole('button', { name: '发布', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: '发布', exact: true }).click()
  await expect(
    page.locator('.ai-published-panel').getByText('拆分长回复', { exact: true }),
  ).toBeVisible()
  await page.goto('/inbox')
  await page.locator('.conversation-items button').first().click()
  await sendInbound(
    page,
    pageId,
    `customer-${suffix}`,
    `mid-split-${suffix}`,
    'Explain split delivery',
  )
  const firstPart = page.locator('.message-bubble').filter({ hasText: '回复分段 1/3' })
  const secondPart = page.locator('.message-bubble').filter({ hasText: '回复分段 2/3' })
  const thirdPart = page.locator('.message-bubble').filter({ hasText: '回复分段 3/3' })
  await expect(firstPart.getByText('发送中', { exact: true })).toBeVisible({ timeout: 20_000 })
  await expect(firstPart.getByText('已发送', { exact: true })).toBeVisible({ timeout: 20_000 })
  await expect(secondPart.getByText('发送失败', { exact: true })).toBeVisible({ timeout: 20_000 })
  await expect(thirdPart.getByText('前段发送失败，后续分段已暂停')).toBeVisible({ timeout: 20_000 })
  await expect(thirdPart.getByText('Split tail.', { exact: true })).toBeVisible()

  const followUp = `Could you explain that again ${suffix}`
  await sendInbound(page, pageId, `customer-${suffix}`, `mid-follow-up-${suffix}`, followUp)
  await expect(page.getByText('AI 正在生成', { exact: true }).first()).toBeVisible({
    timeout: 20_000,
  })
  const statePool = new Pool({ connectionString: process.env.DATABASE_URL })
  try {
    await expect
      .poll(() => latestAiRunState(statePool, conversation.id), { timeout: 20_000 })
      .toBe('GENERATING')
    const takeover = await page.request.post(
      `/api/workspaces/${me.workspace.id}/conversations/${conversation.id}/takeover`,
    )
    expect(takeover.ok()).toBeTruthy()
    await expect
      .poll(() => latestAiRunState(statePool, conversation.id), { timeout: 20_000 })
      .toBe('CANCELLED')

    const messagesResponse = await page.request.get(
      `/api/workspaces/${me.workspace.id}/conversations/${conversation.id}/messages`,
    )
    const messages = (await messagesResponse.json()) as {
      messages: Array<{ text: string | null }>
    }
    expect(messages.messages.filter(({ text }) => text === 'Shipping is free.')).toHaveLength(1)
    const reply = await page.request.post(
      `/api/workspaces/${me.workspace.id}/conversations/${conversation.id}/replies`,
      {
        data: { text: 'Do you prefer the compact Torch Two?' },
      },
    )
    expect(reply.ok()).toBeTruthy()
    await waitSent('Do you prefer the compact Torch Two?')
    await sendInbound(
      page,
      pageId,
      `customer-${suffix}`,
      `mid-human-follow-up-${suffix}`,
      'Yes, the compact one.',
    )
    const transfer = await page.request.post(
      `/api/workspaces/${me.workspace.id}/conversations/${conversation.id}/transfer`,
      {
        data: { targetMemberId: ai.member.id },
      },
    )
    expect(transfer.ok()).toBeTruthy()
    await waitSent('Torch Two comes in blue.', 2)
  } finally {
    await statePool.end()
  }
})

async function latestAiRunState(pool: Pool, conversationId: string) {
  const result = await pool.query<{ state: string }>(
    `select state
       from ai_response_run
      where conversation_id = $1
      order by created_at desc, id desc
      limit 1`,
    [conversationId],
  )
  return result.rows[0]?.state ?? null
}

async function sendInbound(
  page: Page,
  pageId: string,
  externalUserId: string,
  externalMessageId: string,
  text: string,
) {
  const body = JSON.stringify({
    object: 'page',
    entry: [
      {
        id: pageId,
        messaging: [
          {
            timestamp: Date.now(),
            sender: { id: externalUserId },
            recipient: { id: pageId },
            message: { mid: externalMessageId, text },
          },
        ],
      },
    ],
  })
  const secret = 'e2e-meta-app-secret'
  const signature = createHmac('sha256', secret).update(body).digest('hex')
  const response = await page.request.post('/webhooks/facebook', {
    headers: { 'x-hub-signature-256': `sha256=${signature}` },
    data: body,
  })
  expect(response.status()).toBe(200)
}
