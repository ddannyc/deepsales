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
  await expect(page.getByRole('heading', { name: '全部进行中', exact: true })).toBeVisible()

  await page.goto('/team')
  await expect(page.getByRole('heading', { name: '团队' })).toBeVisible()

  await page.getByRole('button', { name: '添加 AI 成员', exact: true }).click()
  const addAiDialog = page.getByRole('dialog')
  await addAiDialog.getByLabel('显示名称').fill('Answer Bot')
  await addAiDialog.getByRole('button', { name: '添加 AI 成员', exact: true }).click()
  const aiRow = page.getByRole('row').filter({ hasText: 'Answer Bot' })
  await expect(aiRow).toBeVisible()
  await aiRow.getByRole('button', { name: 'Answer Bot 的更多操作' }).click()
  await page.getByRole('menuitem', { name: '编辑成员设置' }).click()
  const editDialog = page.getByRole('dialog')
  await editDialog.getByLabel('最大并行对话数').fill('4')
  await editDialog.getByRole('button', { name: '保存更改' }).click()

  await page.getByRole('button', { name: '邀请成员', exact: true }).click()
  const inviteDialog = page.getByRole('dialog')
  await inviteDialog.getByLabel('工作邮箱').fill(invitedEmail)
  await inviteDialog.getByLabel('显示名称').fill('Grace Hopper')
  await inviteDialog.getByRole('button', { name: '创建邀请链接' }).click()
  await expect(inviteDialog.getByRole('heading', { name: '一次性邀请链接' })).toBeVisible()
  const inviteUrl = await inviteDialog.getByRole('textbox', { name: '邀请链接' }).inputValue()
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
    await expect(invitedPage.locator('.team-page').getByText('Grace Hopper')).toBeVisible()
  } finally {
    await invitedContext.close()
  }
})
