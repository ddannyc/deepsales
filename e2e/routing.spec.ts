import { createHmac } from 'node:crypto'
import { expect, test, type Page } from '@playwright/test'
import {
  channel,
  createDatabase,
  createKnowledgeBase,
  facebookChannelConfig,
  setMemberChannelAccess,
} from '@deepsales/db'
import { Pool } from 'pg'

test.skip(!process.env.E2E_BASE_URL, 'Set E2E_BASE_URL to a running DeepSales deployment')

test('routes AI first, falls back to a human, then remains queued', async ({ page }) => {
  const suffix = Date.now()
  const password = 'correct-horse-battery-staple'

  await page.goto('/login')
  await page.getByRole('button', { name: '创建账户视图', exact: true }).click()
  await page.locator('input[name=name]').fill('Ada Lovelace')
  await page.locator('input[name=email]').fill(`routing-${suffix}@example.com`)
  await page.locator('input[name=password]').fill(password)
  await page.locator('form').first().locator('button[type=submit]').click()
  await expect(page.getByRole('heading', { name: '为工作区命名' })).toBeVisible()
  await page.getByLabel('工作区名称').fill('Routing acceptance')
  await page.getByRole('button', { name: '创建工作区' }).click()
  await expect(page.locator('.shell')).toBeVisible()

  const me = (await page.request.get('/api/me').then((response) => response.json())) as {
    user: { id: string }
    workspace: { id: string; memberId: string }
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  const db = createDatabase(pool)
  const pageId = `e2e-routing-page-${suffix}`
  let channelId = ''
  let aiMemberId = ''
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
    await db.insert(facebookChannelConfig).values({
      channelId,
      pageId,
      encryptedPageAccessToken: 'test-cipher',
      tokenIv: 'test-iv',
      tokenKeyVersion: 'v1',
    })
    await setMemberChannelAccess(db, {
      workspaceId: me.workspace.id,
      memberId: me.workspace.memberId,
      actingUserId: me.user.id,
      channelIds: [channelId],
    })
    const knowledgeBase = await createKnowledgeBase(db, {
      workspaceId: me.workspace.id,
      createdByUserId: me.user.id,
      name: 'Routing facts',
    })

    const aiResponse = await page.request.post(`/api/workspaces/${me.workspace.id}/members`, {
      data: { displayName: 'Routing AI', channelIds: [channelId] },
    })
    expect(aiResponse.status()).toBe(201)
    aiMemberId = ((await aiResponse.json()) as { member: { id: string } }).member.id
    const configResponse = await page.request.patch(
      `/api/workspaces/${me.workspace.id}/ai-members/${aiMemberId}/config`,
      {
        data: {
          instructions: 'Answer from facts.',
          responseLanguage: 'English',
          knowledgeBaseId: knowledgeBase.id,
        },
      },
    )
    expect(configResponse.ok()).toBeTruthy()
    const publishResponse = await page.request.post(
      `/api/workspaces/${me.workspace.id}/ai-members/${aiMemberId}/publish`,
    )
    expect(publishResponse.ok()).toBeTruthy()
  } finally {
    await pool.end()
  }

  const aiText = `AI route ${suffix}`
  await sendInbound(page, pageId, `customer-ai-${suffix}`, `mid-ai-${suffix}`, aiText)
  await expect
    .poll(() => findConversation(page, me.workspace.id, aiText), { timeout: 10_000 })
    .toMatchObject({ assigneeMemberId: aiMemberId, assigneeType: 'AI' })

  const disableAi = await page.request.patch(
    `/api/workspaces/${me.workspace.id}/members/${aiMemberId}`,
    { data: { autoAssignmentEnabled: false } },
  )
  expect(disableAi.ok()).toBeTruthy()
  const humanText = `Human fallback ${suffix}`
  await sendInbound(page, pageId, `customer-human-${suffix}`, `mid-human-${suffix}`, humanText)
  await expect
    .poll(() => findConversation(page, me.workspace.id, humanText), { timeout: 10_000 })
    .toMatchObject({ assigneeMemberId: me.workspace.memberId, assigneeType: 'HUMAN' })

  const disableHuman = await page.request.patch(
    `/api/workspaces/${me.workspace.id}/members/${me.workspace.memberId}`,
    { data: { autoAssignmentEnabled: false } },
  )
  expect(disableHuman.ok()).toBeTruthy()
  const queuedText = `Queued route ${suffix}`
  await sendInbound(page, pageId, `customer-queued-${suffix}`, `mid-queued-${suffix}`, queuedText)
  await expect
    .poll(() => findConversation(page, me.workspace.id, queuedText), { timeout: 10_000 })
    .toMatchObject({ assigneeMemberId: null, queueReason: 'NEW_CONVERSATION' })
})

async function findConversation(page: Page, workspaceId: string, text: string) {
  const response = await page.request.get(
    `/api/workspaces/${workspaceId}/conversations?view=all-open`,
  )
  if (!response.ok()) return null
  const body = (await response.json()) as {
    conversations: Array<{
      latestPreview: string | null
      assigneeMemberId: string | null
      assigneeType: 'HUMAN' | 'AI' | null
      queueReason: string | null
    }>
  }
  return body.conversations.find(({ latestPreview }) => latestPreview === text) ?? null
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
  const response = await page.request.post('/webhooks/facebook', {
    headers: {
      'x-hub-signature-256': `sha256=${createHmac('sha256', 'e2e-meta-app-secret').update(body).digest('hex')}`,
    },
    data: body,
  })
  expect(response.status()).toBe(200)
}
