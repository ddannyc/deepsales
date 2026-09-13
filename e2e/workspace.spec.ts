import { expect, test } from '@playwright/test'

test.skip(!process.env.E2E_BASE_URL, 'Set E2E_BASE_URL to a running DeepSales deployment')

test('user can sign up, create a workspace, sign out, and sign back in', async ({ page }) => {
  const email = `owner-${Date.now()}@example.com`
  const password = 'correct-horse-battery-staple'

  expect((await page.request.get('/ready')).status()).toBe(200)
  await page.goto('/login')
  await page.getByRole('button', { name: '创建账户视图', exact: true }).click()
  await page.getByLabel('姓名').fill('Ada Lovelace')
  await page.getByLabel('工作邮箱').fill(email)
  await page.getByLabel('密码').fill(password)
  await page.getByRole('button', { name: '创建账户', exact: true }).click()

  await expect(page.getByRole('heading', { name: '为工作区命名' })).toBeVisible()
  await page.getByLabel('工作区名称').fill('Analytical Engines')
  await page.getByRole('button', { name: '创建工作区' }).click()

  await expect(page.getByRole('heading', { name: '收件箱已准备就绪' })).toBeVisible()
  await expect(page.getByText('Analytical Engines')).toBeVisible()
  expect(
    (await page.request.get('/api/workspaces/00000000-0000-4000-8000-000000000000')).status(),
  ).toBe(403)
  await page.getByRole('button', { name: '退出登录' }).click()

  await expect(page.getByRole('heading', { name: '登录' })).toBeVisible()
  expect((await page.request.get('/api/me')).status()).toBe(401)
  await page.getByLabel('工作邮箱').fill(email)
  await page.getByLabel('密码').fill(password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page.getByRole('heading', { name: '收件箱已准备就绪' })).toBeVisible()
})
