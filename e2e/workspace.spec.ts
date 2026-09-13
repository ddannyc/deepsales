import { expect, test } from '@playwright/test'

test.skip(!process.env.E2E_BASE_URL, 'Set E2E_BASE_URL to a running DeepSales deployment')

test('user can sign up, create a workspace, sign out, and sign back in', async ({ page }) => {
  const email = `owner-${Date.now()}@example.com`
  const password = 'correct-horse-battery-staple'

  expect((await page.request.get('/ready')).status()).toBe(200)
  await page.goto('/login')
  await page.getByRole('button', { name: 'Create account' }).click()
  await page.getByLabel('Full name').fill('Ada Lovelace')
  await page.getByLabel('Work email').fill(email)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Create account', exact: true }).click()

  await expect(page.getByRole('heading', { name: 'Name your workspace' })).toBeVisible()
  await page.getByLabel('Workspace name').fill('Analytical Engines')
  await page.getByRole('button', { name: 'Create workspace' }).click()

  await expect(page.getByRole('heading', { name: 'Inbox, ready when you are.' })).toBeVisible()
  await expect(page.getByText('Analytical Engines')).toBeVisible()
  expect(
    (await page.request.get('/api/workspaces/00000000-0000-4000-8000-000000000000')).status(),
  ).toBe(403)
  await page.getByRole('button', { name: 'Sign out' }).click()

  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
  expect((await page.request.get('/api/me')).status()).toBe(401)
  await page.getByLabel('Work email').fill(email)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Inbox, ready when you are.' })).toBeVisible()
})
