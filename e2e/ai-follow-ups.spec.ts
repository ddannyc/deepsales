import {
  aiResponseRun,
  autoAssignConversation,
  connectFacebookPages,
  createDatabase,
  customerPropertyDefinition,
  getCustomerProfile,
  message,
  processFacebookInbound,
  setCustomerProperty,
  setMemberChannelAccess,
} from '@deepsales/db'
import { expect, test } from '@playwright/test'
import { eq } from 'drizzle-orm'
import { Pool } from 'pg'
import { encryptFacebookToken } from '../apps/worker/src/facebook'
import { signInAndCreateWorkspace } from './auth'

test.skip(!process.env.E2E_BASE_URL, 'Set E2E_BASE_URL to a running test deployment')

test('edits immediate conditional follow-ups, previews customers and displays a confirmed proactive message', async ({
  page,
}) => {
  test.setTimeout(90_000)
  await signInAndCreateWorkspace(page, 'ai-follow-ups', 'Follow-up acceptance')
  const me = await page.request.get('/api/me').then((response) => response.json())
  const root = `/api/workspaces/${me.workspace.id}`
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  const db = createDatabase(pool)
  try {
    const pageId = crypto.randomUUID()
    const encrypted = await encryptFacebookToken(
      'neutral-page-token',
      'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    )
    const [support] = await connectFacebookPages(db, {
      workspaceId: me.workspace.id,
      actingUserId: me.user.id,
      pages: [
        {
          pageId,
          displayName: 'Follow-up support',
          encryptedPageAccessToken: encrypted.ciphertext,
          tokenIv: encrypted.iv,
          tokenKeyVersion: encrypted.keyVersion,
        },
      ],
    })
    await setMemberChannelAccess(db, {
      workspaceId: me.workspace.id,
      actingUserId: me.user.id,
      memberId: me.workspace.memberId,
      channelIds: [support.id],
    })
    const base = await page.request
      .post(`${root}/knowledge-bases`, { data: { name: 'Support' } })
      .then((response) => response.json())
    const ai = await page.request
      .post(`${root}/members`, { data: { displayName: 'Follow-up AI', channelIds: [support.id] } })
      .then((response) => response.json())
    const configUrl = `${root}/ai-members/${ai.member.id}`
    expect(
      (
        await page.request.patch(`${configUrl}/config`, {
          data: {
            instructions: 'Use knowledge for company facts.',
            responseLanguage: 'English',
            knowledgeBaseId: base.knowledgeBase.id,
            replyWaitEnabled: false,
          },
        })
      ).status(),
    ).toBe(200)
    expect((await page.request.post(`${configUrl}/publish`)).status()).toBe(200)
    const received = await processFacebookInbound(db, {
      ingressId: crypto.randomUUID(),
      pageId,
      externalUserId: crypto.randomUUID(),
      externalMessageId: crypto.randomUUID(),
      text: 'Hello.',
      receivedAt: new Date(),
      providerSentAt: new Date(),
      payloadSha256: 'a'.repeat(64),
      eventFragment: {},
    })
    if (received.kind !== 'created') throw new Error('Missing inbound')
    const assigned = await autoAssignConversation(db, {
      workspaceId: me.workspace.id,
      conversationId: received.conversationId,
    })
    if (!assigned.aiResponseRunId) throw new Error('Missing AI assignment')
    await db
      .update(aiResponseRun)
      .set({ state: 'CANCELLED' })
      .where(eq(aiResponseRun.id, assigned.aiResponseRunId))
    const [definition] = await db
      .insert(customerPropertyDefinition)
      .values({
        workspaceId: me.workspace.id,
        name: 'Needs assistance',
        level: 'CONVERSATION',
        type: 'TEXT',
      })
      .returning()
    const profile = await getCustomerProfile(db, {
      workspaceId: me.workspace.id,
      conversationId: received.conversationId,
      userId: me.user.id,
    })
    await setCustomerProperty(db, {
      workspaceId: me.workspace.id,
      conversationId: received.conversationId,
      userId: me.user.id,
      expectedCustomerId: profile.customer.id,
      expectedRevision: 0,
      definitionId: definition.id,
      value: 'yes',
      allowAutomaticUpdate: false,
    })
    await page.goto(`/ai-member/${ai.member.id}`)
    const region = page.getByRole('region', { name: '主动回访', exact: true })
    await region.getByRole('button', { name: '添加回访规则', exact: true }).click()
    await region.getByLabel('回访规则名称', { exact: true }).fill('Helpful check-in')
    await region.getByRole('switch', { name: '启用回访规则', exact: true }).click()
    await region.getByLabel('回访延迟（秒）', { exact: true }).fill('1')
    await region.getByRole('button', { name: '添加回访条件组', exact: true }).click()
    await region.getByLabel('条件组 1 属性值', { exact: true }).fill('yes')
    await region.getByRole('button', { name: '预览回访客户', exact: true }).click()
    await expect(region.getByRole('status')).toContainText('匹配 1 条')
    await expect(region.getByRole('status')).toContainText(received.conversationId.slice(0, 8))
    await region.getByRole('button', { name: '保存回访规则', exact: true }).click()
    await expect(region.getByRole('status')).toContainText('即时生效')
    const rulesUrl = `${root}/ai-operations/${ai.member.id}/follow-ups`
    const stored = await page.request.get(rulesUrl).then((response) => response.json())
    expect(stored.rules).toMatchObject([
      {
        enabled: true,
        revision: 1,
        groups: [[{ kind: 'PROPERTY', definitionId: definition.id, value: 'yes' }]],
      },
    ])
    await db.insert(message).values({
      conversationId: received.conversationId,
      channelId: support.id,
      direction: 'OUTBOUND',
      senderType: 'MEMBER',
      senderMemberId: ai.member.id,
      messageType: 'TEXT',
      text: 'Earlier answer.',
      deliveryState: 'SENT',
      deliveryCompletedAt: new Date(),
    })
    await expect
      .poll(
        async () => {
          await page.request.get('/cdn-cgi/local/scheduled')
          const state = await page.request.get(rulesUrl).then((response) => response.json())
          return state.events[0]?.deliveryState
        },
        { timeout: 45_000, intervals: [1000] },
      )
      .toBe('SENT')
    await region.getByRole('button', { name: '刷新回访记录', exact: true }).click()
    await expect(region).toContainText('发送接口已确认成功')
    const sentBadge = region.getByText('发送接口已确认成功', { exact: true })
    await expect(sentBadge).toHaveAttribute('data-slot', 'badge')
    await expect(sentBadge).toHaveClass(/bg-success/)
    await expect(sentBadge.locator('[aria-hidden="true"]')).toBeVisible()
    await region.getByRole('button', { name: '编辑 Helpful check-in', exact: true }).click()
    await region.getByRole('switch', { name: '启用回访规则', exact: true }).click()
    await region.getByRole('button', { name: '保存回访规则', exact: true }).click()
    await expect(region).toContainText('Helpful check-in · 停用')
    await region.getByRole('button', { name: '删除 Helpful check-in', exact: true }).click()
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: '保留规则', exact: true })
      .click()
    await expect(region).toContainText('Helpful check-in · 停用')
    await region.getByRole('button', { name: '删除 Helpful check-in', exact: true }).click()
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: '确认删除回访规则', exact: true })
      .click()
    await expect(region).toContainText('尚无回访规则')
    expect(
      (await page.request.get(rulesUrl).then((response) => response.json())).events,
    ).toHaveLength(1)
  } finally {
    await pool.end()
  }
})
