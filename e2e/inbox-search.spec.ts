import { expect, test } from '@playwright/test'
import {
  channel,
  createDatabase,
  customerTagDefinition,
  customer,
  channelIdentity,
  conversation,
  member,
  memberChannelAccess,
  user,
  workspaceUserAccess,
} from '@deepsales/db'
import { eq } from 'drizzle-orm'
import { Pool } from 'pg'
import { e2eOwnerEmail, signIn, signInAndCreateWorkspace } from './auth'

test.skip(!process.env.E2E_BASE_URL, 'Set E2E_BASE_URL to a running test deployment')

test('saves, restores after refresh, edits and deletes personal search views', async ({ page }) => {
  await signInAndCreateWorkspace(page, 'inbox-search', 'Search acceptance')
  await page.getByRole('textbox', { name: '姓名或备注' }).fill('Coverage')
  await page.getByRole('button', { name: '筛选与保存视图' }).click()
  await page.getByRole('textbox', { name: '视图名称' }).fill('Coverage view')
  await page.getByRole('button', { name: '另存为新视图' }).click()
  await expect(page.getByText('视图已保存', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  await page.reload()
  await expect(page.getByRole('textbox', { name: '姓名或备注' })).toHaveValue('Coverage')
  await page.getByRole('button', { name: '筛选与保存视图' }).click()
  await page.getByRole('textbox', { name: '视图名称' }).fill('Revised view')
  await page.getByRole('button', { name: '更新此视图' }).click()
  await expect(page.getByText('视图已保存', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '删除此视图' }).click()
  await page.getByRole('button', { name: '确认删除' }).click()
  await expect(page.getByText('视图已删除', { exact: true })).toBeVisible()
})

test('isolates private views, protects public edits and blocks invalid restore without widening results', async ({
  page,
  browser,
}) => {
  await signInAndCreateWorkspace(page, 'inbox-search-team', 'Search team acceptance')
  const { workspace } = (await (await page.request.get('/api/me')).json()) as {
    workspace: { id: string }
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  const db = createDatabase(pool)
  const context = await browser.newContext()
  const agentPage = await context.newPage()
  try {
    const [support] = await db
      .insert(channel)
      .values({ workspaceId: workspace.id, provider: 'FACEBOOK_MESSENGER', displayName: 'Support' })
      .returning()
    const [agentUser] = await db
      .select()
      .from(user)
      .where(eq(user.email, e2eOwnerEmail('inbox-search-agent')))
    const [access] = await db
      .insert(workspaceUserAccess)
      .values({ workspaceId: workspace.id, userId: agentUser.id, role: 'AGENT' })
      .returning()
    const [agent] = await db
      .insert(member)
      .values({
        workspaceId: workspace.id,
        workspaceUserAccessId: access.id,
        type: 'HUMAN',
        displayName: 'Search agent',
      })
      .returning()
    await db.insert(memberChannelAccess).values({ memberId: agent.id, channelId: support.id })
    for (const name of ['Old customer', 'New query customer']) {
      const [contact] = await db
        .insert(customer)
        .values({ workspaceId: workspace.id, displayName: name })
        .returning()
      const [identity] = await db
        .insert(channelIdentity)
        .values({
          workspaceId: workspace.id,
          channelId: support.id,
          customerId: contact.id,
          externalUserId: crypto.randomUUID(),
        })
        .returning()
      await db.insert(conversation).values({
        workspaceId: workspace.id,
        channelIdentityId: identity.id,
        queueReason: 'NEW_CONVERSATION',
        routingQueuedAt: new Date(),
      })
    }
    const base = `/api/workspaces/${workspace.id}`
    const personal = (await (
      await page.request.post(`${base}/inbox-views`, {
        data: {
          name: 'Private collection',
          scope: 'PERSONAL',
          filters: { view: 'all-open', query: 'Private' },
        },
      })
    ).json()) as { view: { id: string } }
    const shared = (await (
      await page.request.post(`${base}/inbox-views`, {
        data: { name: 'Shared collection', scope: 'PUBLIC', filters: { view: 'team' } },
      })
    ).json()) as { view: { id: string } }
    await signIn(agentPage, 'inbox-search-agent')
    await expect(agentPage.getByRole('heading', { name: '全部进行中', exact: true })).toBeVisible()
    await agentPage.getByRole('button', { name: '筛选与保存视图' }).click()
    await agentPage.getByRole('combobox', { name: '保存的视图' }).click()
    await expect(agentPage.getByRole('option', { name: /Private collection/ })).toHaveCount(0)
    await agentPage.getByRole('option', { name: /Shared collection/ }).click()
    await expect(agentPage.getByRole('button', { name: '更新此视图' })).toBeDisabled()
    await expect(agentPage.getByRole('button', { name: '删除此视图' })).toBeDisabled()
    await agentPage.getByRole('button', { name: '恢复此视图' }).click()
    await expect(agentPage.getByRole('heading', { name: '团队对话', exact: true })).toBeVisible()
    await agentPage.reload()
    await expect(agentPage.getByRole('heading', { name: '团队对话', exact: true })).toBeVisible()
    expect((await agentPage.request.delete(`${base}/inbox-views/${shared.view.id}`)).status()).toBe(
      403,
    )
    expect(
      (await agentPage.request.delete(`${base}/inbox-views/${personal.view.id}`)).status(),
    ).toBe(404)
    const [tag] = await db
      .insert(customerTagDefinition)
      .values({ workspaceId: workspace.id, name: 'Temporary', level: 'CUSTOMER' })
      .returning()
    const invalid = (await (
      await page.request.post(`${base}/inbox-views`, {
        data: {
          name: 'Needs repair',
          scope: 'PERSONAL',
          filters: { view: 'all-open', tagIds: [tag.id] },
        },
      })
    ).json()) as { view: { id: string } }
    await db.delete(customerTagDefinition).where(eq(customerTagDefinition.id, tag.id))
    let listRequests = 0
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === `${base}/conversations`) listRequests++
    })
    await page.goto(`/inbox?inboxView=${invalid.view.id}`)
    await expect(page.getByRole('alert').filter({ hasText: '保存视图包含失效' })).toBeVisible()
    expect(listRequests).toBe(0)
    await page.getByRole('button', { name: '清除全部条件' }).click()
    await expect.poll(() => listRequests).toBeGreaterThan(0)
    let release: (() => void) | undefined
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const oldReceived = new Promise<void>((resolve) => {
      void page.route('**/conversations?**', async (route) => {
        const url = new URL(route.request().url())
        if (url.searchParams.get('query') === 'old') {
          const response = await route.fetch()
          resolve()
          await held
          await route.fulfill({ response })
        } else await route.continue()
      })
    })
    await page.getByRole('textbox', { name: '姓名或备注' }).fill('old')
    await oldReceived
    await page.getByRole('textbox', { name: '姓名或备注' }).fill('new query')
    await expect(page.getByRole('textbox', { name: '姓名或备注' })).toHaveValue('new query')
    await expect(
      page.locator('.conversation-item').filter({ hasText: 'New query customer' }),
    ).toHaveCount(1)
    release?.()
    await expect(
      page.getByRole('button', { name: '筛选与保存视图（1）', exact: true }),
    ).toBeVisible()
    await expect(
      page.locator('.conversation-item').filter({ hasText: 'Old customer' }),
    ).toHaveCount(0)
  } finally {
    await context.close()
    await pool.end()
  }
})
