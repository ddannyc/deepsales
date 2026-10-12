import {
  channel,
  claimKnowledgeDocument,
  completeKnowledgeDocument,
  createDatabase,
  createInlineKnowledgeDocument,
  setMemberChannelAccess,
} from '@deepsales/db'
import { expect, test } from '@playwright/test'
import { Pool } from 'pg'
import { signInAndCreateWorkspace } from './auth'

test.skip(!process.env.E2E_BASE_URL, 'Set E2E_BASE_URL to a running DeepSales deployment')
test('guides configuration, preserves draft edits on cancellation and requires explicit save, test and publication', async ({
  page,
}) => {
  test.setTimeout(90_000)
  await signInAndCreateWorkspace(page, 'ai-persona', 'Persona acceptance')
  const me = await page.request.get('/api/me').then((r) => r.json())
  const root = `/api/workspaces/${me.workspace.id}`
  const base = await page.request
    .post(`${root}/knowledge-bases`, { data: { name: 'Support facts' } })
    .then((r) => r.json())
  const ai = await page.request
    .post(`${root}/members`, { data: { displayName: 'Persona AI', channelIds: [] } })
    .then((r) => r.json())
  const configUrl = `${root}/ai-members/${ai.member.id}/config`
  expect(
    (
      await page.request.patch(configUrl, {
        data: {
          instructions: 'Original support persona.',
          responseLanguage: 'English',
          knowledgeBaseId: base.knowledgeBase.id,
        },
      })
    ).status(),
  ).toBe(200)
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  const db = createDatabase(pool)
  try {
    const [support] = await db
      .insert(channel)
      .values({
        workspaceId: me.workspace.id,
        provider: 'FACEBOOK_MESSENGER',
        displayName: 'Support',
      })
      .returning()
    const access = {
      workspaceId: me.workspace.id,
      memberId: ai.member.id,
      actingUserId: me.user.id,
    }
    await setMemberChannelAccess(db, { ...access, channelIds: [support.id] })
    expect(
      (
        await page.request.post(`${root}/ai-members/${ai.member.id}/publish`, { data: {} })
      ).status(),
    ).toBe(200)
    await setMemberChannelAccess(db, { ...access, channelIds: [] })
    await page.goto(`/ai-member/${ai.member.id}`)
    const guide = page.getByRole('region', { name: 'AI 配置引导', exact: true })
    await expect(guide.getByRole('listitem').filter({ hasText: '渠道权限' })).toContainText(
      '需补齐',
    )
    await expect(guide.getByRole('listitem').filter({ hasText: '知识资料' })).toContainText(
      '需补齐',
    )
    const local = 'Original support persona. Keep this local edit.'
    await page.locator('#ai-instructions').fill(local)
    await page.getByRole('switch', { name: '自然语气', exact: true }).click()
    await guide.getByRole('combobox', { name: '人设操作', exact: true }).click()
    await page.getByRole('option', { name: '优化当前指令', exact: true }).click()
    await guide
      .getByRole('textbox', { name: '接待职责与语气', exact: true })
      .fill('Be clear and concise.')
    await guide.getByRole('button', { name: '生成候选', exact: true }).click()
    await expect(guide.getByRole('textbox', { name: '编辑人设候选', exact: true })).toContainText(
      'Be a concise support assistant.',
    )
    await expect(guide.getByRole('textbox', { name: '生成时的原指令', exact: true })).toHaveValue(
      local,
    )
    expect((await page.request.get(configUrl).then((r) => r.json())).config).toMatchObject({
      instructions: 'Original support persona.',
      publishedSnapshot: { instructions: 'Original support persona.' },
    })
    await guide.getByRole('button', { name: '取消候选', exact: true }).click()
    await expect(guide.getByRole('textbox', { name: '编辑人设候选', exact: true })).toHaveCount(0)
    await expect(page.locator('#ai-instructions')).toHaveValue(local)
    await expect(page.locator('.ai-published-panel')).toContainText('Original support persona.')
    let releaseResponse: () => void = () => {}
    let responseReceived: () => void = () => {}
    const received = new Promise<void>((resolve) => {
      responseReceived = resolve
    })
    const release = new Promise<void>((resolve) => {
      releaseResponse = resolve
    })
    const personaUrl = `${root}/ai-operations/${ai.member.id}/persona`
    await page.route(`**${personaUrl}`, async (route) => {
      const response = await route.fetch()
      responseReceived()
      await release
      await route.fulfill({ response })
    })
    await guide.getByRole('button', { name: '生成候选', exact: true }).click()
    await received
    await guide.getByRole('button', { name: '取消候选', exact: true }).click()
    releaseResponse()
    await expect(guide.getByRole('button', { name: '生成候选', exact: true })).toBeEnabled()
    await expect(guide.getByRole('textbox', { name: '编辑人设候选', exact: true })).toHaveCount(0)
    await expect(page.locator('#ai-instructions')).toHaveValue(local)
    await page.unroute(`**${personaUrl}`)
    const doc = await createInlineKnowledgeDocument(db, {
      workspaceId: me.workspace.id,
      knowledgeBaseId: base.knowledgeBase.id,
      createdByUserId: me.user.id,
      name: 'Shipping',
      text: 'Shipping is free.',
    })
    const claim = await claimKnowledgeDocument(db, { documentId: doc.id })
    if (!claim) throw new Error('No document claim')
    await completeKnowledgeDocument(db, {
      documentId: doc.id,
      processingStartedAt: claim.processingStartedAt,
      workspaceId: me.workspace.id,
      knowledgeBaseId: base.knowledgeBase.id,
      contentSha256: 'c'.repeat(64),
      embeddingMetadata: { provider: 'alibaba', model: 'qwen3.7-text-embedding', dimensions: 1536 },
      chunks: [
        {
          text: 'Shipping is free.',
          embedding: Array.from({ length: 1536 }, (_, i) => (i === 0 ? 1 : 0)),
        },
      ],
    })
    await setMemberChannelAccess(db, { ...access, channelIds: [support.id] })
    await guide.getByRole('button', { name: '刷新引导', exact: true }).click()
    await expect(guide.getByRole('listitem').filter({ hasText: '渠道权限' })).toContainText(
      '已就绪',
    )
    await expect(guide.getByRole('listitem').filter({ hasText: '知识资料' })).toContainText(
      '已就绪',
    )
    await expect(page.locator('#ai-instructions')).toHaveValue(local)
    await guide.getByRole('button', { name: '生成候选', exact: true }).click()
    const editor = guide.getByRole('textbox', { name: '编辑人设候选', exact: true })
    await expect(editor).toContainText('Be a concise support assistant.')
    const adopted = 'Edited support persona. Use authorized knowledge and clarify uncertainty.'
    await editor.fill(adopted)
    await guide.getByRole('button', { name: '采用到草稿', exact: true }).click()
    await expect(page.locator('#ai-instructions')).toHaveValue(adopted)
    await expect(page.getByRole('switch', { name: '自然语气', exact: true })).toBeChecked()
    expect((await page.request.get(configUrl).then((r) => r.json())).config.instructions).toBe(
      'Original support persona.',
    )
    await page.getByRole('button', { name: '保存草稿', exact: true }).click()
    await expect(page.getByText('草稿已保存', { exact: true }).first()).toBeVisible()
    expect((await page.request.get(configUrl).then((r) => r.json())).config).toMatchObject({
      instructions: adopted,
      publishedSnapshot: { instructions: 'Original support persona.' },
    })
    await guide.getByRole('link', { name: '前往多轮测试台', exact: true }).click()
    const bench = page.getByRole('region', { name: '多轮测试台', exact: true })
    await bench.getByRole('combobox', { name: '测试配置', exact: true }).click()
    await page.getByRole('option', { name: '当前已保存草稿', exact: true }).click()
    await bench.getByRole('textbox', { name: '测试问题', exact: true }).fill('Hello')
    await bench.getByRole('button', { name: '运行测试', exact: true }).click()
    await expect(bench.getByRole('log')).toContainText('已完成', { timeout: 10_000 })
    expect(
      (await page.request.get(configUrl).then((r) => r.json())).config.publishedSnapshot
        .instructions,
    ).toBe('Original support persona.')
    await page.getByRole('button', { name: '发布', exact: true }).click()
    await expect(page.locator('.ai-published-panel')).toContainText(adopted)
    expect(
      (await page.request.get(`${root}/conversations?view=all-open`).then((r) => r.json()))
        .conversations,
    ).toEqual([])
  } finally {
    await pool.end()
  }
})
