import { randomUUID } from 'node:crypto'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import {
  bootstrapWorkspace,
  channel,
  connectFacebookPages,
  createDatabase,
  disableFacebookChannel,
  facebookChannelConfig,
  findActiveFacebookPage,
  startFacebookOAuth,
  consumeFacebookOAuthState,
  user,
} from '../src'

const connectionString = process.env.DATABASE_URL

describe.skipIf(!connectionString)('Facebook channel persistence', () => {
  const pool = new Pool({ connectionString })
  const db = createDatabase(pool)

  beforeAll(async () => {
    await migrate(db, { migrationsFolder: 'drizzle' })
  })

  afterAll(() => pool.end())

  it('allows one workspace to own a Page under concurrent connection attempts', async () => {
    const firstUserId = randomUUID()
    const secondUserId = randomUUID()
    await db.insert(user).values([
      { id: firstUserId, name: 'First owner', email: `${firstUserId}@example.com` },
      { id: secondUserId, name: 'Second owner', email: `${secondUserId}@example.com` },
    ])
    const [firstWorkspace, secondWorkspace] = await Promise.all([
      bootstrapWorkspace(db, { userId: firstUserId, userName: 'First owner', name: 'First' }),
      bootstrapWorkspace(db, { userId: secondUserId, userName: 'Second owner', name: 'Second' }),
    ])

    const results = await Promise.allSettled([
      connectFacebookPages(db, {
        workspaceId: firstWorkspace.id,
        actingUserId: firstUserId,
        pages: [page('Shared Page')],
      }),
      connectFacebookPages(db, {
        workspaceId: secondWorkspace.id,
        actingUserId: secondUserId,
        pages: [page('Shared Page')],
      }),
    ])

    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(({ status }) => status === 'rejected')).toHaveLength(1)
    const configs = await db
      .select({ pageId: facebookChannelConfig.pageId, workspaceId: channel.workspaceId })
      .from(facebookChannelConfig)
      .innerJoin(channel, eq(channel.id, facebookChannelConfig.channelId))
      .where(eq(facebookChannelConfig.pageId, 'page-shared'))
    expect(configs).toHaveLength(1)
  })

  it('reconnects a Page in place and consumes OAuth state once', async () => {
    const ownerId = randomUUID()
    await db.insert(user).values({ id: ownerId, name: 'Owner', email: `${ownerId}@example.com` })
    const workspace = await bootstrapWorkspace(db, {
      userId: ownerId,
      userName: 'Owner',
      name: 'Reconnect',
    })
    const first = await connectFacebookPages(db, {
      workspaceId: workspace.id,
      actingUserId: ownerId,
      pages: [page('Before')],
    })
    await expect(findActiveFacebookPage(db, 'page-shared')).resolves.toEqual(
      expect.objectContaining({ channelId: first[0]?.id }),
    )
    await disableFacebookChannel(db, {
      workspaceId: workspace.id,
      channelId: first[0]?.id ?? '',
      userId: ownerId,
    })
    await expect(findActiveFacebookPage(db, 'page-shared')).resolves.toBeNull()
    const second = await connectFacebookPages(db, {
      workspaceId: workspace.id,
      actingUserId: ownerId,
      pages: [{ ...page('After'), encryptedPageAccessToken: 'cipher-2' }],
    })
    expect(second[0]?.id).toBe(first[0]?.id)
    expect(
      await db.select().from(channel).where(eq(channel.workspaceId, workspace.id)),
    ).toHaveLength(1)

    const state = await startFacebookOAuth(db, {
      workspaceId: workspace.id,
      initiatedByUserId: ownerId,
    })
    await expect(
      consumeFacebookOAuthState(db, { state: state.state, userId: ownerId }),
    ).resolves.toEqual(expect.objectContaining({ id: state.id, workspaceId: workspace.id }))
    await expect(
      consumeFacebookOAuthState(db, { state: state.state, userId: ownerId }),
    ).rejects.toMatchObject({
      code: 'FACEBOOK_OAUTH_STATE_USED',
    })
  })
})

function page(displayName: string) {
  return {
    pageId: 'page-shared',
    displayName,
    encryptedPageAccessToken: 'cipher-1',
    tokenIv: 'iv-1',
    tokenKeyVersion: 'v1',
  }
}
