import {
  connectFacebookPages,
  conversationInternalNote,
  createAiMember,
  createDatabase,
  createKnowledgeBase,
  member,
  processFacebookInbound,
  publishAiMemberConfig,
  setMemberChannelAccess,
  updateAiMemberConfig,
  user,
  workspaceUserAccess,
} from '@deepsales/db'
import { expect, test } from '@playwright/test'
import { eq } from 'drizzle-orm'
import { Pool } from 'pg'
import { e2eOwnerEmail, signIn, signInAndCreateWorkspace } from './auth'

test.skip(!process.env.E2E_BASE_URL, 'Set E2E_BASE_URL to a running test deployment')

test('keeps notes internal, retries safely, isolates mute and explicitly restores AI hosting', async ({
  page,
  browser,
}) => {
  await signInAndCreateWorkspace(page, 'inbox-collaboration', 'Collaboration acceptance')
  const me = (await (await page.request.get('/api/me')).json()) as {
    user: { id: string }
    workspace: { id: string; memberId: string }
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  const db = createDatabase(pool)
  const context = await browser.newContext()
  const agentPage = await context.newPage()
  const pageId = crypto.randomUUID()
  const externalUserId = crypto.randomUUID()
  try {
    const [support] = await connectFacebookPages(db, {
      workspaceId: me.workspace.id,
      actingUserId: me.user.id,
      pages: [
        {
          pageId,
          displayName: 'Support',
          encryptedPageAccessToken: 'test-cipher',
          tokenIv: 'test-iv',
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
    const [agentUser] = await db
      .select()
      .from(user)
      .where(eq(user.email, e2eOwnerEmail('inbox-collaboration-agent')))
    const [access] = await db
      .insert(workspaceUserAccess)
      .values({ workspaceId: me.workspace.id, userId: agentUser.id, role: 'AGENT' })
      .returning()
    const [agent] = await db
      .insert(member)
      .values({
        workspaceId: me.workspace.id,
        workspaceUserAccessId: access.id,
        type: 'HUMAN',
        displayName: 'Collaboration agent',
      })
      .returning()
    await setMemberChannelAccess(db, {
      workspaceId: me.workspace.id,
      actingUserId: me.user.id,
      memberId: agent.id,
      channelIds: [support.id],
    })
    const ai = await createAiMember(db, {
      workspaceId: me.workspace.id,
      createdByUserId: me.user.id,
      displayName: 'Support AI',
      channelIds: [support.id],
      autoAssignmentEnabled: false,
    })
    const knowledge = await createKnowledgeBase(db, {
      workspaceId: me.workspace.id,
      createdByUserId: me.user.id,
      name: 'Support facts',
    })
    await updateAiMemberConfig(db, {
      workspaceId: me.workspace.id,
      memberId: ai.id,
      actingUserId: me.user.id,
      instructions: 'Answer using support facts.',
      responseLanguage: 'English',
      knowledgeBaseId: knowledge.id,
    })
    await publishAiMemberConfig(db, {
      workspaceId: me.workspace.id,
      memberId: ai.id,
      actingUserId: me.user.id,
      providerConfigured: true,
    })
    const inbound = async (text: string) =>
      processFacebookInbound(db, {
        ingressId: crypto.randomUUID(),
        pageId,
        externalUserId,
        externalMessageId: crypto.randomUUID(),
        text,
        providerSentAt: new Date(),
        receivedAt: new Date(),
        payloadSha256: 'a'.repeat(64),
        eventFragment: {},
      })
    const received = await inbound('Collaboration greeting')
    if (received.kind !== 'created') throw new Error('No conversation')
    const base = `/api/workspaces/${me.workspace.id}/conversations/${received.conversationId}`
    await page.reload()
    await page.getByText('Collaboration greeting', { exact: true }).first().click()
    await page.getByRole('button', { name: '接管', exact: true }).click()
    await page.getByRole('button', { name: '内部备注', exact: true }).click()
    const draft = page.getByLabel('内部备注草稿')
    await draft.fill('Team coordination only')
    let loseResponse = true
    await page.route(`**${base}/notes`, async (route) => {
      if (route.request().method() === 'POST' && loseResponse) {
        loseResponse = false
        const response = await route.fetch()
        expect(response.status()).toBe(201)
        await route.fulfill({ status: 503, body: '{}' })
      } else await route.continue()
    })
    await page.getByRole('button', { name: '保存内部备注', exact: true }).click()
    await expect(page.getByText('备注未确认保存，草稿已保留；请重试。')).toBeVisible()
    await page.getByRole('button', { name: '刷新备注', exact: true }).click()
    await expect(page.getByText('备注未确认保存，草稿已保留；请重试。')).toBeVisible()
    await expect(draft).toHaveValue('Team coordination only')
    await page.getByRole('button', { name: '保存内部备注', exact: true }).click()
    await expect(draft).toHaveValue('')
    await expect(page.getByLabel('内部备注列表').getByText('Team coordination only')).toHaveCount(1)
    const notes = await (await page.request.get(`${base}/notes`)).json()
    expect(notes.notes).toHaveLength(1)
    const sent = await page.request.get(
      `${process.env.E2E_FAKE_FACEBOOK_URL}/__sent?recipient=${externalUserId}`,
    )
    expect(await sent.json()).toEqual({ count: 0 })
    expect(
      (await (await page.request.get(`${base}/messages`)).json()).messages.map(
        (m: { text: string }) => m.text,
      ),
    ).toEqual(['Collaboration greeting'])
    await db.insert(conversationInternalNote).values(
      Array.from({ length: 51 }, (_, i) => ({
        conversationId: received.conversationId,
        authorMemberId: me.workspace.memberId,
        authorName: 'Ada Lovelace',
        clientKey: crypto.randomUUID(),
        text: `Earlier page coverage ${i}`,
        createdAt: new Date(Date.now() + 1000 + i),
      })),
    )
    await page.getByRole('button', { name: '刷新备注', exact: true }).click()
    await page.getByRole('button', { name: '加载更早备注', exact: true }).click()
    await expect(page.getByLabel('内部备注列表').getByText('Team coordination only')).toHaveCount(1)
    await page.getByRole('button', { name: '关闭备注', exact: true }).click()
    await expect(page.getByRole('button', { name: '内部备注', exact: true })).toBeFocused()
    await page.getByRole('button', { name: '个人免打扰', exact: true }).click()
    await expect(page.getByRole('button', { name: '取消个人免打扰' })).toBeVisible()
    await page.reload()
    await expect(page.getByRole('button', { name: '取消个人免打扰' })).toBeVisible()
    await expect(page.getByText(/当前未提供声音或系统通知/)).toBeVisible()
    await signIn(agentPage, 'inbox-collaboration-agent')
    await expect(agentPage.getByRole('heading', { name: '全部进行中', exact: true })).toBeVisible()
    const otherList = await (
      await agentPage.request.get(`/api/workspaces/${me.workspace.id}/conversations?mute=unmuted`)
    ).json()
    expect(otherList.conversations).toMatchObject([{ id: received.conversationId, muted: false }])
    await inbound('Message after mute')
    await page.reload()
    await expect(page.getByText('Message after mute', { exact: true }).last()).toBeVisible()
    const detail = await (await page.request.get(base)).json()
    expect(detail.conversation.assigneeMemberId).toBe(me.workspace.memberId)
    await page.getByRole('combobox', { name: '个人免打扰筛选' }).click()
    await page.getByRole('option', { name: '排除免打扰' }).click()
    await expect(page.getByText('Message after mute', { exact: true })).toHaveCount(0)
    await page.getByRole('combobox', { name: '个人免打扰筛选' }).click()
    await page.getByRole('option', { name: '仅免打扰' }).click()
    await page.getByText('Message after mute', { exact: true }).first().click()
    await page.getByRole('button', { name: '更多对话操作', exact: true }).click()
    await page.getByRole('menuitem', { name: '交给 AI 托管', exact: true }).click()
    await page.getByLabel('选择转接成员').selectOption(ai.id)
    await page.getByRole('button', { name: '确认转接', exact: true }).click()
    const confirmation = page.getByRole('alertdialog')
    await expect(confirmation.getByText('交给此 AI 托管？')).toBeVisible()
    await confirmation.getByRole('button', { name: '取消', exact: true }).click()
    expect((await (await page.request.get(base)).json()).conversation.assigneeMemberId).toBe(
      me.workspace.memberId,
    )
    await page.getByRole('button', { name: '确认转接', exact: true }).click()
    const transferred = page.waitForResponse(
      (r) => r.url().endsWith('/transfer') && r.request().method() === 'POST',
    )
    await confirmation.getByRole('button', { name: '确认 AI 托管', exact: true }).click()
    expect((await transferred).status()).toBe(200)
    expect((await (await page.request.get(base)).json()).conversation.assigneeMemberId).toBe(ai.id)
    await page.getByRole('button', { name: '接管', exact: true }).click()
    await expect
      .poll(async () => (await (await page.request.get(base)).json()).conversation.assigneeMemberId)
      .toBe(me.workspace.memberId)
  } finally {
    await context.close()
    await pool.end()
  }
})
