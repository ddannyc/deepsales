import { channel, createDatabase, customerPropertyDefinition } from '@deepsales/db'
import { expect, test } from '@playwright/test'
import { Pool } from 'pg'
import { signInAndCreateWorkspace } from './auth'

test.skip(!process.env.E2E_BASE_URL, 'Set E2E_BASE_URL to a running test deployment')
test('manages immediate collection rules and preserves editor drafts during independent changes', async ({
  page,
}) => {
  await signInAndCreateWorkspace(page, 'ai-properties', 'Property collection')
  const me = await page.request.get('/api/me').then((r) => r.json())
  const root = `/api/workspaces/${me.workspace.id}`
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
    await db.insert(customerPropertyDefinition).values({
      workspaceId: me.workspace.id,
      name: 'Contact preference',
      level: 'CUSTOMER',
      type: 'TEXT',
    })
    const ai = await page.request
      .post(`${root}/members`, { data: { displayName: 'Collection AI', channelIds: [support.id] } })
      .then((r) => r.json())
    const other = await page.request
      .post(`${root}/members`, { data: { displayName: 'Other AI', channelIds: [support.id] } })
      .then((r) => r.json())
    await page.goto(`/ai-member/${ai.member.id}`)
    const region = page.getByRole('region', { name: 'AI 属性采集', exact: true })
    await region.getByRole('combobox', { name: '采集属性', exact: true }).click()
    await page
      .getByRole('option', { name: 'Contact preference · 客户级 · 文本', exact: true })
      .click()
    await region
      .getByLabel('采集说明', { exact: true })
      .fill('Collect the explicitly stated contact preference.')
    await region.getByRole('button', { name: '保存采集规则', exact: true }).click()
    await expect(region.getByRole('status')).toContainText('采集规则已保存，立即生效')
    const rulesUrl = `${root}/ai-operations/${ai.member.id}/property-rules`
    expect((await page.request.get(rulesUrl).then((r) => r.json())).rules).toMatchObject([
      { enabled: true, revision: 1 },
    ])
    const config = await page.request
      .get(`${root}/ai-members/${ai.member.id}/config`)
      .then((r) => r.json())
    expect(config.config.publishedSnapshot).toBeNull()
    await region.getByRole('button', { name: '编辑采集规则', exact: true }).click()
    await region.getByLabel('采集说明', { exact: true }).fill('An unfinished edited instruction.')
    await region.getByRole('switch', { name: '启用采集 Contact preference', exact: true }).click()
    await expect(
      region.getByRole('switch', { name: '启用采集 Contact preference', exact: true }),
    ).not.toBeChecked()
    await expect(region.getByLabel('采集说明', { exact: true })).toHaveValue(
      'An unfinished edited instruction.',
    )
    await region.getByRole('button', { name: '删除采集规则', exact: true }).click()
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: '保留规则', exact: true })
      .click()
    await expect(region.getByLabel('采集说明', { exact: true })).toHaveValue(
      'An unfinished edited instruction.',
    )
    await region.getByRole('button', { name: '删除采集规则', exact: true }).click()
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: '确认删除采集规则', exact: true })
      .click()
    await expect(region).toContainText('暂无采集规则。')
    await expect(region.getByLabel('采集说明', { exact: true })).toHaveValue(
      'An unfinished edited instruction.',
    )
    await page.goto(`/ai-member/${other.member.id}`)
    await expect(region.getByLabel('采集说明', { exact: true })).toHaveValue('')
    await expect(region).toContainText('暂无采集规则。')
  } finally {
    await pool.end()
  }
})
