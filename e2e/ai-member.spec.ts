import { aiConfigVersion, channel, createDatabase, createKnowledgeBase } from '@deepsales/db'
import { expect, test } from '@playwright/test'
import { eq } from 'drizzle-orm'
import { Pool } from 'pg'
import { signInAndCreateWorkspace } from './auth'

test.skip(!process.env.E2E_BASE_URL, 'Set E2E_BASE_URL to a running DeepSales deployment')

test('owner edits and publishes an AI member configuration', async ({ page }) => {
  await signInAndCreateWorkspace(page, 'ai-member', 'AI member acceptance')
  await expect(page.getByRole('heading', { name: '全部进行中', exact: true })).toBeVisible()

  const workspace = (
    (await (await page.request.get('/api/me')).json()) as { workspace: { id: string } }
  ).workspace
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  const db = createDatabase(pool)
  try {
    const [createdChannel] = await db
      .insert(channel)
      .values({ workspaceId: workspace.id, provider: 'FACEBOOK_MESSENGER', displayName: 'Support' })
      .returning({ id: channel.id })
    if (!createdChannel) throw new Error('Channel was not created')
    await createKnowledgeBase(db, {
      workspaceId: workspace.id,
      createdByUserId: (
        (await (await page.request.get('/api/me')).json()) as { user: { id: string } }
      ).user.id,
      name: 'Support facts',
    })

    await page.goto('/team')
    await page.getByRole('button', { name: '添加 AI 成员', exact: true }).click()
    const addAiDialog = page.getByRole('dialog')
    await addAiDialog.getByLabel('显示名称').fill('Answer Bot')
    await addAiDialog.getByRole('button', { name: '添加 AI 成员', exact: true }).click()
    await expect(page.getByRole('row').filter({ hasText: 'Answer Bot' })).toBeVisible()

    const team = (await (
      await page.request.get(`/api/workspaces/${workspace.id}/team`)
    ).json()) as {
      members: Array<{ id: string; displayName: string }>
    }
    const member = team.members.find(({ displayName }) => displayName === 'Answer Bot')
    if (!member) throw new Error('AI member was not created')
    await page.request.patch(`/api/workspaces/${workspace.id}/members/${member.id}`, {
      data: { channelIds: [createdChannel.id] },
    })

    await page.goto(`/ai-member/${member.id}`)
    await expect(page.getByRole('heading', { name: 'Answer Bot', exact: true })).toBeVisible()
    await page.locator('#ai-instructions').fill('Answer from support facts only.')
    await page.locator('#ai-response-language').fill('English')
    await page.getByRole('combobox', { name: '知识库' }).click()
    await page.getByRole('option', { name: 'Support facts' }).click()
    await page.locator('#ai-handoff-keywords').fill('Human, agent')
    await expect(page.getByRole('switch', { name: '等待合并输入', exact: true })).toBeChecked()
    await page.getByRole('switch', { name: '自然语气', exact: true }).click()
    await page.getByRole('switch', { name: '等待合并输入', exact: true }).click()
    await page.getByRole('switch', { name: '启用广告学习' }).click()
    const upload = async (rows: unknown) =>
      page.locator('#ai-ad-upload').setInputFiles({
        name: 'advertising.json',
        mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify(rows)),
      })
    await upload([{ adId: '123456', content: 'Lamp reference.' }])
    await expect(page.locator('#ai-ad-preview')).toContainText('Lamp reference.')
    await expect(page.getByRole('button', { name: '发布', exact: true })).toBeDisabled()
    await page.getByRole('button', { name: '保存草稿' }).click()
    await expect(
      page.locator('.ai-published-panel [data-runtime-status="UNPUBLISHED"]'),
    ).toBeVisible()

    await page.getByRole('button', { name: '发布', exact: true }).click()
    await expect(page.locator('.ai-published-panel [data-runtime-status="USABLE"]')).toBeVisible()
    await expect(page.locator('.ai-published-panel')).toContainText(
      'Answer from support facts only.',
    )
    await expect(page.locator('.ai-published-panel')).toContainText('启用 · 1 条映射')
    await expect(page.locator('.ai-published-panel')).toContainText('自然语气启用')
    await expect(page.locator('.ai-published-panel')).toContainText('等待合并输入停用')
    await page
      .locator('#ai-ad-upload')
      .setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{') })
    await expect(page.getByRole('alert')).toContainText('原表已保留')
    await expect(page.locator('#ai-ad-preview')).toContainText('Lamp reference.')

    const publishedVersions = (await (
      await page.request.get(`/api/workspaces/${workspace.id}/ai-operations/${member.id}/versions`)
    ).json()) as { versions: { id: string }[] }
    const version = publishedVersions.versions[0]
    if (!version) throw new Error('Missing history version')
    await expect(
      db
        .update(aiConfigVersion)
        .set({ publishedAt: new Date() })
        .where(eq(aiConfigVersion.id, version.id)),
    ).rejects.toThrow('Failed query')

    await page.locator('#ai-instructions').fill('Use the updated support policy.')
    await page.getByRole('switch', { name: '自然语气', exact: true }).click()
    await page.getByRole('switch', { name: '等待合并输入', exact: true }).click()
    await upload([{ adId: '789', content: 'Torch reference.' }])
    await expect(page.getByRole('button', { name: '发布', exact: true })).toBeDisabled()
    await page.getByRole('button', { name: '保存草稿' }).click()
    await expect(page.locator('#ai-instructions')).toHaveValue('Use the updated support policy.')
    await expect(page.locator('.ai-published-panel')).toContainText(
      'Answer from support facts only.',
    )
    await expect(page.getByRole('button', { name: '发布', exact: true })).toBeEnabled()
    await page.getByRole('button', { name: '发布', exact: true }).click()
    await expect(page.locator('.ai-published-panel')).toContainText(
      'Use the updated support policy.',
    )
    await page.getByRole('button', { name: '预览版本' }).last().click()
    const history = page.getByRole('dialog')
    await expect(history).toContainText('Answer from support facts only.')
    await history.getByRole('button', { name: '还原到草稿' }).click()
    await expect(page.locator('#ai-instructions')).toHaveValue('Answer from support facts only.')
    await expect(page.getByRole('switch', { name: '自然语气', exact: true })).toBeChecked()
    await expect(page.getByRole('switch', { name: '等待合并输入', exact: true })).not.toBeChecked()
    await expect(page.locator('#ai-ad-preview')).toContainText('Lamp reference.')
    await expect(page.locator('#ai-ad-preview')).not.toContainText('Torch reference.')
    await expect(page.locator('.ai-published-panel')).toContainText(
      'Use the updated support policy.',
    )
    await page.getByRole('button', { name: '发布', exact: true }).click()
    await expect(page.locator('.ai-published-panel')).toContainText(
      'Answer from support facts only.',
    )

    await page.getByLabel('测试问题').fill('Hello')
    await page.getByRole('button', { name: '运行测试', exact: true }).click()
    const diagnostics = page.getByRole('dialog')
    await expect(diagnostics).toContainText('已完成')
    await diagnostics.getByLabel('问题说明').fill('Review response tone.')
    await diagnostics.getByRole('button', { name: '保存反馈' }).click()
    await expect(diagnostics).toContainText('模型问题：Review response tone.')
    await diagnostics.press('Escape')
    await page.getByLabel('本月硬限额').fill('1')
    await page.getByRole('button', { name: '保存限额', exact: true }).click()
    await expect(page.getByText('限额已保存', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: '新测试', exact: true }).click()
    await page.getByLabel('测试问题').fill('Another hello')
    await page.getByRole('button', { name: '运行测试', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText('本月额度已耗尽')
    await page.getByRole('button', { name: '查询统计', exact: true }).click()
    await expect(page.getByRole('row').filter({ hasText: '隔离测试' })).toContainText('1')
    const conversations = await page.request.get(`/api/workspaces/${workspace.id}/conversations`)
    expect((await conversations.json()).conversations).toEqual([])
  } finally {
    await pool.end()
  }
})
