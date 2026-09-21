import { expect, test } from '@playwright/test'
import { Pool } from 'pg'
import { e2eOwnerEmail, e2ePassword, signInAndCreateWorkspace } from './auth'

test.skip(!process.env.E2E_BASE_URL, 'Set E2E_BASE_URL to a running DeepSales deployment')

test('invalid invitation links show an explicit state', async ({ page }) => {
  await page.goto('/invite?token=not-a-real-token')

  await expect(page.getByRole('heading', { name: '邀请无效', exact: true })).toBeVisible()
  await expect(page.getByRole('alert')).toHaveText('This invitation is invalid.')
  await expect(page.locator('form')).toHaveCount(0)
})

test('new and existing users can complete an invitation without duplicate accounts', async ({
  browser,
  page,
}) => {
  const suffix = Date.now()
  const newEmail = `invite-new-${suffix}@example.com`
  const existingEmail = e2eOwnerEmail('invitation-existing')

  await signInAndCreateWorkspace(page, 'invitation', 'Invitation acceptance')
  await page.goto('/team')

  const newInviteUrl = await createInvite(page, newEmail, 'New teammate')
  const newContext = await browser.newContext()
  const newPage = await newContext.newPage()
  try {
    await newPage.goto(newInviteUrl)
    await expect(newPage.getByRole('heading', { name: '创建账户', exact: true })).toBeVisible()
    await newPage.getByLabel('姓名').fill('New teammate')
    await newPage.getByLabel('工作邮箱').fill(newEmail)
    await newPage.getByLabel('密码').fill(e2ePassword)
    await newPage.getByRole('button', { name: '创建账户', exact: true }).click()
    await expect(newPage.getByRole('heading', { name: '团队' })).toBeVisible()
  } finally {
    await newContext.close()
  }

  const existingInviteUrl = await createInvite(page, existingEmail, 'Existing teammate')
  const existingContext = await browser.newContext()
  const existingPage = await existingContext.newPage()
  try {
    await existingPage.goto(existingInviteUrl)
    await expect(existingPage.getByRole('heading', { name: '创建账户', exact: true })).toBeVisible()
    await existingPage.getByRole('button', { name: '登录视图', exact: true }).click()
    await existingPage.getByLabel('工作邮箱').fill(existingEmail)
    await existingPage.getByLabel('密码').fill(e2ePassword)
    await existingPage.getByRole('button', { name: '登录', exact: true }).click()
    await expect(existingPage.getByRole('heading', { name: '团队' })).toBeVisible()
  } finally {
    await existingContext.close()
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  try {
    const users = await pool.query('select count(*)::int as count from users where email = $1', [
      existingEmail,
    ])
    const memberships = await pool.query(
      `select count(*)::int as count
       from workspace_user_access a
       join users u on u.id = a.user_id
       where u.email = $1`,
      [existingEmail],
    )
    expect(users.rows[0]?.count).toBe(1)
    expect(memberships.rows[0]?.count).toBe(1)
  } finally {
    await pool.end()
  }
})

async function createInvite(page: import('@playwright/test').Page, email: string, name: string) {
  await page.getByRole('button', { name: '邀请成员', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('工作邮箱').fill(email)
  await dialog.getByLabel('显示名称').fill(name)
  await dialog.getByRole('button', { name: '创建邀请链接', exact: true }).click()
  await expect(dialog.getByRole('heading', { name: '一次性邀请链接' })).toBeVisible()
  const url = await dialog.getByRole('textbox', { name: '邀请链接' }).inputValue()
  await dialog.getByRole('button', { name: '完成', exact: true }).click()
  return url
}
