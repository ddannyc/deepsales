import { channel, createDatabase, customerTagDefinition } from '@deepsales/db'
import { expect, test } from '@playwright/test'
import { Pool } from 'pg'
import { signInAndCreateWorkspace } from './auth'

test.skip(!process.env.E2E_BASE_URL, 'Set E2E_BASE_URL to a running test deployment')

test('publishes tag enablement separately from immediately effective authorized tag rules', async ({
  page,
}) => {
  await signInAndCreateWorkspace(page, 'ai-tags', 'Controlled tags')
  const me = await page.request.get('/api/me').then((r) => r.json())
  const root = `/api/workspaces/${me.workspace.id}`
  const base = await page.request
    .post(`${root}/knowledge-bases`, { data: { name: 'Support' } })
    .then((r) => r.json())
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  try {
    const db = createDatabase(pool)
    const [support] = await db
      .insert(channel)
      .values({
        workspaceId: me.workspace.id,
        provider: 'FACEBOOK_MESSENGER',
        displayName: 'Support',
      })
      .returning()
    await db
      .insert(customerTagDefinition)
      .values({ workspaceId: me.workspace.id, name: 'Follow up', level: 'CUSTOMER' })
    const ai = await page.request
      .post(`${root}/members`, { data: { displayName: 'Tag AI', channelIds: [support.id] } })
      .then((r) => r.json())
    const url = `${root}/ai-members/${ai.member.id}/config`
    expect(
      (
        await page.request.patch(url, {
          data: {
            instructions: 'Answer safely.',
            responseLanguage: 'English',
            knowledgeBaseId: base.knowledgeBase.id,
          },
        })
      ).status(),
    ).toBe(200)
    await page.goto(`/ai-member/${ai.member.id}`)
    const enabled = page.getByRole('switch', { name: '启用 AI 标签追加', exact: true })
    await expect(enabled).not.toBeChecked()
    await page.getByRole('combobox', { name: '插入变量', exact: true }).click()
    await page.getByRole('option', { name: '联系人姓名 · 文本', exact: true }).click()
    await expect(page.getByRole('textbox', { name: /^指令/ })).toHaveValue(/\{\{customer\.name\}\}/)
    await enabled.click()
    const saved = page.waitForResponse(
      (response) => response.url().endsWith(url) && response.request().method() === 'PATCH',
    )
    await page.getByRole('button', { name: '保存草稿', exact: true }).click()
    expect((await saved).status()).toBe(200)
    const config = await page.request.get(url).then((r) => r.json())
    expect(config.config.tagsEnabled).toBe(true)
    expect(config.config.instructions).toContain('{{customer.name}}')
    expect(config.config.publishedSnapshot).toBeNull()
    await page.getByRole('button', { name: '发布', exact: true }).click()
    await expect
      .poll(
        async () =>
          (await page.request.get(url).then((r) => r.json())).config.publishedSnapshot?.tagsEnabled,
      )
      .toBe(true)
    expect(
      (await page.request.get(url).then((r) => r.json())).config.publishedSnapshot.instructions,
    ).toContain('{{customer.name}}')
    const region = page.getByRole('region', { name: 'AI 标签追加', exact: true })
    await region.getByRole('combobox', { name: '追加标签', exact: true }).click()
    await page.getByRole('option', { name: /Follow up/ }).click()
    await region
      .getByLabel('追加说明', { exact: true })
      .fill('Only explicit requests for a follow up.')
    await region.getByRole('button', { name: '保存追加规则', exact: true }).click()
    await expect(region.getByRole('status')).toContainText('追加规则已保存，立即生效')
    const rules = await page.request
      .get(`${root}/ai-operations/${ai.member.id}/tag-rules`)
      .then((r) => r.json())
    expect(rules.rules).toMatchObject([{ enabled: true, revision: 1 }])
    await page.reload()
    await expect(enabled).toBeChecked()
    await expect(region).toContainText('Follow up')
  } finally {
    await pool.end()
  }
})
