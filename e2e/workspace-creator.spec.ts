import { expect, test } from '@playwright/test'
import { Pool } from 'pg'
import { e2ePassword } from './auth'

test.skip(
  !process.env.E2E_BASE_URL || !process.env.E2E_CREATOR_INVITATION_TOKEN,
  'Run through scripts/run-e2e.ts to seed the creator invitation',
)

test('creator signup resumes workspace setup after reload', async ({ page }) => {
  const email = 'e2e-registration@example.com'
  const token = process.env.E2E_CREATOR_INVITATION_TOKEN
  if (!token) throw new Error('Creator invitation was not seeded')

  await page.goto(`/signup?invite=${encodeURIComponent(token)}`)
  await expect(
    page.getByText('你已获得 DeepSales 邀请测试资格。注册后即可创建自己的工作区。'),
  ).toBeVisible()
  await page.getByLabel('姓名').fill('Creator User')
  await page.getByLabel('工作邮箱').fill(email)
  await page.getByLabel('密码').fill(e2ePassword)
  await page.getByRole('button', { name: '创建账户', exact: true }).click()

  await expect(page.getByRole('heading', { name: '为工作区命名' })).toBeVisible()
  await expect(page).toHaveURL(/\/workspace\/setup$/)
  const me = await page.request.get('/api/me')
  expect((await me.json()).workspace).toBeNull()
  await page.reload()
  await expect(page.getByRole('heading', { name: '为工作区命名' })).toBeVisible()
  await page.context().clearCookies()
  await page.goto('/login')
  await page.getByLabel('工作邮箱').fill(email)
  await page.getByLabel('密码').fill(e2ePassword)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page).toHaveURL(/\/workspace\/setup$/)
  await expect(page.getByRole('heading', { name: '为工作区命名' })).toBeVisible()

  await page.getByLabel('工作区名称').fill('Creator workspace')
  await page.getByRole('button', { name: '创建工作区', exact: true }).click()
  await expect(page).toHaveURL(/\/inbox$/)
  await expect(page.getByRole('heading', { name: '全部进行中', exact: true })).toBeVisible()

  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  try {
    const result = await pool.query(
      `select a.role, i.workspace_created_at
       from users u
       join workspace_user_access a on a.user_id = u.id
       join registration_invitation i on i.accepted_by_user_id = u.id
       where u.email = $1`,
      [email],
    )
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]?.role).toBe('OWNER')
    expect(result.rows[0]?.workspace_created_at).not.toBeNull()
  } finally {
    await pool.end()
  }
})
