import { expect, type Page, test, type WebSocketRoute } from '@playwright/test'

const workspace = { id: 'polling-workspace', name: 'Polling', role: 'OWNER', memberId: 'owner' }

async function mockWorkspace(page: Page) {
  await page.clock.install()
  await page.route('**/api/me', (route) =>
    route.fulfill({
      json: {
        user: { id: 'owner', name: 'Owner', email: 'owner@example.com' },
        workspace,
        workspaces: [workspace],
      },
    }),
  )
  await page.route('**/team', (route) => route.fulfill({ json: { members: [], channels: [] } }))
}

test('healthy Inbox stays idle; focus, realtime and reconnect refresh canonical data', async ({
  page,
}) => {
  await mockWorkspace(page)
  let requests = 0
  const sockets: WebSocketRoute[] = []
  await page.route('**/conversations?*', (route) => {
    requests++
    return route.fulfill({ json: { conversations: [], nextCursor: null } })
  })
  await page.routeWebSocket('**/realtime', (socket) => sockets.push(socket))
  await page.goto('/inbox')
  await expect(page.getByRole('heading', { name: '全部进行中', exact: true })).toBeVisible()
  await expect.poll(() => sockets.length).toBe(1)
  await expect.poll(() => requests).toBe(1)
  await page.clock.fastForward(300_001)
  expect(requests).toBe(1)

  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect.poll(() => requests).toBe(2)
  sockets[0]?.send(JSON.stringify({ type: 'conversation.changed', entityId: 'conversation' }))
  await expect.poll(() => requests).toBe(3)
  await sockets[0]?.close()
  await page.evaluate(() => new Promise((resolve) => window.setTimeout(resolve, 0)))
  await page.clock.fastForward(1_001)
  await expect.poll(() => sockets.length).toBe(2)
  await expect.poll(() => requests).toBe(4)
  await page.clock.fastForward(300_001)
  expect(requests).toBe(4)
})

test('Knowledge polls only unfinished documents while visible', async ({ page }) => {
  await mockWorkspace(page)
  await page.route('**/knowledge-bases', (route) =>
    route.fulfill({ json: { knowledgeBases: [{ id: 'base', name: 'Facts' }] } }),
  )
  let status = 'UPLOADED'
  let requests = 0
  await page.route('**/documents', (route) => {
    requests++
    return route.fulfill({
      json: {
        documents: [
          {
            id: 'doc',
            name: 'Shipping',
            sourceType: 'TEXT',
            status,
            createdAt: new Date().toISOString(),
          },
        ],
      },
    })
  })
  await page.goto('/knowledge')
  const document = page.locator('.knowledge-document')
  await expect(document).toHaveAttribute('data-status', 'UPLOADED')
  status = 'PROCESSING'
  await page.clock.fastForward(2_001)
  await expect(document).toHaveAttribute('data-status', 'PROCESSING')

  await page.evaluate(() => {
    Object.defineProperty(window.document, 'hidden', { configurable: true, value: true })
    window.document.dispatchEvent(new Event('visibilitychange'))
  })
  const hiddenRequests = requests
  await page.clock.fastForward(300_001)
  expect(requests).toBe(hiddenRequests)
  await page.evaluate(() => {
    Object.defineProperty(window.document, 'hidden', { configurable: true, value: false })
    window.document.dispatchEvent(new Event('visibilitychange'))
  })
  await expect.poll(() => requests).toBe(hiddenRequests + 1)
  status = 'READY'
  await page.clock.fastForward(2_001)
  await expect(document).toHaveAttribute('data-status', 'READY')
  const readyRequests = requests
  await page.clock.fastForward(300_001)
  expect(requests).toBe(readyRequests)

  status = 'FAILED'
  await page.evaluate(() => window.document.dispatchEvent(new Event('visibilitychange')))
  await expect(document).toHaveAttribute('data-status', 'FAILED')
  const failedRequests = requests
  await page.clock.fastForward(300_001)
  expect(requests).toBe(failedRequests)
})
