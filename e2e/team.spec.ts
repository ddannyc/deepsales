import { expect, test } from '@playwright/test'

test.skip(!process.env.E2E_BASE_URL, 'Set E2E_BASE_URL to a running DeepSales deployment')

test('owner creates an AI member, edits it, and invites a teammate', async ({ browser, page }) => {
  const suffix = Date.now()
  const ownerEmail = `owner-${suffix}@example.com`
  const invitedEmail = `agent-${suffix}@example.com`
  const password = 'correct-horse-battery-staple'

  await page.goto('/login')
  await page.getByRole('button', { name: 'Create account' }).click()
  await page.getByLabel('Full name').fill('Ada Lovelace')
  await page.getByLabel('Work email').fill(ownerEmail)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Create account', exact: true }).click()
  await page.getByLabel('Workspace name').fill('Team acceptance')
  await page.getByRole('button', { name: 'Create workspace' }).click()

  await page.goto('/team')
  await expect(page.getByRole('heading', { name: 'Team' })).toBeVisible()

  const aiForm = page.locator('form.team-card').filter({ hasText: 'Add an AI member' })
  await aiForm.getByLabel('Display name').fill('Answer Bot')
  await aiForm.getByRole('button', { name: 'Add AI member' }).click()
  const aiCard = page.locator('form.member-card').filter({ hasText: 'Answer Bot' })
  await expect(aiCard).toBeVisible()
  await aiCard.getByLabel('Capacity').fill('4')
  await aiCard.getByRole('button', { name: 'Save changes' }).click()

  const inviteForm = page.locator('form.team-card').filter({ hasText: 'Invite a teammate' })
  await inviteForm.getByLabel('Work email').fill(invitedEmail)
  await inviteForm.getByLabel('Display name').fill('Grace Hopper')
  await inviteForm.getByRole('button', { name: 'Create invite link' }).click()
  const inviteUrl = await page.getByLabel('Invite link').inputValue()
  expect(inviteUrl).toContain('/invite?token=')

  const invitedContext = await browser.newContext()
  const invitedPage = await invitedContext.newPage()
  try {
    await invitedPage.goto(inviteUrl)
    await invitedPage.getByRole('button', { name: 'Create account view' }).click()
    await invitedPage.getByLabel('Full name').fill('Grace Hopper')
    await invitedPage.getByLabel('Work email').fill(invitedEmail)
    await invitedPage.getByLabel('Password').fill(password)
    await invitedPage.getByRole('button', { name: 'Create account', exact: true }).click()
    await expect(invitedPage.getByRole('heading', { name: 'Team' })).toBeVisible()
    await expect(invitedPage.getByText('Grace Hopper')).toBeVisible()
  } finally {
    await invitedContext.close()
  }
})
