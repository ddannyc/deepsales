import { createDatabase, customerTagDefinition } from '@deepsales/db'
import { expect, test } from '@playwright/test'
import { Pool } from 'pg'
import { signInAndCreateWorkspace } from './auth'

test.skip(!process.env.E2E_BASE_URL, 'Set E2E_BASE_URL to a running DeepSales deployment')

test('edits independent handoff rules and simulates a tag without creating a customer conversation', async ({
  page,
}) => {
  await signInAndCreateWorkspace(page, 'ai-handoff', 'Handoff acceptance')
  const me = await page.request.get('/api/me').then((r) => r.json())
  const root = `/api/workspaces/${me.workspace.id}`
  const base = await page.request
    .post(`${root}/knowledge-bases`, { data: { name: 'Facts' } })
    .then((r) => r.json())
  const ai = await page.request
    .post(`${root}/members`, { data: { displayName: 'Handoff AI', channelIds: [] } })
    .then((r) => r.json())
  expect(
    (
      await page.request.patch(`${root}/ai-members/${ai.member.id}/config`, {
        data: {
          instructions: 'Answer safely.',
          responseLanguage: 'English',
          knowledgeBaseId: base.knowledgeBase.id,
        },
      })
    ).ok(),
  ).toBeTruthy()
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  try {
    await createDatabase(pool)
      .insert(customerTagDefinition)
      .values({ workspaceId: me.workspace.id, name: 'Specialist', level: 'CUSTOMER' })
  } finally {
    await pool.end()
  }
  await page.goto(`/ai-member/${ai.member.id}`)
  await page.getByLabel('转人工条件名称', { exact: true }).fill('Specialist routing')
  await page.getByRole('combobox', { name: '自定义转人工条件类型' }).click()
  await page.getByRole('option', { name: '标签：Specialist', exact: true }).click()
  await page.getByRole('button', { name: '保存转人工条件', exact: true }).click()
  await expect(page.getByText('条件已保存，立即生效', { exact: true })).toBeVisible()
  await page.getByLabel('转人工条件名称', { exact: true }).fill('Unfinished draft')
  await page.getByRole('button', { name: '停用 Specialist routing', exact: true }).click()
  await expect(page.getByLabel('转人工条件名称', { exact: true })).toHaveValue('Unfinished draft')
  await page.getByRole('button', { name: '启用 Specialist routing', exact: true }).click()
  await expect(
    page.getByRole('button', { name: '停用 Specialist routing', exact: true }),
  ).toBeVisible()
  await expect(page.getByLabel('转人工条件名称', { exact: true })).toHaveValue('Unfinished draft')
  await page.getByRole('button', { name: '刷新记录', exact: true }).click()
  await page.getByRole('combobox', { name: '测试配置', exact: true }).click()
  await page.getByRole('option', { name: '当前已保存草稿', exact: true }).click()
  await page.getByLabel('测试问题', { exact: true }).fill('Hello')
  await page.getByRole('combobox', { name: '模拟属性标签条件', exact: true }).click()
  await page.getByRole('option', { name: 'Specialist routing', exact: true }).click()
  await page.getByRole('button', { name: '运行测试', exact: true }).click()
  await page.getByRole('button', { name: '查看测试诊断', exact: true }).click()
  await expect(page.getByText('模拟转人工；不会分配或发送。', { exact: true })).toBeVisible()
  const inbox = await page.request.get(`${root}/conversations?view=all-open`).then((r) => r.json())
  expect(inbox.conversations).toEqual([])
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click()
  await page.getByRole('button', { name: '删除 Specialist routing', exact: true }).click()
  await page
    .getByRole('alertdialog')
    .getByRole('button', { name: '确认删除条件', exact: true })
    .click()
  await expect(
    page.getByRole('button', { name: '编辑 Specialist routing', exact: true }),
  ).toHaveCount(0)
  await expect(page.getByLabel('转人工条件名称', { exact: true })).toHaveValue('Unfinished draft')
})
