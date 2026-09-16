import { createHmac, randomUUID } from 'node:crypto'
import {
  channel,
  createDatabase,
  facebookChannelConfig,
  humanMemberAvailability,
  member,
  memberChannelAccess,
  setMemberChannelAccess,
  user,
  workspaceUserAccess,
} from '@deepsales/db'
import { expect, type Page, test } from '@playwright/test'
import { Pool } from 'pg'

test.skip(!process.env.E2E_BASE_URL, 'Set E2E_BASE_URL to a running DeepSales deployment')

test('human can transfer, unassign, close, and receive a later message in a new conversation', async ({
  page,
}) => {
  const suffix = Date.now()
  const password = 'correct-horse-battery-staple'
  const ownerEmail = `lifecycle-${suffix}@example.com`

  await page.goto('/login')
  await page.getByRole('button', { name: '创建账户视图', exact: true }).click()
  await page.getByLabel('姓名').fill('Ada Lovelace')
  await page.getByLabel('工作邮箱').fill(ownerEmail)
  await page.getByLabel('密码').fill(password)
  await page.getByRole('button', { name: '创建账户', exact: true }).click()
  await page.getByLabel('工作区名称').fill('Lifecycle acceptance')
  await page.getByRole('button', { name: '创建工作区', exact: true }).click()
  await expect(page.getByRole('heading', { name: '全部进行中', exact: true })).toBeVisible()

  const me = (await page.request.get('/api/me').then((response) => response.json())) as {
    user: { id: string }
    workspace: { id: string; memberId: string }
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  const db = createDatabase(pool)
  const pageId = `e2e-lifecycle-page-${suffix}`
  const externalUserId = `e2e-lifecycle-customer-${suffix}`
  let targetMemberId = ''

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
    await db.insert(facebookChannelConfig).values({
      channelId: createdChannel.id,
      pageId,
      encryptedPageAccessToken: 'test-cipher',
      tokenIv: 'test-iv',
      tokenKeyVersion: 'v1',
    })
    await setMemberChannelAccess(db, {
      workspaceId: me.workspace.id,
      memberId: me.workspace.memberId,
      actingUserId: me.user.id,
      channelIds: [createdChannel.id],
    })

    const targetUserId = randomUUID()
    const targetEmail = `target-${suffix}@example.com`
    await db.insert(user).values({ id: targetUserId, name: 'Grace Hopper', email: targetEmail })
    const [targetAccess] = await db
      .insert(workspaceUserAccess)
      .values({ workspaceId: me.workspace.id, userId: targetUserId, role: 'AGENT' })
      .returning({ id: workspaceUserAccess.id })
    if (!targetAccess) throw new Error('Target access was not created')
    const [target] = await db
      .insert(member)
      .values({
        workspaceId: me.workspace.id,
        type: 'HUMAN',
        workspaceUserAccessId: targetAccess.id,
        displayName: 'Grace Hopper',
      })
      .returning({ id: member.id })
    if (!target) throw new Error('Target member was not created')
    targetMemberId = target.id
    await db.insert(humanMemberAvailability).values({ memberId: target.id, available: true })
    await db
      .insert(memberChannelAccess)
      .values({ memberId: target.id, channelId: createdChannel.id })
  } finally {
    await pool.end()
  }

  await page.request.patch(`/api/workspaces/${me.workspace.id}/members/${me.workspace.memberId}`, {
    data: { autoAssignmentEnabled: false },
  })
  await page.request.patch(`/api/workspaces/${me.workspace.id}/members/${targetMemberId}`, {
    data: { autoAssignmentEnabled: false },
  })

  await page.reload()
  await sendInbound(
    page,
    pageId,
    externalUserId,
    `e2e-lifecycle-mid-${suffix}`,
    'first lifecycle message',
  )
  await expect(page.getByText('first lifecycle message', { exact: true }).first()).toBeVisible({
    timeout: 10_000,
  })
  const initialInbox = (await page.request
    .get(`/api/workspaces/${me.workspace.id}/conversations?view=all-open`)
    .then((response) => response.json())) as { conversations: Array<{ id: string }> }
  const initialConversationId = initialInbox.conversations[0]?.id
  if (!initialConversationId) throw new Error('Initial conversation was not listed')
  await page.getByRole('button', { name: '接管', exact: true }).click()

  await page.getByRole('button', { name: '更多对话操作', exact: true }).click()
  await page.getByRole('menuitem', { name: '转接', exact: true }).click()
  await page.getByLabel('选择转接成员').selectOption(targetMemberId)
  await page.getByRole('button', { name: '确认转接', exact: true }).click()
  const transferWarning = page.getByRole('alertdialog').filter({ hasText: '跳过自动分配限制' })
  if (await transferWarning.isVisible()) {
    await transferWarning.getByRole('button', { name: '继续转接', exact: true }).click()
  }
  await expect(page.getByText('由 Grace Hopper 负责', { exact: true }).first()).toBeVisible()

  await page.getByRole('button', { name: '更多对话操作', exact: true }).click()
  await page.getByRole('menuitem', { name: '取消分配', exact: true }).click()
  const closeResponse = page.waitForResponse(
    (response) => response.url().includes('/close') && response.request().method() === 'POST',
  )
  await page.getByRole('button', { name: '更多对话操作', exact: true }).click()
  await page.getByRole('menuitem', { name: '关闭对话', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: '关闭对话', exact: true }).click()

  await closeResponse
  await sendInbound(
    page,
    pageId,
    externalUserId,
    `e2e-lifecycle-mid-${suffix}-later`,
    'later lifecycle message',
  )
  await expect(page.getByText('later lifecycle message', { exact: true }).first()).toBeVisible({
    timeout: 10_000,
  })
  const laterInbox = (await page.request
    .get(`/api/workspaces/${me.workspace.id}/conversations?view=all-open`)
    .then((response) => response.json())) as { conversations: Array<{ id: string }> }
  expect(laterInbox.conversations[0]?.id).not.toBe(initialConversationId)
})

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
