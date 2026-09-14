import { expect, test } from '@playwright/test'

test.skip(!process.env.E2E_BASE_URL, 'Set E2E_BASE_URL to a running DeepSales deployment')

test('owner indexes inline and uploaded knowledge and shows failed documents', async ({ page }) => {
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
  await expect(page.getByRole('heading', { name: '收件箱已准备就绪' })).toBeVisible()

  await page.goto('/knowledge')
  await expect(page.getByRole('heading', { name: '知识库', exact: true })).toBeVisible()
  await page.getByLabel('知识库名称').fill('Support facts')
  await page.getByRole('button', { name: '创建知识库', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Support facts 的文档' })).toBeVisible()

  const documentForm = page.locator('form.knowledge-card:not(.knowledge-upload)')
  await documentForm.getByLabel('文档名称').fill('Shipping')
  await documentForm.getByLabel('文本内容').fill('Shipping is free for every order.')
  await documentForm.getByRole('button', { name: '添加文本', exact: true }).click()
  const shipping = page.locator('.knowledge-document').filter({ hasText: 'Shipping' })
  await expect(shipping).toContainText('文本 · 已上传', { timeout: 5_000 })
  await expect(shipping).toContainText('文本 · 处理中', { timeout: 10_000 })
  await expect(shipping).toContainText('文本 · 已就绪', { timeout: 10_000 })

  const uploadForm = page.locator('form.knowledge-upload')
  await uploadForm.locator('input[type="file"]').setInputFiles({
    name: 'Shipping.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('Shipping is free from an uploaded file.'),
  })
  await uploadForm.getByRole('button', { name: '上传文件', exact: true }).click()
  const uploaded = page
    .locator('.knowledge-document[data-source-type="TXT"]')
    .filter({ hasText: 'Shipping.txt' })
  await expect(uploaded).toHaveAttribute('data-status', 'UPLOADED', { timeout: 5_000 })
  await expect(uploaded).toHaveAttribute('data-status', 'PROCESSING', { timeout: 10_000 })
  await expect(uploaded).toHaveAttribute('data-status', 'READY', { timeout: 10_000 })

  await uploadForm.locator('input[type="file"]').setInputFiles({
    name: 'Empty.txt',
    mimeType: 'text/plain',
    buffer: Buffer.alloc(0),
  })
  await uploadForm.getByRole('button', { name: '上传文件', exact: true }).click()
  await expect(
    page.locator('.knowledge-document[data-source-type="TXT"]').filter({ hasText: 'Empty.txt' }),
  ).toHaveAttribute('data-status', 'FAILED', { timeout: 10_000 })

  await documentForm.getByLabel('文档名称').fill('Empty')
  await documentForm.getByLabel('文本内容').fill('   ')
  await documentForm.getByRole('button', { name: '添加文本', exact: true }).click()
  await expect(
    page.locator('.knowledge-document[data-source-type="TEXT"]').filter({ hasText: 'Empty' }),
  ).toContainText('文本 · 失败', { timeout: 10_000 })
})
