import {
  channelIdentity,
  connectFacebookPages,
  conversation,
  createDatabase,
  customer,
  member,
  message,
  processFacebookInbound,
  setMemberChannelAccess,
} from '@deepsales/db'
import { expect, test } from '@playwright/test'
import { and, eq } from 'drizzle-orm'
import { Pool } from 'pg'
import { encryptFacebookToken } from '../apps/worker/src/facebook'
import { signInAndCreateWorkspace } from './auth'

test.skip(!process.env.E2E_BASE_URL, 'Set E2E_BASE_URL to a running test deployment')

test('edits an explicit campaign audience and ordered content, confirms execution and manages a scheduled repeat', async ({
  page,
}) => {
  test.setTimeout(60_000)
  await signInAndCreateWorkspace(page, 'campaigns', 'Campaign acceptance')
  const me = await page.request.get('/api/me').then((r) => r.json())
  const root = `/api/workspaces/${me.workspace.id}`
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  const db = createDatabase(pool)
  try {
    const encrypted = await encryptFacebookToken(
      'neutral-page-token',
      'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    )
    const pageId = crypto.randomUUID()
    const [support] = await connectFacebookPages(db, {
      workspaceId: me.workspace.id,
      actingUserId: me.user.id,
      pages: [
        {
          pageId,
          displayName: 'Campaign support',
          encryptedPageAccessToken: encrypted.ciphertext,
          tokenIv: encrypted.iv,
          tokenKeyVersion: encrypted.keyVersion,
        },
      ],
    })
    const [owner] = await db
      .select()
      .from(member)
      .where(and(eq(member.workspaceId, me.workspace.id), eq(member.type, 'HUMAN')))
    if (!support || !owner) throw new Error('Missing channel or owner')
    await setMemberChannelAccess(db, {
      workspaceId: me.workspace.id,
      memberId: owner.id,
      actingUserId: me.user.id,
      channelIds: [support.id],
    })
    const received = await processFacebookInbound(db, {
      ingressId: crypto.randomUUID(),
      pageId,
      externalUserId: crypto.randomUUID(),
      externalMessageId: crypto.randomUUID(),
      text: 'Hello',
      providerSentAt: new Date(),
      receivedAt: new Date(),
      payloadSha256: 'a'.repeat(64),
      eventFragment: {},
    })
    if (received.kind !== 'created') throw new Error('Missing inbound')
    const [thread] = await db
      .select()
      .from(conversation)
      .where(eq(conversation.id, received.conversationId))
    const [identity] = await db
      .select()
      .from(channelIdentity)
      .where(eq(channelIdentity.id, thread.channelIdentityId))
    await db
      .update(customer)
      .set({ displayName: 'Neutral reader' })
      .where(eq(customer.id, identity.customerId))
    await page.goto('/campaigns')
    await expect(page.getByRole('heading', { name: '群发计划', exact: true })).toBeVisible()
    await page.getByLabel('计划名称', { exact: true }).fill('Library notice')
    await page.getByRole('combobox', { name: '发送渠道', exact: true }).click()
    await page.getByRole('option', { name: 'Campaign support', exact: true }).click()
    await page.getByRole('button', { name: '预览受众', exact: true }).click()
    await page.getByRole('checkbox', { name: /Neutral reader/ }).check()
    await page.getByLabel('第 1 块文字', { exact: true }).fill('Initial block')
    await page.getByRole('button', { name: '添加内容块', exact: true }).click()
    await page.getByLabel('第 2 块文字', { exact: true }).fill('The library closes at five.')
    await page.getByRole('button', { name: '上移', exact: true }).nth(1).click()
    await expect(page.getByLabel('第 1 块文字', { exact: true })).toHaveValue(
      'The library closes at five.',
    )
    await page.getByRole('button', { name: '删除内容块', exact: true }).nth(1).click()
    const saving = page.waitForResponse(
      (r) => r.url().endsWith('/campaigns') && r.request().method() === 'POST',
    )
    await page.getByRole('button', { name: '保存草稿', exact: true }).click()
    const plan = (await (await saving).json()).campaign
    expect(plan.identityIds).toEqual([identity.id])
    expect(plan.content).toMatchObject([{ text: 'The library closes at five.' }])
    await expect(page.getByRole('status')).toContainText('草稿已保存')
    expect(
      (await db.select().from(message).where(eq(message.conversationId, thread.id))).filter(
        (m) => m.direction === 'OUTBOUND',
      ),
    ).toHaveLength(0)
    await page.getByRole('button', { name: '执行计划', exact: true }).click()
    await page.getByRole('button', { name: '保留草稿', exact: true }).click()
    expect(
      (await page.request.get(`${root}/campaigns/${plan.id}`).then((r) => r.json())).campaign
        .status,
    ).toBe('DRAFT')
    await page.getByRole('button', { name: '执行计划', exact: true }).click()
    await page.getByRole('button', { name: '确认执行计划', exact: true }).click()
    await expect
      .poll(
        async () => {
          const result = await page.request
            .get(`${root}/campaigns/${plan.id}`)
            .then((r) => r.json())
          return result.runs[0]?.recipients[0]?.state
        },
        { timeout: 15_000 },
      )
      .toBe('SUCCESS')
    await page.getByRole('button', { name: 'Library notice', exact: true }).click()
    await expect(
      page.getByRole('heading', { name: 'Library notice · 执行结果', exact: true }).locator('..'),
    ).toContainText('发送接口已接受')
    expect(
      (await db.select().from(conversation).where(eq(conversation.id, thread.id)))[0]
        .assigneeMemberId,
    ).toBeNull()
    await page.getByRole('button', { name: '新建另一份草稿', exact: true }).click()
    await page.getByLabel('计划名称', { exact: true }).fill('Scheduled notice')
    await page.getByRole('checkbox', { name: /Neutral reader/ }).check()
    await page.getByLabel('第 1 块文字', { exact: true }).fill('Scheduled neutral notice')
    await page.getByRole('combobox', { name: '执行时间', exact: true }).click()
    await page.getByRole('option', { name: '定时', exact: true }).click()
    await page
      .getByLabel('计划当地时间', { exact: true })
      .fill(new Date(Date.now() + 86_400_000).toISOString().slice(0, 16))
    await page.getByRole('combobox', { name: '重复周期', exact: true }).click()
    await page.getByRole('option', { name: '每天', exact: true }).click()
    await page.getByLabel('最多轮次', { exact: true }).fill('2')
    await page.getByLabel('同渠道发送间隔（秒）', { exact: true }).fill('5')
    await page.getByRole('button', { name: '保存草稿', exact: true }).click()
    await expect(page.getByRole('status')).toContainText('草稿已保存')
    const row = page.getByRole('button', { name: 'Scheduled notice', exact: true }).locator('..')
    await row.getByRole('button', { name: '执行计划', exact: true }).click()
    await page.getByRole('button', { name: '确认执行计划', exact: true }).click()
    await expect(row).toContainText('执行中')
    await row.getByRole('button', { name: '暂停', exact: true }).click()
    await expect(row).toContainText('已暂停')
    await row.getByRole('button', { name: '恢复', exact: true }).click()
    await expect(row).toContainText('执行中')
    await row.getByRole('button', { name: '取消后续发送', exact: true }).click()
    await page.getByRole('button', { name: '确认取消后续发送', exact: true }).click()
    await expect(row).toContainText('已取消')
  } finally {
    await pool.end()
  }
})
