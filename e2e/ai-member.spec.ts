import { expect, test } from '@playwright/test'
import { channel, createDatabase, createKnowledgeBase } from '@deepsales/db'
import { Pool } from 'pg'

test.skip(!process.env.E2E_BASE_URL, 'Set E2E_BASE_URL to a running DeepSales deployment')

test('owner edits and publishes an AI member configuration', async ({ page }) => {
  const suffix = Date.now()
  const password = 'correct-horse-battery-staple'

  await page.goto('/login')
  await page.getByRole('button', { name: '创建账户视图', exact: true }).click()
  await page.getByLabel('姓名').fill('Ada Lovelace')
  await page.getByLabel('工作邮箱').fill(`ai-member-${suffix}@example.com`)
  await page.getByLabel('密码').fill(password)
  await page.getByRole('button', { name: '创建账户', exact: true }).click()
  await page.getByLabel('工作区名称').fill('AI member acceptance')
  await page.getByRole('button', { name: '创建工作区', exact: true }).click()
  await expect(page.getByRole('heading', { name: '收件箱已准备就绪' })).toBeVisible()

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
    const knowledgeBase = await createKnowledgeBase(db, {
      workspaceId: workspace.id,
      createdByUserId: (
        (await (await page.request.get('/api/me')).json()) as { user: { id: string } }
      ).user.id,
      name: 'Support facts',
    })

    await page.goto('/team')
    const aiForm = page.locator('form.team-card').filter({ hasText: '添加 AI 成员' })
    await aiForm.getByLabel('显示名称').fill('Answer Bot')
    await aiForm.getByRole('button', { name: '添加 AI 成员' }).click()
    const aiCard = page.locator('form.member-card').filter({ hasText: 'Answer Bot' })
    await expect(aiCard).toBeVisible()

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
    await expect(page.getByRole('heading', { name: 'AI 成员配置' })).toBeVisible()
    await page.locator('#ai-instructions').fill('Answer from support facts only.')
    await page.locator('#ai-response-language').fill('English')
    await page.locator('#ai-knowledge-base').selectOption(knowledgeBase.id)
    await page.locator('#ai-handoff-keywords').fill('Human, agent')
    await page.getByRole('button', { name: '保存草稿' }).click()
    await expect(page.locator('[data-runtime-status="UNPUBLISHED"]')).toBeVisible()

    await page.getByRole('button', { name: '发布', exact: true }).click()
    await expect(page.locator('[data-runtime-status="USABLE"]')).toBeVisible()
    await expect(page.locator('.ai-published-panel')).toContainText(
      'Answer from support facts only.',
    )

    await page.locator('#ai-instructions').fill('Use the updated support policy.')
    await page.getByRole('button', { name: '保存草稿' }).click()
    await expect(page.locator('#ai-instructions')).toHaveValue('Use the updated support policy.')
    await expect(page.locator('.ai-published-panel')).toContainText(
      'Answer from support facts only.',
    )
    await page.getByRole('button', { name: '发布', exact: true }).click()
    await expect(page.locator('.ai-published-panel')).toContainText(
      'Use the updated support policy.',
    )
  } finally {
    await pool.end()
  }
})
