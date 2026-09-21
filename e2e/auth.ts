import { expect, type Page } from '@playwright/test'

export const e2ePassword = 'correct-horse-battery-staple'

export function e2eOwnerEmail(key: string) {
  return `e2e-owner-${key}@example.com`
}

export async function signIn(page: Page, key: string) {
  await page.goto('/login')
  await page.getByLabel('工作邮箱').fill(e2eOwnerEmail(key))
  await page.getByLabel('密码').fill(e2ePassword)
  await page.getByRole('button', { name: '登录', exact: true }).click()
}

export async function signInAndCreateWorkspace(page: Page, key: string, workspaceName: string) {
  await signIn(page, key)
  await expect(page.getByRole('heading', { name: '为工作区命名' })).toBeVisible()
  await page.getByLabel('工作区名称').fill(workspaceName)
  await page.getByRole('button', { name: '创建工作区', exact: true }).click()
  await expect(page.getByRole('heading', { name: '全部进行中', exact: true })).toBeVisible()
}
