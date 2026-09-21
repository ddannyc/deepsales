import { expect, test } from '@playwright/test'
import { e2eOwnerEmail, e2ePassword, signInAndCreateWorkspace } from './auth'

test.skip(!process.env.E2E_BASE_URL, 'Set E2E_BASE_URL to a running DeepSales deployment')

test('user can create a workspace, sign out, and sign back in', async ({ page }) => {
  const email = e2eOwnerEmail('workspace')
  const password = e2ePassword

  expect((await page.request.get('/ready')).status()).toBe(200)
  await signInAndCreateWorkspace(page, 'workspace', 'Analytical Engines')

  await expect(page.getByRole('heading', { name: '全部进行中', exact: true })).toBeVisible()
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
  await expect(page.getByRole('heading', { name: '全部进行中', exact: true })).toBeVisible()
})
