import { expect, test } from '@playwright/test'
import { signInAndCreateWorkspace } from './auth'

test.skip(!process.env.E2E_BASE_URL, 'Set E2E_BASE_URL to a running test deployment')

test('saves ordered skill drafts and shows the first simulated match', async ({ page }) => {
  await signInAndCreateWorkspace(page, 'ai-skills', 'AI skill acceptance')
  const me = await page.request.get('/api/me').then((r) => r.json())
  const root = `/api/workspaces/${me.workspace.id}`
  const base = await page.request
    .post(`${root}/knowledge-bases`, { data: { name: 'Facts' } })
    .then((r) => r.json())
  const ai = await page.request
    .post(`${root}/members`, { data: { displayName: 'Skill AI', channelIds: [] } })
    .then((r) => r.json())
  const configUrl = `${root}/ai-members/${ai.member.id}/config`
  expect(
    (
      await page.request.patch(configUrl, {
        data: {
          instructions: 'Answer safely.',
          responseLanguage: 'English',
          knowledgeBaseId: base.knowledgeBase.id,
        },
      })
    ).status(),
  ).toBe(200)
  await page.goto(`/ai-member/${ai.member.id}`)
  await page.getByRole('button', { name: '添加技能', exact: true }).click()
  const first = page.getByRole('listitem', { name: '技能 1', exact: true })
  await first.getByRole('textbox', { name: '技能名称', exact: true }).fill('General setup')
  await first
    .getByRole('textbox', { name: '触发条件', exact: true })
    .fill('Customer asks for setup')
  await first
    .getByRole('textbox', { name: '技能指令', exact: true })
    .fill('Explain the setup steps.')
  await page.getByRole('button', { name: '添加技能', exact: true }).click()
  const second = page.getByRole('listitem', { name: '技能 2', exact: true })
  await second.getByRole('textbox', { name: '技能名称', exact: true }).fill('Priority setup')
  await second
    .getByRole('textbox', { name: '触发条件', exact: true })
    .fill('Customer needs setup help')
  await second
    .getByRole('textbox', { name: '技能指令', exact: true })
    .fill('Offer a clear first step.')
  await second.getByRole('button', { name: '上移', exact: true }).click()
  await expect(first.getByRole('textbox', { name: '技能名称', exact: true })).toHaveValue(
    'Priority setup',
  )
  const saved = page.waitForResponse(
    (r) => r.url().endsWith(configUrl) && r.request().method() === 'PATCH',
  )
  await page.getByRole('button', { name: '保存草稿', exact: true }).click()
  expect((await saved).status()).toBe(200)
  await page.reload()
  await expect(first.getByRole('textbox', { name: '技能名称', exact: true })).toHaveValue(
    'Priority setup',
  )
  const bench = page.getByRole('region', { name: '多轮测试台', exact: true })
  await bench.getByRole('combobox', { name: '测试配置', exact: true }).click()
  await page.getByRole('option', { name: '当前已保存草稿', exact: true }).click()
  await bench.getByRole('textbox', { name: '测试问题', exact: true }).fill('Help with setup')
  await bench.getByRole('button', { name: '运行测试', exact: true }).click()
  await expect(bench.getByRole('log')).toContainText('命中技能：Priority setup')
  await expect(bench.getByRole('log')).not.toContainText('命中技能：General setup')
  await bench.getByRole('button', { name: '查看测试诊断', exact: true }).click()
  await expect(
    page.getByRole('dialog', { name: 'AI 运行诊断', exact: true }).getByTestId('selected-skill'),
  ).toContainText('Priority setup')
  await page.screenshot({ path: 'test-results/ai-skills-desktop.png', fullPage: true })
})
