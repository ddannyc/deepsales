import {
  aiFollowUpEvent,
  aiOperation,
  aiResponseRun,
  aiToolAction,
  autoAssignConversation,
  connectFacebookPages,
  createDatabase,
  processFacebookInbound,
  setMemberChannelAccess,
} from '@deepsales/db'
import { expect, test } from '@playwright/test'
import { eq } from 'drizzle-orm'
import { Pool } from 'pg'
import { encryptFacebookToken } from '../apps/worker/src/facebook'
import { signInAndCreateWorkspace } from './auth'

test.skip(!process.env.E2E_BASE_URL, 'Set E2E_BASE_URL to a running test deployment')

test('inserts independent follow-up tools, simulates a saved rule and explains partial completion', async ({
  page,
}) => {
  test.setTimeout(90_000)
  await signInAndCreateWorkspace(page, 'ai-follow-up-tools', 'Follow-up tools acceptance')
  const me = await page.request.get('/api/me').then((r) => r.json())
  const root = `/api/workspaces/${me.workspace.id}`
  const pool = new Pool({ connectionString: process.env.DATABASE_URL }),
    db = createDatabase(pool)
  try {
    const encrypted = await encryptFacebookToken(
      'neutral-page-token',
      'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    )
    const pageId = crypto.randomUUID()
    const [support] = await connectFacebookPages(db, {
      workspaceId: me.workspace.id,
      actingUserId: me.user.id,
      pages: [
        {
          pageId,
          displayName: 'Support',
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
      .post(`${root}/knowledge-bases`, { data: { name: 'Facts' } })
      .then((r) => r.json())
    const ai = await page.request
      .post(`${root}/members`, { data: { displayName: 'Follow-up AI', channelIds: [support.id] } })
      .then((r) => r.json())
    const aiId = ai.member.id
    expect(
      (
        await page.request.patch(`${root}/ai-members/${aiId}/config`, {
          data: {
            instructions: 'Answer safely.',
            responseLanguage: 'English',
            knowledgeBaseId: base.knowledgeBase.id,
          },
        })
      ).status(),
    ).toBe(200)
    expect((await page.request.post(`${root}/ai-members/${aiId}/publish`)).status()).toBe(200)
    await page.goto(`/ai-member/${aiId}`)
    const rules = page.getByRole('region', { name: '主动回访', exact: true })
    await rules.getByRole('button', { name: '添加回访规则', exact: true }).click()
    await rules.getByLabel('回访规则名称', { exact: true }).fill('Follow-up tools')
    await rules
      .getByRole('textbox', { name: '回访要求（可空）', exact: true })
      .fill('Use {{system.timeZone}}. ')
    await expect(rules.getByRole('combobox', { name: '插入工具', exact: true })).toBeVisible()
    await rules.getByRole('combobox', { name: '插入工具', exact: true }).click()
    await page.getByRole('option', { name: '记录内部备注', exact: true }).click()
    await expect(rules.getByRole('textbox', { name: '回访要求（可空）', exact: true })).toHaveValue(
      /\[\[tool:record\]\]/,
    )
    await rules.getByRole('button', { name: '保存回访规则', exact: true }).click()
    await expect(rules.getByRole('status')).toContainText('即时生效')
    const stored = await page.request
      .get(`${root}/ai-operations/${aiId}/follow-ups`)
      .then((r) => r.json())
    const rule = stored.rules[0]
    expect(rule.enabled).toBe(false)
    await page.reload()
    const bench = page.getByRole('region', { name: '多轮测试台', exact: true })
    await bench.getByRole('combobox', { name: '测试配置', exact: true }).click()
    await page.getByRole('option', { name: '当前已保存草稿', exact: true }).click()
    await bench.getByRole('combobox', { name: '回访规则（可选）', exact: true }).click()
    await page.getByRole('option', { name: 'Follow-up tools', exact: true }).click()
    await bench
      .getByRole('textbox', { name: '测试问题', exact: true })
      .fill('Earlier setup context')
    await bench.getByRole('button', { name: '运行测试', exact: true }).click()
    await expect(bench.getByRole('log')).toContainText('Simulated follow-up ready.')
    await expect(bench.getByRole('log')).toContainText('回访规则：Follow-up tools')
    expect(
      await db.select().from(aiFollowUpEvent).where(eq(aiFollowUpEvent.ruleId, rule.id)),
    ).toEqual([])
    await bench.getByRole('button', { name: '查看测试诊断', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'AI 运行诊断', exact: true })
    await expect(dialog).toContainText('仅模拟')
    await expect(dialog).not.toContainText('Private simulated follow-up note.')
    await page.keyboard.press('Escape')

    // Arrange a canonical historical partial outcome; queue/PG tests exercise its actual effects.
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
    const runId = assigned.aiResponseRunId
    if (!runId) throw new Error('Missing run')
    await db
      .update(aiResponseRun)
      .set({ state: 'CANCELLED', failureCode: 'FOLLOW_UP_RULE_CHANGED' })
      .where(eq(aiResponseRun.id, runId))
    await db.insert(aiFollowUpEvent).values({
      id: runId,
      ruleId: rule.id,
      conversationId: received.conversationId,
      ruleRevision: rule.revision,
      anchorId: crypto.randomUUID(),
      anchorAt: new Date(),
      dueAt: new Date(),
    })
    await db.insert(aiOperation).values({
      id: runId,
      workspaceId: me.workspace.id,
      memberId: aiId,
      kind: 'FOLLOW_UP',
      period: new Date().toISOString().slice(0, 7),
      state: 'COMPLETED',
      charged: true,
    })
    await db.insert(aiToolAction).values({
      workspaceId: me.workspace.id,
      memberId: aiId,
      operationId: runId,
      runId,
      ordinal: 0,
      tool: 'record',
      arguments: { text: 'Private historical note.' },
      state: 'SUCCEEDED',
      attemptCount: 1,
      startedAt: new Date(),
      completedAt: new Date(),
    })
    await rules.getByRole('button', { name: '刷新回访记录', exact: true }).click()
    const event = page.getByTestId(`follow-up-event-${runId}`)
    await expect(event).toContainText('已完成部分动作，本轮消息未提交')
    await expect(event).not.toContainText('Private historical note.')
    await event.getByText('工具动作（1）', { exact: true }).click()
    await expect(event).toContainText('记录内部备注')
    await expect(event.getByText('成功', { exact: true })).toHaveAttribute('data-slot', 'badge')
    await event.scrollIntoViewIfNeeded()
    await page.screenshot({ path: 'test-results/ai-follow-up-tools-desktop.png' })
  } finally {
    await pool.end()
  }
})
