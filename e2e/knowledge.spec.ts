import { expect, test } from '@playwright/test'

test.skip(!process.env.E2E_BASE_URL, 'Set E2E_BASE_URL to a running DeepSales deployment')

test('owner indexes inline knowledge and shows a failed document', async ({ page }) => {
  const suffix = Date.now()
  const password = 'correct-horse-battery-staple'

  await page.goto('/login')
  await page.getByRole('button', { name: '创建账户视图', exact: true }).click()
  await page.getByLabel('姓名').fill('Ada Lovelace')
  await page.getByLabel('工作邮箱').fill(`knowledge-${suffix}@example.com`)
  await page.getByLabel('密码').fill(password)
  await page.getByRole('button', { name: '创建账户', exact: true }).click()
  await page.getByLabel('工作区名称').fill('Knowledge acceptance')
  await page.getByRole('button', { name: '创建工作区', exact: true }).click()

  await page.goto('/knowledge')
  await expect(page.getByRole('heading', { name: '知识库', exact: true })).toBeVisible()
  await page.getByLabel('知识库名称').fill('Support facts')
  await page.getByRole('button', { name: '创建知识库', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Support facts 的文档' })).toBeVisible()

  const documentForm = page.locator('form.knowledge-card')
  await documentForm.getByLabel('文档名称').fill('Shipping')
  await documentForm.getByLabel('文本内容').fill('Shipping is free for every order.')
  await documentForm.getByRole('button', { name: '添加文本', exact: true }).click()
  const shipping = page.locator('.knowledge-document').filter({ hasText: 'Shipping' })
  await expect(shipping).toContainText('文本 · 已上传', { timeout: 5_000 })
  await expect(shipping).toContainText('文本 · 处理中', { timeout: 10_000 })
  await expect(shipping).toContainText('文本 · 已就绪', { timeout: 10_000 })

  await documentForm.getByLabel('文档名称').fill('Empty')
  await documentForm.getByLabel('文本内容').fill('   ')
  await documentForm.getByRole('button', { name: '添加文本', exact: true }).click()
  await expect(page.locator('.knowledge-document').filter({ hasText: 'Empty' })).toContainText(
    '文本 · 失败',
    { timeout: 10_000 },
  )
})
