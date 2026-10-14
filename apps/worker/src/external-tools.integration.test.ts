import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  bootstrapWorkspace,
  channel,
  createAiMember,
  createDatabase,
  member,
  setMemberChannelAccess,
  workspaceUserAccess,
} from '@deepsales/db'
import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Pool } from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createAuth } from './auth'
import type { Bindings } from './bindings'
import { app } from './index'

const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const db = createDatabase(pool)
const origin = 'https://tools.example.com'
const env = {
  APP_URL: 'http://localhost:8787',
  AUTH_RATE_LIMITER: { limit: async () => ({ success: true }) },
  BETTER_AUTH_SECRET: 'test-only-secret-that-is-at-least-32-characters',
  HYPERDRIVE: { connectionString: process.env.DATABASE_URL },
  TOKEN_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  AI_TOOL_ALLOWED_ORIGINS: JSON.stringify([origin]),
} as unknown as Bindings

describe.skipIf(!process.env.DATABASE_URL)('External API tool configuration', () => {
  beforeAll(() =>
    migrate(db, {
      migrationsFolder: resolve(
        dirname(fileURLToPath(import.meta.url)),
        '../../../packages/db/drizzle',
      ),
    }),
  )
  afterAll(() => pool.end())
  afterEach(() => vi.unstubAllGlobals())
  it('saves immediate scoped plugins and returns credential configuration state only', async () => {
    const f = await fixture()
    const id = crypto.randomUUID()
    const saved = await f.call('plugins', 'POST', {
      id,
      name: 'Support API',
      channelId: f.channelId,
      origin,
      enabled: true,
      auth: 'BEARER',
      credential: 'fixture-private-credential',
    })
    expect(saved.status).toBe(201)
    expect(await saved.json()).toMatchObject({ id, revision: 1, configured: true })
    const listed = await f.call('plugins')
    const body = await listed.text()
    expect(body).toContain('Support API')
    expect(body).not.toMatch(
      /fixture-private-credential|ciphertext|credentialIv|encryptedCredential|keyVersion/,
    )
    const tool = await f.call('external-tools', 'POST', {
      id: crypto.randomUUID(),
      pluginId: id,
      name: 'Read status',
      description: 'Read configured support status.',
      enabled: true,
      method: 'GET',
      path: '/status',
      effect: 'READ',
      inputs: [],
      fixed: [],
      output: [{ name: 'status', path: ['status'], type: 'string' }],
      objectScope: '',
    })
    expect(tool.status).toBe(201)
    const definition = (await tool.json()) as { id: string }
    const debug = await f.call(`external-tools/${definition.id}/debug`, 'POST', {
      id: crypto.randomUUID(),
      values: {},
    })
    expect(debug.status).toBe(200)
    expect(await debug.json()).toMatchObject({ simulated: true, state: 'SUCCEEDED' })
  })
  it('hides revoked plugin scopes and rejects mutable or missing declared write targets without production requests', async () => {
    const f = await fixture()
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    const id = crypto.randomUUID()
    expect(
      (
        await f.call('plugins', 'POST', {
          id,
          name: 'Write API',
          channelId: f.channelId,
          origin,
          enabled: true,
          auth: 'BEARER',
          credential: 'fixture-credential',
        })
      ).status,
    ).toBe(201)
    const tool = {
      id: crypto.randomUUID(),
      pluginId: id,
      name: 'Record note',
      description: 'Write only to the configured record.',
      enabled: true,
      method: 'POST',
      path: '/record',
      effect: 'WRITE',
      inputs: [{ name: 'note', location: 'body', type: 'string', required: true }],
      fixed: [{ name: 'recordId', location: 'body', value: 'configured-record' }],
      output: [{ name: 'status', path: ['status'], type: 'string' }],
      objectScope: JSON.stringify({
        policy: 'FIXED_CONFIG',
        targets: [{ name: 'recordId', location: 'body' }],
        description: 'Administrator-approved record on this channel.',
      }),
    }
    expect((await f.call('external-tools', 'POST', { ...tool, fixed: [] })).status).toBe(400)
    expect((await f.call('external-tools', 'POST', { ...tool, objectScope: '' })).status).toBe(400)
    expect((await f.call('external-tools', 'POST', tool)).status).toBe(201)
    const debugId = crypto.randomUUID()
    expect(
      (
        await f.call(`external-tools/${tool.id}/debug`, 'POST', {
          id: debugId,
          values: { note: 'hello', recordId: 'other-record' },
        })
      ).status,
    ).toBe(400)
    const first = await (
      await f.call(`external-tools/${tool.id}/debug`, 'POST', {
        id: debugId,
        values: { note: 'hello' },
      })
    ).json()
    expect(
      await (
        await f.call(`external-tools/${tool.id}/debug`, 'POST', {
          id: debugId,
          values: { note: 'hello' },
        })
      ).json(),
    ).toEqual(first)
    expect(fetcher).not.toHaveBeenCalled()
    await db
      .update(workspaceUserAccess)
      .set({ role: 'ADMIN' })
      .where(eq(workspaceUserAccess.workspaceId, f.workspaceId))
    await setMemberChannelAccess(db, {
      workspaceId: f.workspaceId,
      memberId: f.humanId,
      actingUserId: f.userId,
      channelIds: [],
    })
    expect(await (await f.call('plugins')).json()).toMatchObject({ plugins: [], tools: [] })
    expect(
      (
        await f.call(`external-tools/${tool.id}/debug`, 'POST', {
          id: crypto.randomUUID(),
          values: { note: 'hello' },
        })
      ).status,
    ).toBe(404)
    expect(
      (
        await f.call('plugins', 'POST', {
          id,
          revision: 1,
          name: 'Attempt edit',
          channelId: f.channelId,
          origin,
          enabled: true,
          auth: 'NONE',
        })
      ).status,
    ).toBe(403)
    expect(fetcher).not.toHaveBeenCalled()
  })
})

async function fixture() {
  const email = `${crypto.randomUUID()}@example.com`,
    password = 'correct-horse-battery-staple'
  const created = await createAuth(db, env).api.signUpEmail({
    body: { email, password, name: 'Tool manager' },
  })
  const signed = await app.request(
    '/api/auth/sign-in/email',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    },
    env,
  )
  const cookie = signed.headers.get('set-cookie')?.split(';', 1)[0]
  if (!cookie) throw new Error('No session')
  const workspace = await bootstrapWorkspace(db, {
    userId: created.user.id,
    userName: 'Manager',
    name: 'External tool workspace',
  })
  const [support] = await db
    .insert(channel)
    .values({ workspaceId: workspace.id, provider: 'FACEBOOK_MESSENGER', displayName: 'Support' })
    .returning()
  const ai = await createAiMember(db, {
    workspaceId: workspace.id,
    createdByUserId: created.user.id,
    displayName: 'Support AI',
    channelIds: [support.id],
  })
  const [access] = await db
    .select()
    .from(workspaceUserAccess)
    .where(eq(workspaceUserAccess.workspaceId, workspace.id))
  const [human] = await db.select().from(member).where(eq(member.workspaceUserAccessId, access.id))
  await setMemberChannelAccess(db, {
    workspaceId: workspace.id,
    actingUserId: created.user.id,
    memberId: human.id,
    channelIds: [support.id],
  })
  return {
    workspaceId: workspace.id,
    humanId: human.id,
    memberId: ai.id,
    userId: created.user.id,
    channelId: support.id,
    call: (path: string, method = 'GET', body?: unknown) =>
      app.request(
        `/api/workspaces/${workspace.id}/ai-operations/${ai.id}/${path}`,
        {
          method,
          headers: { Cookie: cookie, Origin: env.APP_URL, 'Content-Type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
        env,
      ),
  }
}
