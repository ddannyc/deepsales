import { expect, test } from '@playwright/test'
import { signInAndCreateWorkspace } from './auth'

test.skip(!process.env.E2E_BASE_URL, 'Set E2E_BASE_URL to a running DeepSales deployment')

test('owner can open Facebook settings', async ({ page }) => {
  await signInAndCreateWorkspace(page, 'facebook', 'Facebook acceptance')
  await expect(page.getByRole('heading', { name: '全部进行中', exact: true })).toBeVisible()

  await page.goto('/settings/facebook')
  await expect(page.getByRole('heading', { name: 'Facebook / Messenger' })).toBeVisible()
  await expect(page.getByRole('button', { name: '连接 Page', exact: true })).toBeVisible()
})
