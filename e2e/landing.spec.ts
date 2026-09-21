import { expect, test } from '@playwright/test'

test.skip(!process.env.E2E_BASE_URL, 'Set E2E_BASE_URL to a running DeepSales deployment')

test('Chinese landing page is the default with private-beta CTAs', async ({ page }) => {
  await page.goto('/')

  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN')
  await expect(page).toHaveTitle('DeepSales — Facebook AI 客服与团队消息工作台')
  await expect(page.locator('meta[name="description"]')).toHaveAttribute(
    'content',
    '集中管理 Facebook Messenger 客户消息，让团队成员和 AI 客服一起处理客户咨询。',
  )
  await expect(
    page.getByRole('heading', { name: /Facebook 客户消息.*一个后台统一处理/ }),
  ).toBeVisible()
  await expect(page.getByText('统一处理客户消息', { exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: '仅限邀请', exact: true }).first()).toHaveAttribute(
    'href',
    '/login',
  )
  await expect(
    page.getByRole('link', { name: '体验在线 Demo', exact: true }).first(),
  ).toHaveAttribute('href', '/demo')
})

test('English landing page and locale navigation work', async ({ page }) => {
  await page.goto('/en#demo')

  await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  await expect(
    page.getByRole('heading', { name: 'Turn customer messages into conversations that sell.' }),
  ).toBeVisible()
  await expect(page).toHaveTitle('DeepSales — AI-powered shared inbox for customer conversations')
  await page.getByRole('link', { name: '中', exact: true }).first().click()
  await expect(page).toHaveURL(/\/#demo$/)
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN')
})

test('authenticated users stay on the landing page', async ({ page }) => {
  await page.route('**/api/me', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        user: { id: 'user-1', name: 'Demo User', email: 'demo@example.com' },
        workspaces: [
          { id: 'workspace-1', name: 'Demo workspace', role: 'OWNER', memberId: 'member-1' },
        ],
        workspace: {
          id: 'workspace-1',
          name: 'Demo workspace',
          role: 'OWNER',
          memberId: 'member-1',
        },
      }),
    }),
  )
  await page.goto('/')

  await expect(page).toHaveURL(/\/$/)
  const mainNavigation = page.getByRole('navigation', { name: '主导航' })
  await expect(mainNavigation.getByRole('link', { name: '打开工作台', exact: true })).toBeVisible()
  await expect(mainNavigation.getByRole('link', { name: '仅限邀请', exact: true })).toHaveCount(0)
})

test('landing CTAs route and mobile layout does not overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')

  await expect(
    page.getByRole('heading', { name: /Facebook 客户消息.*一个后台统一处理/ }),
  ).toBeVisible()
  const previewBox = await page.locator('.product-preview').boundingBox()
  expect(previewBox?.y ?? Number.POSITIVE_INFINITY).toBeLessThan(844)

  await page.getByRole('button', { name: '打开导航' }).click()
  await expect(page.getByRole('link', { name: '使用方式', exact: true })).toBeVisible()
  await page.locator('.hero-secondary-action').click()
  await expect(page).toHaveURL(/\/demo$/)
  await expect(page.getByRole('heading', { name: '收件箱', exact: true })).toBeVisible()

  const fitsViewport = await page.evaluate(
    () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
  )
  expect(fitsViewport).toBe(true)

  await page.goto('/')
  await page.getByRole('button', { name: '打开导航' }).click()
  await page.getByRole('link', { name: '仅限邀请', exact: true }).last().click()
  await expect(page).toHaveURL(/\/login$/)
})

test('public registration routes show private-beta guidance without a form', async ({ page }) => {
  for (const path of ['/sign-up', '/signup', '/register']) {
    await page.goto(path)
    await expect(page.getByRole('heading', { name: 'Private Beta', exact: true })).toBeVisible()
    await expect(
      page.getByText('Registration is available by invitation only.', { exact: true }),
    ).toBeVisible()
    await expect(page.locator('form')).toHaveCount(0)
    await expect(page.getByRole('link', { name: 'Sign in / 登录', exact: true })).toHaveAttribute(
      'href',
      '/login',
    )
  }
})

test('login keeps sign in and explains invitation-only registration', async ({ page }) => {
  await page.goto('/login')

  await expect(page.getByRole('heading', { name: '登录', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '创建账户视图', exact: true })).toHaveCount(0)
  await expect(page.getByRole('note')).toContainText(
    'DeepSales 目前处于邀请测试阶段，仅限受邀用户注册。',
  )
  await expect(page.getByRole('note')).toContainText(
    'DeepSales is currently in private beta. Registration is available by invitation only.',
  )
})
