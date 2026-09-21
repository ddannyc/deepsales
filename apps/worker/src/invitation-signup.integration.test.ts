import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  bootstrapWorkspace,
  createDatabase,
  createInvitation,
  createRegistrationInvitation,
  hashInvitationToken,
  member,
  registrationInvitation,
  user,
  workspaceInvitation,
  workspaceUserAccess,
} from '@deepsales/db'
import { and, eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createAuth } from './auth'
import type { Bindings } from './bindings'
import { app } from './index'

const connectionString = process.env.DATABASE_URL
const migrationsFolder = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../packages/db/drizzle',
)
const password = 'correct-horse-battery-staple'

describe.skipIf(!connectionString)('invitation-only signup', () => {
  const pool = new Pool({ connectionString })
  const db = createDatabase(pool)

  beforeAll(async () => {
    await migrate(db, { migrationsFolder })
  })

  afterAll(() => pool.end())

  it('rejects public signup without an invitation', async () => {
    const email = `${crypto.randomUUID()}@example.com`
    const response = await app.request(
      '/api/auth/sign-up/email',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Public User', email, password }),
      },
      environment(),
    )

    expect(response.status).toBe(403)
    expect(await errorCode(response)).toBe('INVITATION_REQUIRED')
    expect(await db.select().from(user).where(eq(user.email, email))).toHaveLength(0)
  })

  it('creates the user and workspace member, then consumes the invitation once', async () => {
    const ownerId = crypto.randomUUID()
    const email = `${crypto.randomUUID()}@example.com`
    await db.insert(user).values({ id: ownerId, name: 'Owner', email: `${ownerId}@example.com` })
    const workspace = await bootstrapWorkspace(db, {
      userId: ownerId,
      userName: 'Owner',
      name: 'Invitation signup',
    })
    const invitation = await createInvitation(db, {
      workspaceId: workspace.id,
      createdByUserId: ownerId,
      email,
      role: 'AGENT',
    })

    const created = await signup(email, invitation.token)

    expect(created.status).toBe(200)
    const [createdUser] = await db.select().from(user).where(eq(user.email, email))
    expect(createdUser).toEqual(expect.objectContaining({ email }))
    const accesses = await db
      .select()
      .from(workspaceUserAccess)
      .where(
        and(
          eq(workspaceUserAccess.workspaceId, workspace.id),
          eq(workspaceUserAccess.userId, createdUser.id),
        ),
      )
    expect(accesses).toHaveLength(1)
    expect(
      await db
        .select()
        .from(member)
        .where(eq(member.workspaceUserAccessId, accesses[0]?.id ?? '')),
    ).toHaveLength(1)
    const [storedInvitation] = await db
      .select()
      .from(workspaceInvitation)
      .where(eq(workspaceInvitation.id, invitation.id))
    expect(storedInvitation?.acceptedAt).not.toBeNull()
    expect(storedInvitation?.tokenHash).toBe(await hashInvitationToken(invitation.token))

    const repeated = await signup(email, invitation.token)
    expect(repeated.status).toBe(409)
    expect(await repeated.json()).toEqual({
      error: { code: 'INVITATION_USED', message: 'Invitation was used' },
    })
    expect(await db.select().from(user).where(eq(user.email, email))).toHaveLength(1)
  })

  it('rejects invalid and expired invitations before creating a user', async () => {
    const invalid = await signup(`${crypto.randomUUID()}@example.com`, 'not-a-real-token')
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toEqual({
      error: { code: 'INVITATION_INVALID', message: 'Invitation is invalid' },
    })

    const ownerId = crypto.randomUUID()
    const email = `${crypto.randomUUID()}@example.com`
    await db.insert(user).values({ id: ownerId, name: 'Owner', email: `${ownerId}@example.com` })
    const workspace = await bootstrapWorkspace(db, {
      userId: ownerId,
      userName: 'Owner',
      name: 'Expired invitation',
    })
    const invitation = await createInvitation(db, {
      workspaceId: workspace.id,
      createdByUserId: ownerId,
      email,
      role: 'AGENT',
    })
    await db
      .update(workspaceInvitation)
      .set({ expiresAt: new Date(0) })
      .where(eq(workspaceInvitation.id, invitation.id))

    const expired = await signup(email, invitation.token)
    expect(expired.status).toBe(400)
    expect(await expired.json()).toEqual({
      error: { code: 'INVITATION_EXPIRED', message: 'Invitation expired' },
    })
    expect(await db.select().from(user).where(eq(user.email, email))).toHaveLength(0)
  })

  it('rejects revoked invitations before creating a user', async () => {
    const ownerId = crypto.randomUUID()
    const email = `${crypto.randomUUID()}@example.com`
    await db.insert(user).values({ id: ownerId, name: 'Owner', email: `${ownerId}@example.com` })
    const workspace = await bootstrapWorkspace(db, {
      userId: ownerId,
      userName: 'Owner',
      name: 'Revoked invitation',
    })
    const invitation = await createInvitation(db, {
      workspaceId: workspace.id,
      createdByUserId: ownerId,
      email,
      role: 'AGENT',
    })
    await db
      .update(workspaceInvitation)
      .set({ revokedAt: new Date() })
      .where(eq(workspaceInvitation.id, invitation.id))

    const revoked = await signup(email, invitation.token)
    expect(revoked.status).toBe(400)
    expect(await revoked.json()).toEqual({
      error: { code: 'INVITATION_INVALID', message: 'Invitation is invalid' },
    })
    expect(await db.select().from(user).where(eq(user.email, email))).toHaveLength(0)
  })

  it('serializes concurrent signup attempts for one invitation', async () => {
    const ownerId = crypto.randomUUID()
    const email = `${crypto.randomUUID()}@example.com`
    await db.insert(user).values({ id: ownerId, name: 'Owner', email: `${ownerId}@example.com` })
    const workspace = await bootstrapWorkspace(db, {
      userId: ownerId,
      userName: 'Owner',
      name: 'Concurrent invitation signup',
    })
    const invitation = await createInvitation(db, {
      workspaceId: workspace.id,
      createdByUserId: ownerId,
      email,
      role: 'AGENT',
    })

    const results = await Promise.all([
      signup(email, invitation.token),
      signup(email, invitation.token),
    ])

    expect(results.map((result) => result.status).sort()).toEqual([200, 409])
    expect(await db.select().from(user).where(eq(user.email, email))).toHaveLength(1)
    const [createdUser] = await db.select().from(user).where(eq(user.email, email))
    expect(
      await db
        .select()
        .from(workspaceUserAccess)
        .where(
          and(
            eq(workspaceUserAccess.workspaceId, workspace.id),
            eq(workspaceUserAccess.userId, createdUser.id),
          ),
        ),
    ).toHaveLength(1)
  })

  it('lets a creator invite register without membership and create one owner workspace', async () => {
    const email = `${crypto.randomUUID()}@example.com`
    const invitation = await createRegistrationInvitation(db, { email })
    const created = await signup(email, invitation.token)

    expect(created.status).toBe(200)
    const [createdUser] = await db.select().from(user).where(eq(user.email, email))
    if (!createdUser) throw new Error('Creator user was not created')
    expect(
      await db
        .select()
        .from(workspaceUserAccess)
        .where(eq(workspaceUserAccess.userId, createdUser.id)),
    ).toHaveLength(0)
    const [acceptedInvite] = await db
      .select()
      .from(registrationInvitation)
      .where(eq(registrationInvitation.id, invitation.id))
    expect(acceptedInvite?.acceptedByUserId).toBe(createdUser.id)
    expect(acceptedInvite?.workspaceCreatedAt).toBeNull()

    const cookie = await signIn(email)
    const first = await createWorkspace(cookie, 'Creator workspace')
    expect(first.status).toBe(201)
    const access = await db
      .select()
      .from(workspaceUserAccess)
      .where(eq(workspaceUserAccess.userId, createdUser.id))
    expect(access).toHaveLength(1)
    expect(access[0]?.role).toBe('OWNER')
    expect(
      await db
        .select()
        .from(member)
        .where(eq(member.workspaceUserAccessId, access[0]?.id ?? '')),
    ).toHaveLength(1)

    const second = await createWorkspace(cookie, 'Second workspace')
    expect(second.status).toBe(409)
    expect(await errorCode(second)).toBe('WORKSPACE_ALREADY_EXISTS')
    const [consumedInvite] = await db
      .select()
      .from(registrationInvitation)
      .where(eq(registrationInvitation.id, invitation.id))
    expect(consumedInvite?.workspaceCreatedAt).not.toBeNull()
    expect(
      await db
        .select()
        .from(workspaceUserAccess)
        .where(eq(workspaceUserAccess.userId, createdUser.id)),
    ).toHaveLength(1)
  })

  it('requires creator entitlement when calling workspace creation directly', async () => {
    const email = `${crypto.randomUUID()}@example.com`
    await createAuth(db, environment()).api.signUpEmail({
      body: { name: 'Uninvited User', email, password },
    })
    const cookie = await signIn(email)

    const response = await createWorkspace(cookie, 'Unauthorized workspace')
    expect(response.status).toBe(403)
    expect(await errorCode(response)).toBe('WORKSPACE_SETUP_REQUIRED')
    expect(
      await db
        .select()
        .from(workspaceUserAccess)
        .innerJoin(user, eq(user.id, workspaceUserAccess.userId))
        .where(eq(user.email, email)),
    ).toHaveLength(0)
  })

  it('lets an existing workspace-free account accept a creator invite and continue setup', async () => {
    const email = `${crypto.randomUUID()}@example.com`
    await createAuth(db, environment()).api.signUpEmail({
      body: { name: 'Existing User', email, password },
    })
    const invitation = await createRegistrationInvitation(db, { email })
    const cookie = await signIn(email)

    const details = await app.request(
      `/api/invitations/${invitation.token}`,
      undefined,
      environment(),
    )
    const detailsBody = (await details.json()) as { invitation: { type: string } }
    expect(detailsBody.invitation.type).toBe('WORKSPACE_CREATOR')

    const accepted = await acceptInvite(cookie, invitation.token)
    expect(accepted.status).toBe(200)
    expect(await accepted.json()).toEqual({ type: 'WORKSPACE_CREATOR' })
    expect(
      await db
        .select()
        .from(workspaceUserAccess)
        .innerJoin(user, eq(user.id, workspaceUserAccess.userId))
        .where(eq(user.email, email)),
    ).toHaveLength(0)
    expect((await createWorkspace(cookie, 'Existing creator workspace')).status).toBe(201)
  })

  it('does not accept a creator invite for an existing workspace member', async () => {
    const email = `${crypto.randomUUID()}@example.com`
    await createAuth(db, environment()).api.signUpEmail({
      body: { name: 'Existing Workspace User', email, password },
    })
    const [existingUser] = await db.select().from(user).where(eq(user.email, email))
    if (!existingUser) throw new Error('Existing user was not created')
    await bootstrapWorkspace(db, {
      userId: existingUser.id,
      userName: existingUser.name,
      name: 'Existing workspace',
    })
    const invitation = await createRegistrationInvitation(db, { email })
    const cookie = await signIn(email)

    const response = await acceptInvite(cookie, invitation.token)
    expect(response.status).toBe(409)
    expect(await errorCode(response)).toBe('WORKSPACE_ALREADY_EXISTS')
  })

  it('rejects expired and wrong-email creator invitations before creating an account', async () => {
    const ownerEmail = `${crypto.randomUUID()}@example.com`
    const expiredEmail = `${crypto.randomUUID()}@example.com`
    const expired = await createRegistrationInvitation(db, { email: expiredEmail })
    await db
      .update(registrationInvitation)
      .set({ expiresAt: new Date(0) })
      .where(eq(registrationInvitation.id, expired.id))

    const expiredResponse = await signup(expiredEmail, expired.token)
    expect(expiredResponse.status).toBe(400)
    expect(await errorCode(expiredResponse)).toBe('INVITATION_EXPIRED')
    expect(await db.select().from(user).where(eq(user.email, expiredEmail))).toHaveLength(0)

    const invitation = await createRegistrationInvitation(db, { email: ownerEmail })
    const wrongEmail = `${crypto.randomUUID()}@example.com`
    const wrongEmailResponse = await signup(wrongEmail, invitation.token)
    expect(wrongEmailResponse.status).toBe(403)
    expect(await errorCode(wrongEmailResponse)).toBe('INVITATION_EMAIL_MISMATCH')
    expect(await db.select().from(user).where(eq(user.email, wrongEmail))).toHaveLength(0)
  })
})

async function signup(email: string, invitationToken: string) {
  return app.request(
    '/api/auth/sign-up/email',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Invited User', email, password, invitationToken }),
    },
    environment(),
  )
}

async function signIn(email: string) {
  const response = await app.request(
    '/api/auth/sign-in/email',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    },
    environment(),
  )
  if (!response.ok) throw new Error('Test user could not sign in')
  const cookie = response.headers.get('set-cookie')?.split(';', 1)[0]
  if (!cookie) throw new Error('Test sign-in did not set a cookie')
  return cookie
}

async function createWorkspace(cookie: string, name: string) {
  return app.request(
    '/api/workspaces',
    {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    },
    environment(),
  )
}

async function acceptInvite(cookie: string, token: string) {
  return app.request(
    '/api/invitations/accept',
    {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    },
    environment(),
  )
}

async function errorCode(response: Response) {
  return ((await response.json()) as { error: { code: string } }).error.code
}

function environment() {
  return {
    APP_URL: 'http://localhost:8787',
    AUTH_RATE_LIMITER: {
      limit: vi.fn().mockResolvedValue({ success: true }),
    },
    BETTER_AUTH_SECRET: 'test-only-secret-that-is-at-least-32-characters',
    HYPERDRIVE: { connectionString },
  } as unknown as Bindings
}
