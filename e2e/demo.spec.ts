import { expect, test } from '@playwright/test'

test.skip(!process.env.E2E_BASE_URL, 'Set E2E_BASE_URL to a running DeepSales deployment')

test('Chinese demo explains AI handling, handoff, takeover, and simulated reply', async ({
  page,
}) => {
  const mutations: string[] = []
  page.on('request', (request) => {
    if (request.method() !== 'GET') mutations.push(`${request.method()} ${request.url()}`)
  })

  await page.goto('/demo')
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN')
  await expect(page.getByText('示例工作区 · 所有数据均为虚构', { exact: true })).toBeVisible()
  await expect(page.getByText('Emily Carter', { exact: true }).first()).toBeVisible()
  await expect(page.getByRole('dialog')).toContainText('所有客户消息集中处理')

  await page.getByRole('button', { name: '下一步', exact: true }).click()
  await page.getByRole('button', { name: '下一步', exact: true }).click()
  await expect(page.getByRole('dialog')).toContainText('复杂问题自动转人工')
  await page.getByRole('button', { name: '开始体验', exact: true }).click()

  await page.locator('[data-conversation-id="emily"]').click()
  await expect(page.getByText('AI 处理中', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('商品常见问题', { exact: true })).toBeVisible()
  await expect(
    page.locator('.demo-thread').getByText('Can I use it for hiking?', { exact: true }),
  ).toBeVisible()

  await page.locator('[data-conversation-id="lucas"]').click()
  await expect(page.getByText('等待人工', { exact: true }).first()).toBeVisible()
  await page.locator('.demo-thread').getByRole('button', { name: '接管会话', exact: true }).click()
  await expect(page.locator('.demo-context-details').getByText('你', { exact: true })).toBeVisible()
  await expect(page.getByText('你已从 Nova 接管该会话。', { exact: true })).toBeVisible()

  await page.getByRole('button', { name: 'AI 生成回复', exact: true }).click()
  await expect(page.getByText('AI 正在生成建议...', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '使用回复', exact: true }).click()
  await expect(page.locator('#demo-reply')).toHaveValue(
    'Thanks for checking in. I’ll look into your order status and get back to you shortly.',
  )
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await expect(page.getByText('演示模式 · 消息未真实发送', { exact: true })).toBeVisible()
  await expect(
    page
      .locator('.demo-message-you')
      .getByText(
        'Thanks for checking in. I’ll look into your order status and get back to you shortly.',
        {
          exact: true,
        },
      ),
  ).toBeVisible()
  expect(mutations).toEqual([])

  await page.getByRole('button', { name: '重新开始', exact: true }).click()
  await expect(page.getByRole('dialog')).toContainText('所有客户消息集中处理')
  await expect(page.locator('[data-conversation-id="emily"]')).toHaveAttribute(
    'aria-pressed',
    'true',
  )
})

test('English demo route stays English and mobile has no horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/en/demo')

  await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  await expect(page.getByRole('button', { name: 'Restart', exact: true })).toBeVisible()
  await expect(page.getByText('Every customer message in one place', { exact: true })).toBeVisible()

  const fitsViewport = await page.evaluate(
    () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
  )
  expect(fitsViewport).toBe(true)
})

test('mobile demo switches between inbox, conversation, and context drawer', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/demo')
  await page.getByRole('button', { name: '跳过', exact: true }).click()
  await page.locator('[data-conversation-id="lucas"]').click()

  await expect(page.getByRole('button', { name: '返回收件箱', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '客户详情', exact: true }).click()
  await expect(page.locator('.demo-context.is-open')).toBeVisible()
  await page.locator('.demo-context').getByRole('button', { name: '接管会话', exact: true }).click()
  await page
    .locator('.demo-context')
    .getByRole('button', { name: '关闭客户详情', exact: true })
    .click()

  await page.getByRole('button', { name: 'AI 生成回复', exact: true }).click()
  await page.getByRole('button', { name: '使用回复', exact: true }).click()
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await expect(page.getByText('演示模式 · 消息未真实发送', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '返回收件箱', exact: true }).click()
  await expect(page.locator('[data-conversation-id="lucas"]')).toBeVisible()
})
