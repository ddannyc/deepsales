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

test.skip(!process.env.E2E_BASE_URL, 'Set E2E_BASE_URL to a running DeepSales deployment')
test.setTimeout(60_000)

test('new inbound input receives a grounded AI reply and reaches SENT', async ({ page }) => {
  const suffix = Date.now()
  const password = 'correct-horse-battery-staple'

  await page.goto('/login')
  await page.locator('.mode-switch button').nth(1).click()
  await page.locator('input[name=name]').fill('Ada Lovelace')
  await page.locator('input[name=email]').fill(`ai-response-${suffix}@example.com`)
  await page.locator('input[name=password]').fill(password)
  await page.locator('form').first().locator('button[type=submit]').click()
  await expect(page.locator('.setup-layout')).toBeVisible()
  await page.locator('.setup-layout input[name=name]').fill('AI response acceptance')
  await page.locator('.setup-layout button[type=submit]').click()
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

  const followUp = `Please connect me to a person ${suffix}`
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
