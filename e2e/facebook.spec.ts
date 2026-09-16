import { expect, test } from '@playwright/test'

test.skip(!process.env.E2E_BASE_URL, 'Set E2E_BASE_URL to a running DeepSales deployment')

test('owner can open Facebook settings', async ({ page }) => {
  const suffix = Date.now()
  const password = 'correct-horse-battery-staple'

  await page.goto('/login')
  await page.getByRole('button', { name: '创建账户视图', exact: true }).click()
  await page.getByLabel('姓名').fill('Ada Lovelace')
  await page.getByLabel('工作邮箱').fill(`facebook-owner-${suffix}@example.com`)
  await page.getByLabel('密码').fill(password)
  await page.getByRole('button', { name: '创建账户', exact: true }).click()
  await page.getByLabel('工作区名称').fill('Facebook acceptance')
  await page.getByRole('button', { name: '创建工作区' }).click()
  await expect(page.getByRole('heading', { name: '全部进行中', exact: true })).toBeVisible()

  await page.goto('/settings/facebook')
  await expect(page.getByRole('heading', { name: 'Facebook Page' })).toBeVisible()
  await expect(page.getByRole('button', { name: '连接 Facebook Page' })).toBeVisible()
})
