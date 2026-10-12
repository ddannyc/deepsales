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

test('maintains neutral question sets, executes fixed batches and keeps cancellation and late results isolated', async ({
  page,
}) => {
  test.setTimeout(90_000)
  await signInAndCreateWorkspace(page, 'ai-batch', 'Batch acceptance')
  const me = await page.request.get('/api/me').then((r) => r.json())
  const root = `/api/workspaces/${me.workspace.id}`
  const base = await page.request
    .post(`${root}/knowledge-bases`, { data: { name: 'Support' } })
    .then((r) => r.json())
  const ai = await page.request
    .post(`${root}/members`, { data: { displayName: 'Batch AI', channelIds: [] } })
    .then((r) => r.json())
  expect(
    (
      await page.request.patch(`${root}/ai-members/${ai.member.id}/config`, {
        data: {
          instructions: 'Use the supplied support knowledge.',
          responseLanguage: 'English',
          knowledgeBaseId: base.knowledgeBase.id,
        },
      })
    ).status(),
  ).toBe(200)
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  try {
    const db = createDatabase(pool)
    const doc = await createInlineKnowledgeDocument(db, {
      workspaceId: me.workspace.id,
      knowledgeBaseId: base.knowledgeBase.id,
      createdByUserId: me.user.id,
      name: 'Shipping',
      text: 'Shipping is free.',
    })
    const claim = await claimKnowledgeDocument(db, { documentId: doc.id })
    if (!claim) throw new Error('No knowledge claim')
    await completeKnowledgeDocument(db, {
      documentId: doc.id,
      processingStartedAt: claim.processingStartedAt,
      workspaceId: me.workspace.id,
      knowledgeBaseId: base.knowledgeBase.id,
      contentSha256: 'c'.repeat(64),
      embeddingMetadata: { provider: 'alibaba', model: 'qwen3.7-text-embedding', dimensions: 1536 },
      chunks: [
        {
          text: 'Shipping is free.',
          embedding: Array.from({ length: 1536 }, (_, i) => (i === 0 ? 1 : 0)),
        },
      ],
    })
  } finally {
    await pool.end()
  }
  await page.goto(`/ai-member/${ai.member.id}`)
  const batch = page.getByRole('region', { name: 'AI 批量问题测试', exact: true })
  await batch.getByRole('textbox', { name: '问题集名称', exact: true }).fill('Support checks')
  await batch
    .getByRole('textbox', { name: '测试问题，每行一题', exact: true })
    .fill('How is shipping handled?\nWhat help can you offer?\nHello.')
  await batch.getByRole('button', { name: '保存问题集', exact: true }).click()
  await expect(batch).toContainText('问题集已保存。')
  await batch.getByRole('button', { name: '创建批次', exact: true }).click()
  await expect(batch).toContainText('批次已创建，尚未调用模型。')
  const rows = batch.getByRole('row')
  await expect(rows).toHaveCount(4)
  await batch
    .getByRole('textbox', { name: '测试问题，每行一题', exact: true })
    .fill('An edited question.')
  await batch.getByRole('button', { name: '保存问题集', exact: true }).click()
  await expect(rows.nth(1)).toContainText('How is shipping handled?')
  expect(
    (
      await page.request.patch(`${root}/ai-members/${ai.member.id}/config`, {
        data: { instructions: 'A newer saved draft.' },
      })
    ).status(),
  ).toBe(200)
  let release: () => void = () => {},
    received: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const failed = new Promise<void>((resolve) => {
    received = resolve
  })
  let delivered: () => void = () => {}
  const delivery = new Promise<void>((resolve) => {
    delivered = resolve
  })
  let calls = 0
  await page.route('**/ai-operations/*/batches/*/execute', async (route) => {
    const response = await route.fetch()
    calls++
    if (calls === 2) {
      received()
      await gate
    }
    await route.fulfill({ response })
    if (calls === 2) delivered()
  })
  await batch.getByRole('button', { name: '执行或恢复批次', exact: true }).click()
  await failed
  await expect(rows.nth(1)).toContainText('Shipping is free.')
  await batch.getByRole('button', { name: '取消未开始题', exact: true }).click()
  await expect(rows.nth(2)).toContainText('模型输出无效')
  await expect(rows.nth(3)).toContainText('已取消')
  await batch.getByRole('button', { name: '创建批次', exact: true }).click()
  await expect(rows).toHaveCount(2)
  await expect(rows.nth(1)).toContainText('An edited question.')
  release()
  await delivery
  await page.unroute('**/ai-operations/*/batches/*/execute')
  await expect(rows.nth(1)).toContainText('待执行')
  await page.reload()
  await expect(rows.nth(1)).toContainText('An edited question.')
  await expect(rows.nth(1)).toContainText('待执行')
  await batch.getByRole('button', { name: '执行或恢复批次', exact: true }).click()
  await expect(rows.nth(1)).toContainText('已完成', { timeout: 15000 })
  await rows.nth(1).getByRole('button', { name: '查看依据与诊断', exact: true }).click()
  await expect(page.getByRole('dialog')).toContainText('Shipping is free.')
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click()
  await batch.getByRole('combobox', { name: '问题集', exact: true }).click()
  await page.getByRole('option', { name: 'Support checks', exact: true }).click()
  await batch.getByRole('button', { name: '删除问题集', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: '确认删除', exact: true }).click()
  await expect(batch).toContainText('问题集已删除，历史批次保留。')
  await expect(rows.nth(1)).toContainText('已完成')
  expect(await page.request.get(`${root}/conversations`).then((r) => r.json())).toEqual({
    conversations: [],
    nextCursor: null,
  })
})
