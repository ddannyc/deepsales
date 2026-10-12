import {
  channel,
  channelIdentity,
  createDatabase,
  customerMemory,
  facebookChannelConfig,
  member,
  processFacebookInbound,
  setMemberChannelAccess,
} from '@deepsales/db'
import { expect, test } from '@playwright/test'
import { and, eq, sql } from 'drizzle-orm'
import { Pool } from 'pg'
import { signInAndCreateWorkspace } from './auth'

test.skip(!process.env.E2E_BASE_URL, 'Set E2E_BASE_URL to a running test deployment')

test('publishes memory explicitly, keeps stored summaries when disabled and confirms administrator clearing', async ({
  page,
}) => {
  await signInAndCreateWorkspace(page, 'customer-memory', 'Memory acceptance')
  const me = await page.request.get('/api/me').then((r) => r.json())
  const root = `/api/workspaces/${me.workspace.id}`
  const base = await page.request
    .post(`${root}/knowledge-bases`, { data: { name: 'Support' } })
    .then((r) => r.json())
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  const db = createDatabase(pool)
  try {
    const [support] = await db
      .insert(channel)
      .values({
        workspaceId: me.workspace.id,
        provider: 'FACEBOOK_MESSENGER',
        displayName: 'Support',
      })
      .returning()
    const pageId = crypto.randomUUID()
    await db.insert(facebookChannelConfig).values({
      channelId: support.id,
      pageId,
      encryptedPageAccessToken: 'test-cipher',
      tokenIv: 'test-iv',
      tokenKeyVersion: 'v1',
    })
    const [owner] = await db
      .select()
      .from(member)
      .where(and(eq(member.workspaceId, me.workspace.id), eq(member.type, 'HUMAN')))
    await setMemberChannelAccess(db, {
      workspaceId: me.workspace.id,
      memberId: owner.id,
      actingUserId: me.user.id,
      channelIds: [support.id],
    })
    const ai = await page.request
      .post(`${root}/members`, { data: { displayName: 'Memory AI', channelIds: [support.id] } })
      .then((r) => r.json())
    const configUrl = `${root}/ai-members/${ai.member.id}/config`
    expect(
      (
        await page.request.patch(configUrl, {
          data: {
            instructions: 'Answer safely from supplied knowledge.',
            responseLanguage: 'English',
            knowledgeBaseId: base.knowledgeBase.id,
          },
        })
      ).status(),
    ).toBe(200)
    await page.goto(`/ai-member/${ai.member.id}`)
    await expect(
      page.getByRole('switch', { name: '使用客户长期摘要', exact: true }),
    ).not.toBeChecked()
    await page.getByRole('switch', { name: '使用客户长期摘要', exact: true }).click()
    await expect(page.getByRole('switch', { name: '使用客户长期摘要', exact: true })).toBeChecked()
    const saved = page.waitForResponse(
      (response) => response.url().endsWith(configUrl) && response.request().method() === 'PATCH',
    )
    await page.getByRole('button', { name: '保存草稿', exact: true }).click()
    expect((await (await saved).json()).config.memoryEnabled).toBe(true)
    expect((await page.request.get(configUrl).then((r) => r.json())).config).toMatchObject({
      memoryEnabled: true,
      publishedSnapshot: null,
    })
    await page.getByRole('button', { name: '发布', exact: true }).click()
    await expect(page.locator('.ai-published-panel')).toContainText('客户长期摘要')
    const inbound = await processFacebookInbound(db, {
      ingressId: crypto.randomUUID(),
      pageId,
      externalUserId: crypto.randomUUID(),
      externalMessageId: crypto.randomUUID(),
      text: 'I prefer concise explanations.',
      providerSentAt: new Date(),
      receivedAt: new Date(),
      payloadSha256: 'a'.repeat(64),
      eventFragment: {},
    })
    if (inbound.kind !== 'created') throw new Error('Missing conversation')
    const [identity] = await db
      .select()
      .from(channelIdentity)
      .where(
        eq(
          channelIdentity.id,
          sql`(select channel_identity_id from conversation where id = ${inbound.conversationId})`,
        ),
      )
    await db
      .update(customerMemory)
      .set({ summary: 'Customer prefers concise explanations.', sourceChannelIds: [support.id] })
      .where(eq(customerMemory.customerId, identity.customerId))
    await page.getByRole('switch', { name: '使用客户长期摘要', exact: true }).click()
    const savedDisabled = page.waitForResponse(
      (response) => response.url().endsWith(configUrl) && response.request().method() === 'PATCH',
    )
    await page.getByRole('button', { name: '保存草稿', exact: true }).click()
    expect((await (await savedDisabled).json()).config.memoryEnabled).toBe(false)
    const publishedDisabled = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/ai-members/${ai.member.id}/publish`) &&
        response.request().method() === 'POST',
    )
    await page.getByRole('button', { name: '发布', exact: true }).click()
    expect((await (await publishedDisabled).json()).config.publishedSnapshot.memoryEnabled).toBe(
      false,
    )
    expect(
      (await page.request.get(configUrl).then((r) => r.json())).config.publishedSnapshot
        .memoryEnabled,
    ).toBe(false)
    await page.goto('/inbox')
    await expect(page.locator('.message-bubble')).toContainText('I prefer concise explanations.')
    await page.getByRole('button', { name: '客户资料', exact: true }).click()
    const memory = page.getByRole('region', { name: '客户长期摘要', exact: true })
    await expect(memory).toContainText('Customer prefers concise explanations.')
    await memory.getByRole('button', { name: '清除长期摘要', exact: true }).click()
    const confirmation = page.getByRole('dialog', { name: '清除长期摘要？', exact: true })
    await expect(confirmation).toContainText('旧历史不会自动重建摘要')
    await confirmation.getByRole('button', { name: '保留摘要', exact: true }).click()
    await expect(memory).toContainText('Customer prefers concise explanations.')
    await memory.getByRole('button', { name: '清除长期摘要', exact: true }).click()
    await confirmation.getByRole('button', { name: '确认清除摘要', exact: true }).click()
    await expect(memory).toContainText('暂无长期摘要。')
    await page.getByRole('button', { name: '关闭客户资料', exact: true }).click()
    await page.reload()
    await page.getByRole('button', { name: '客户资料', exact: true }).click()
    await expect(memory).toContainText('暂无长期摘要。')
    await page.getByRole('button', { name: '关闭客户资料', exact: true }).click()
    await expect(page.locator('.message-bubble')).toContainText('I prefer concise explanations.')
    expect(
      await page.request
        .post(`${root}/conversations/${inbound.conversationId}/customer-memory/clear`, { data: {} })
        .then((r) => r.status()),
    ).toBe(400)
  } finally {
    await pool.end()
  }
})
