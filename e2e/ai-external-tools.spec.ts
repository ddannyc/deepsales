import { connectFacebookPages, createDatabase, setMemberChannelAccess } from '@deepsales/db'
import { expect, test } from '@playwright/test'
import { Pool } from 'pg'
import { signInAndCreateWorkspace } from './auth'

test.skip(!process.env.E2E_BASE_URL, 'Set E2E_BASE_URL to a running test deployment')
test('configures credentials and fixed write targets, inserts a tool and debugs in an isolated sandbox', async ({
  page,
}) => {
  await signInAndCreateWorkspace(page, 'ai-external-tools', 'External tool acceptance')
  const me = await page.request.get('/api/me').then((response) => response.json())
  const root = `/api/workspaces/${me.workspace.id}`
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  const db = createDatabase(pool)
  try {
    const [support] = await connectFacebookPages(db, {
      workspaceId: me.workspace.id,
      actingUserId: me.user.id,
      pages: [
        {
          pageId: crypto.randomUUID(),
          displayName: 'Tool support',
          encryptedPageAccessToken: 'cipher',
          tokenIv: 'iv',
          tokenKeyVersion: 'v1',
        },
      ],
    })
    await setMemberChannelAccess(db, {
      workspaceId: me.workspace.id,
      actingUserId: me.user.id,
      memberId: me.workspace.memberId,
      channelIds: [support.id],
    })
    const base = await page.request
      .post(`${root}/knowledge-bases`, { data: { name: 'Support' } })
      .then((response) => response.json())
    const ai = await page.request
      .post(`${root}/members`, { data: { displayName: 'Tool AI', channelIds: [support.id] } })
      .then((response) => response.json())
    await page.request.patch(`${root}/ai-members/${ai.member.id}/config`, {
      data: {
        instructions: 'Use knowledge for company facts.',
        responseLanguage: 'English',
        knowledgeBaseId: base.knowledgeBase.id,
      },
    })
    await page.goto(`/ai-member/${ai.member.id}`)
    const region = page.getByRole('region', { name: '外部 API 工具', exact: true })
    await region.getByRole('button', { name: '新建 API 插件', exact: true }).click()
    await region.getByLabel('插件名称', { exact: true }).fill('Support API')
    await region.getByLabel('设置或替换凭据', { exact: true }).fill('neutral-test-credential')
    await region.getByRole('button', { name: '保存 API 插件', exact: true }).click()
    await expect(region).toContainText('凭据已配置')
    await expect(region.getByLabel('设置或替换凭据', { exact: true })).toHaveValue('')
    await region.getByRole('button', { name: '添加工具到 Support API', exact: true }).click()
    await region.getByLabel('工具名称', { exact: true }).fill('Record status')
    await region.getByLabel('HTTP 方法', { exact: true }).click()
    await page.getByRole('option', { name: 'POST', exact: true }).click()
    await region.getByLabel('操作性质', { exact: true }).click()
    await page.getByRole('option', { name: '写入', exact: true }).click()
    await region
      .getByLabel('固定参数 JSON（name、location、value）', { exact: true })
      .fill('[{"name":"recordId","location":"body","value":"fixed-support-record"}]')
    await region
      .getByLabel('固定对象授权策略 JSON', { exact: true })
      .fill(
        JSON.stringify({
          policy: 'FIXED_CONFIG',
          description: 'Administrator-approved fixed support record.',
          targets: [{ name: 'recordId', location: 'body' }],
        }),
      )
    await region.getByRole('button', { name: '保存外部工具', exact: true }).click()
    await expect(region).toContainText('工具定义已立即生效')
    await region.getByRole('button', { name: '运行沙箱调试', exact: true }).click()
    await expect(region).toContainText('沙箱模拟')
    await expect(region).toContainText('沙箱示例')
    await expect(region.getByText('沙箱模拟 · 已完成', { exact: true })).toHaveAttribute(
      'data-slot',
      'badge',
    )
    await region.getByLabel('模拟输入 JSON', { exact: true }).fill('{"recordId":"other-record"}')
    await region.getByRole('button', { name: '运行沙箱调试', exact: true }).click()
    await expect(region.getByRole('alert')).toContainText('EXTERNAL_ARGUMENTS_INVALID')
    const picker = page.getByRole('combobox', { name: '插入工具', exact: true }).first()
    await picker.click()
    await page.getByRole('option', { name: 'Record status', exact: true }).click()
    await expect(page.locator('textarea').first()).toHaveValue(/\[\[tool:external:/)
    await region.getByRole('switch', { name: '启用工具', exact: true }).click()
    await region.getByRole('button', { name: '保存外部工具', exact: true }).click()
    await expect(region).toContainText('已停用')
  } finally {
    await pool.end()
  }
})
