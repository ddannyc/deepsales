import { expect, test } from '@playwright/test'
import { Pool } from 'pg'
import { signInAndCreateWorkspace } from './auth'

test.skip(!process.env.E2E_BASE_URL, 'Set E2E_BASE_URL to a running DeepSales deployment')

test('owner maintains question answers and imports without duplicates', async ({ page }) => {
  test.setTimeout(90_000)
  await signInAndCreateWorkspace(page, 'questions', 'Question acceptance')
  await page.goto('/knowledge')
  await page.getByRole('button', { name: '创建知识库', exact: true }).click()
  await page.getByLabel('知识库名称').fill('Support answers')
  await page.getByRole('dialog').getByRole('button', { name: '创建知识库' }).click()
  await page.getByRole('button', { name: '添加问答', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('问题', { exact: true }).fill('How do I clean the lamp?')
  await dialog.getByLabel('答案', { exact: true }).fill('Disconnect power and use a dry cloth.')
  await dialog.getByRole('button', { name: '保存问答' }).click()
  const row = page.locator('.knowledge-document').filter({ hasText: 'How do I clean the lamp?' })
  await expect(row).toHaveAttribute('data-status', 'READY', { timeout: 60_000 })
  await expect(row).toContainText('问答')
  await row.getByRole('button', { name: 'How do I clean the lamp? 的更多操作' }).click()
  await page.getByRole('menuitem', { name: '编辑问答' }).click()
  await expect(dialog.getByLabel('问题', { exact: true })).toHaveValue('How do I clean the lamp?')
  await dialog.getByLabel('答案', { exact: true }).fill('Unplug the lamp before cleaning.')
  await dialog.getByRole('button', { name: '保存问答' }).click()
  await expect(dialog).not.toBeVisible()
  await expect(row).toContainText('Unplug the lamp before cleaning.')
  await expect(row).toHaveAttribute('data-status', 'READY', { timeout: 60_000 })

  const importQuestions = async (answer: string) => {
    await page.getByRole('button', { name: '导入问答', exact: true }).click()
    await dialog.getByLabel('问答文件').setInputFiles({
      name: 'questions.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify([{ question: 'How do I clean the lamp?', answer }])),
    })
    await dialog.getByRole('button', { name: '导入问答', exact: true }).click()
  }
  await importQuestions('Unplug the lamp before cleaning.')
  await expect(dialog).not.toBeVisible()
  await expect(page.locator('.knowledge-document')).toHaveCount(1)
  await importQuestions('A conflicting answer.')
  await expect(dialog.getByRole('alert')).toContainText('冲突')
  await expect(dialog.getByLabel('问答文件')).toHaveValue(/questions.json$/)
  await dialog.getByRole('button', { name: 'Close' }).click()
  await page.reload()
  await expect(page.locator('.knowledge-document')).toHaveCount(1)
  await expect(row).toContainText('Unplug the lamp before cleaning.')
  await page.screenshot({ path: test.info().outputPath('knowledge-questions.png'), fullPage: true })
  const { workspace } = await (await page.request.get('/api/me')).json()
  expect(process.env.DATABASE_URL).toBeTruthy()
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  let testDatabaseConfirmed = false
  try {
    const { rows } = await pool.query('select current_database() as name')
    expect(/(?:_|-)(test|e2e)$/i.test(rows[0].name)).toBe(true)
    testDatabaseConfirmed = true
    await pool.query('update workspace_user_access set role = $1 where workspace_id = $2', [
      'AGENT',
      workspace.id,
    ])
    await page.reload()
    await expect(page.getByRole('button', { name: '添加问答', exact: true })).toHaveCount(0)
    await row.getByRole('button', { name: '查看问答：How do I clean the lamp?' }).click()
    await expect(dialog.getByLabel('答案', { exact: true })).toHaveValue(
      'Unplug the lamp before cleaning.',
    )
    await expect(dialog.getByLabel('答案', { exact: true })).toHaveAttribute('readonly', '')
    await expect(dialog.getByRole('button', { name: '保存问答' })).toHaveCount(0)
    await dialog.getByRole('button', { name: 'Close' }).click()
  } finally {
    try {
      if (testDatabaseConfirmed) {
        await pool.query('update workspace_user_access set role = $1 where workspace_id = $2', [
          'OWNER',
          workspace.id,
        ])
      }
    } finally {
      await pool.end()
    }
  }
  await page.reload()
  await row.getByRole('button', { name: 'How do I clean the lamp? 的更多操作' }).click()
  await page.getByRole('menuitem', { name: '删除文档' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: '删除文档' }).click()
  await expect(page.locator('.knowledge-document')).toHaveCount(0)
})
