import { expect, test } from '@playwright/test'
import { signInAndCreateWorkspace } from './auth'

test.skip(!process.env.E2E_BASE_URL, 'Set E2E_BASE_URL to a running test deployment')

test('inserts an authorized tool and inspects its simulated action without production writes', async ({
  page,
}) => {
  await signInAndCreateWorkspace(page, 'ai-tools', 'AI tool acceptance')
  const me = await page.request.get('/api/me').then((r) => r.json())
  const root = `/api/workspaces/${me.workspace.id}`
  const base = await page.request
    .post(`${root}/knowledge-bases`, { data: { name: 'Facts' } })
    .then((r) => r.json())
  const ai = await page.request
    .post(`${root}/members`, { data: { displayName: 'Tool AI', channelIds: [] } })
    .then((r) => r.json())
  const configUrl = `${root}/ai-members/${ai.member.id}/config`
  expect(
    (
      await page.request.patch(configUrl, {
        data: {
          instructions: 'Answer safely. ',
          responseLanguage: 'English',
          knowledgeBaseId: base.knowledgeBase.id,
        },
      })
    ).status(),
  ).toBe(200)
  await page.goto(`/ai-member/${ai.member.id}`)
  await page.getByRole('combobox', { name: '插入工具', exact: true }).click()
  await page.getByRole('option', { name: '记录内部备注', exact: true }).click()
  await expect(page.getByRole('textbox', { name: /^指令/ })).toHaveValue(/\[\[tool:record\]\]/)
  const saved = page.waitForResponse(
    (r) => r.url().endsWith(configUrl) && r.request().method() === 'PATCH',
  )
  await page.getByRole('button', { name: '保存草稿', exact: true }).click()
  expect((await saved).status()).toBe(200)
  const bench = page.getByRole('region', { name: '多轮测试台', exact: true })
  await bench.getByRole('combobox', { name: '测试配置', exact: true }).click()
  await page.getByRole('option', { name: '当前已保存草稿', exact: true }).click()
  await bench.getByRole('textbox', { name: '测试问题', exact: true }).fill('Run internal note tool')
  await bench.getByRole('button', { name: '运行测试', exact: true }).click()
  await expect(bench.getByRole('log')).toContainText('Simulated note recorded.')
  await bench.getByRole('button', { name: '查看测试诊断', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'AI 运行诊断', exact: true })
  await expect(dialog.getByRole('heading', { name: '工具动作', exact: true })).toBeVisible()
  await expect(dialog).toContainText('记录内部备注')
  await expect(dialog).toContainText('仅模拟')
  await expect(dialog).toContainText('成功')
  await expect(dialog).not.toContainText('Sandbox-only internal note.')
  await page.screenshot({ path: 'test-results/ai-tools-desktop.png', fullPage: true })
})
