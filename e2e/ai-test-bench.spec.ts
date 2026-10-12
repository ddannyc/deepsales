import {
  claimKnowledgeDocument,
  completeKnowledgeDocument,
  createDatabase,
  createInlineKnowledgeDocument,
} from '@deepsales/db'
import { expect, test } from '@playwright/test'
import { Pool } from 'pg'
import { signInAndCreateWorkspace } from './auth'

test.skip(!process.env.E2E_BASE_URL, 'Set E2E_BASE_URL to a running DeepSales deployment')

test('keeps successive test questions grounded, restores history and discards a late cleared response', async ({
  page,
}) => {
  test.setTimeout(90_000)
  await signInAndCreateWorkspace(page, 'ai-bench', 'Test bench acceptance')
  const me = await page.request.get('/api/me').then((response) => response.json())
  const root = `/api/workspaces/${me.workspace.id}`
  const base = await page.request
    .post(`${root}/knowledge-bases`, { data: { name: 'Options' } })
    .then((r) => r.json())
  const ai = await page.request
    .post(`${root}/members`, { data: { displayName: 'Test AI', channelIds: [] } })
    .then((r) => r.json())
  expect(
    (
      await page.request.patch(`${root}/ai-members/${ai.member.id}/config`, {
        data: {
          instructions: 'Answer from the supplied options.',
          responseLanguage: 'English',
          knowledgeBaseId: base.knowledgeBase.id,
        },
      })
    ).status(),
  ).toBe(200)
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  try {
    const db = createDatabase(pool)
    const document = await createInlineKnowledgeDocument(db, {
      workspaceId: me.workspace.id,
      knowledgeBaseId: base.knowledgeBase.id,
      createdByUserId: me.user.id,
      name: 'Colors',
      text: 'Torch One comes in red. Torch Two comes in blue.',
    })
    const claim = await claimKnowledgeDocument(db, { documentId: document.id })
    if (!claim) throw new Error('Knowledge was not claimed')
    await completeKnowledgeDocument(db, {
      documentId: document.id,
      processingStartedAt: claim.processingStartedAt,
      workspaceId: me.workspace.id,
      knowledgeBaseId: base.knowledgeBase.id,
      contentSha256: 'e'.repeat(64),
      embeddingMetadata: { provider: 'alibaba', model: 'qwen3.7-text-embedding', dimensions: 1536 },
      chunks: [
        {
          text: 'Torch One comes in red. Torch Two comes in blue.',
          embedding: Array.from({ length: 1536 }, (_, i) => (i === 0 ? 1 : 0)),
        },
      ],
    })
  } finally {
    await pool.end()
  }
  await page.goto(`/ai-member/${ai.member.id}`)
  const bench = page.getByRole('region', { name: '多轮测试台', exact: true })
  await bench.getByRole('combobox', { name: '测试配置', exact: true }).click()
  await page.getByRole('option', { name: '当前已保存草稿', exact: true }).click()
  await bench.getByText('模拟客户资料', { exact: true }).click()
  await bench.getByLabel('模拟记忆', { exact: true }).fill('Prefers blue')
  await bench.getByRole('textbox', { name: '测试问题', exact: true }).fill('Compare Torch options')
  await bench.getByRole('button', { name: '运行测试', exact: true }).click()
  const history = bench.getByRole('log', { name: '测试对话记录', exact: true })
  await expect(history).toContainText('Option one is Torch One. Option two is Torch Two.', {
    timeout: 10_000,
  })
  await expect(bench.getByRole('status')).toContainText('已保存草稿快照')
  await bench
    .getByRole('textbox', { name: '测试问题', exact: true })
    .fill('Does the second option come in blue?')
  await bench.getByRole('button', { name: '运行测试', exact: true }).click()
  await expect(history).toContainText('Torch Two comes in blue.', { timeout: 10_000 })
  await page.reload()
  await expect(history).toContainText('Torch Two comes in blue.')
  let release: () => void = () => {}
  let fetched: () => void = () => {}
  const waiting = new Promise<void>((resolve) => {
    release = resolve
  })
  const received = new Promise<void>((resolve) => {
    fetched = resolve
  })
  await page.route('**/ai-operations/*/test', async (route) => {
    const response = await route.fetch()
    fetched()
    await waiting
    await route.fulfill({ response })
  })
  await bench
    .getByRole('textbox', { name: '测试问题', exact: true })
    .fill('Compare Torch options again')
  await bench.getByRole('button', { name: '运行测试', exact: true }).click()
  await received
  await bench.getByRole('button', { name: '清空测试', exact: true }).click()
  await expect(history.getByRole('article')).toHaveCount(0)
  release()
  await expect(bench.getByRole('button', { name: '运行测试', exact: true })).toBeDisabled()
  await expect(history.getByRole('article')).toHaveCount(0)
  await bench.getByText('模拟客户资料', { exact: true }).click()
  await expect(bench.getByLabel('模拟记忆', { exact: true })).toHaveValue('')
  await page.unroute('**/ai-operations/*/test')
  await page.route('**/ai-operations/*/test', (route) =>
    route.fulfill({ status: 503, json: { error: { code: 'UNAVAILABLE' } } }),
  )
  await bench.getByRole('textbox', { name: '测试问题', exact: true }).fill('Retain this question')
  await bench.getByRole('button', { name: '运行测试', exact: true }).click()
  await expect(bench.getByRole('alert')).toContainText('操作未确认成功')
  await expect(bench.getByRole('textbox', { name: '测试问题', exact: true })).toHaveValue(
    'Retain this question',
  )
  const inbox = await page.request.get(`${root}/conversations?view=all-open`).then((r) => r.json())
  expect(inbox.conversations).toEqual([])
})
