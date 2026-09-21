import { expect, test } from '@playwright/test'
import { signInAndCreateWorkspace } from './auth'

test.skip(!process.env.E2E_BASE_URL, 'Set E2E_BASE_URL to a running DeepSales deployment')

test('owner indexes inline and uploaded knowledge and shows failed documents', async ({ page }) => {
  await signInAndCreateWorkspace(page, 'knowledge', 'Knowledge acceptance')
  await expect(page.getByRole('heading', { name: '全部进行中', exact: true })).toBeVisible()

  await page.goto('/knowledge')
  await expect(page.getByRole('heading', { name: '知识库', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '创建知识库', exact: true }).click()
  const baseDialog = page.getByRole('dialog')
  await baseDialog.getByLabel('知识库名称').fill('Support facts')
  await baseDialog.getByRole('button', { name: '创建知识库', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Support facts 的文档' })).toBeVisible()

  await page.getByRole('button', { name: '添加文本', exact: true }).click()
  const textDialog = page.getByRole('dialog')
  await textDialog.getByLabel('文档名称').fill('Shipping')
  await textDialog.getByLabel('文本内容').fill('Shipping is free for every order.')
  await textDialog.getByRole('button', { name: '添加文本', exact: true }).click()
  const shipping = page.locator('.knowledge-document').filter({ hasText: 'Shipping' })
  await expect(shipping).toHaveAttribute('data-source-type', 'TEXT')
  await expect(shipping).toHaveAttribute('data-status', 'UPLOADED', { timeout: 5_000 })
  await expect(shipping).toHaveAttribute('data-status', 'PROCESSING', { timeout: 10_000 })
  await expect(shipping).toHaveAttribute('data-status', 'READY', { timeout: 10_000 })

  await page.getByRole('button', { name: '上传文档', exact: true }).click()
  const uploadDialog = page.getByRole('dialog')
  await uploadDialog.getByLabel('文件').setInputFiles({
    name: 'Shipping.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('Shipping is free from an uploaded file.'),
  })
  await uploadDialog.getByRole('button', { name: '上传文档', exact: true }).click()
  const uploaded = page
    .locator('.knowledge-document[data-source-type="TXT"]')
    .filter({ hasText: 'Shipping.txt' })
  await expect(uploaded).toHaveAttribute('data-status', 'UPLOADED', { timeout: 5_000 })
  await expect(uploaded).toHaveAttribute('data-status', 'PROCESSING', { timeout: 10_000 })
  await expect(uploaded).toHaveAttribute('data-status', 'READY', { timeout: 10_000 })

  await page.getByRole('button', { name: '上传文档', exact: true }).click()
  const failedUploadDialog = page.getByRole('dialog')
  await failedUploadDialog.getByLabel('文件').setInputFiles({
    name: 'Empty.txt',
    mimeType: 'text/plain',
    buffer: Buffer.alloc(0),
  })
  await failedUploadDialog.getByRole('button', { name: '上传文档', exact: true }).click()
  await expect(
    page.locator('.knowledge-document[data-source-type="TXT"]').filter({ hasText: 'Empty.txt' }),
  ).toHaveAttribute('data-status', 'FAILED', { timeout: 10_000 })

  await page.getByRole('button', { name: '添加文本', exact: true }).click()
  const failedTextDialog = page.getByRole('dialog')
  await failedTextDialog.getByLabel('文档名称').fill('Empty')
  await failedTextDialog.getByLabel('文本内容').fill('   ')
  await failedTextDialog.getByRole('button', { name: '添加文本', exact: true }).click()
  await expect(
    page.locator('.knowledge-document[data-source-type="TEXT"]').filter({ hasText: 'Empty' }),
  ).toHaveAttribute('data-status', 'FAILED', { timeout: 10_000 })
})
