import { expect, test } from '@playwright/test'

test.skip(!process.env.E2E_BASE_URL, 'Set E2E_BASE_URL to a running DeepSales deployment')

test('owner creates an AI member, edits it, and invites a teammate', async ({ browser, page }) => {
  const suffix = Date.now()
  const ownerEmail = `team-owner-${suffix}@example.com`
  const invitedEmail = `team-agent-${suffix}@example.com`
  const password = 'correct-horse-battery-staple'

  await page.goto('/login')
  await page.getByRole('button', { name: '创建账户视图', exact: true }).click()
  await page.getByLabel('姓名').fill('Ada Lovelace')
  await page.getByLabel('工作邮箱').fill(ownerEmail)
  await page.getByLabel('密码').fill(password)
  await page.getByRole('button', { name: '创建账户', exact: true }).click()
  await page.getByLabel('工作区名称').fill('Team acceptance')
  await page.getByRole('button', { name: '创建工作区' }).click()
  await expect(page.getByRole('heading', { name: '收件箱已准备就绪' })).toBeVisible()

  await page.goto('/team')
  await expect(page.getByRole('heading', { name: '团队' })).toBeVisible()

  const aiForm = page.locator('form.team-card').filter({ hasText: '添加 AI 成员' })
  await aiForm.getByLabel('显示名称').fill('Answer Bot')
  await aiForm.getByRole('button', { name: '添加 AI 成员' }).click()
  const aiCard = page.locator('form.member-card').filter({ hasText: 'Answer Bot' })
  await expect(aiCard).toBeVisible()
  await aiCard.getByLabel('同时处理数').fill('4')
  await aiCard.getByRole('button', { name: '保存更改' }).click()

  const inviteForm = page.locator('form.team-card').filter({ hasText: '邀请团队成员' })
  await inviteForm.getByLabel('工作邮箱').fill(invitedEmail)
  await inviteForm.getByLabel('显示名称').fill('Grace Hopper')
  await inviteForm.getByRole('button', { name: '创建邀请链接' }).click()
  const inviteUrl = await page.getByLabel('邀请链接').inputValue()
  expect(inviteUrl).toContain('/invite?token=')

  const invitedContext = await browser.newContext()
  const invitedPage = await invitedContext.newPage()
  try {
    await invitedPage.goto(inviteUrl)
    await expect(invitedPage.getByRole('heading', { name: '创建账户' })).toBeVisible()
    await invitedPage.getByLabel('姓名').fill('Grace Hopper')
    await invitedPage.getByLabel('工作邮箱').fill(invitedEmail)
    await invitedPage.getByLabel('密码').fill(password)
    await invitedPage.getByRole('button', { name: '创建账户', exact: true }).click()
    await expect(invitedPage.getByRole('heading', { name: '团队' })).toBeVisible()
    await expect(invitedPage.getByText('Grace Hopper')).toBeVisible()
  } finally {
    await invitedContext.close()
  }
})
