import {
  bootstrapWorkspace,
  createDatabase,
  member,
  workspace,
  workspaceUserAccess,
  type Database,
} from '@deepsales/db'
import { and, eq, sql } from 'drizzle-orm'
import { Hono, type Context } from 'hono'
import { Pool } from 'pg'
import { z } from 'zod'
import { createAuth } from './auth'
import type { Bindings } from './bindings'

type WebhookPayload = {
  object?: unknown
  entry?: Array<{
    id?: unknown
    messaging?: Array<{
      sender?: { id?: unknown }
      message?: { mid?: unknown; text?: unknown; is_echo?: unknown }
    }>
  }>
}

type InboundText = { pageId: string; senderId: string; messageId: string }

const recentMessageIds = new Set<string>()

const app = new Hono<{ Bindings: Bindings }>()

const workspaceInput = z.object({ name: z.string().trim().min(1).max(100) })

app.onError((_error, c) => {
  if (c.req.path.startsWith('/api/')) {
    console.error(JSON.stringify({ event: 'api_request_failed', path: c.req.path }))
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Request failed' } }, 500)
  }
  return c.text('Internal Server Error', 500)
})

app.get('/health', (c) => c.json({ ok: true }))

app.get('/ready', async (c) => {
  if (!hasApplicationBindings(c.env)) return notReady(c)

  try {
    await withDatabase(c.env, (db) => db.execute(sql`select 1`))
    return c.json({ ok: true })
  } catch {
    return notReady(c)
  }
})

app.use('/api/auth/*', async (c, next) => {
  const credentialAttempt =
    c.req.method === 'POST' &&
    (c.req.path.endsWith('/sign-in/email') || c.req.path.endsWith('/sign-up/email'))
  if (!credentialAttempt) return next()
  if (!hasAuthBindings(c.env)) return notReady(c)

  const body = (await c.req.raw
    .clone()
    .json()
    .catch(() => ({}))) as { email?: unknown }
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : 'invalid'
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(email))
  const key = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  )
  const { success } = await c.env.AUTH_RATE_LIMITER.limit({ key: `${c.req.path}:${key}` })
  if (!success) {
    return c.json({ error: { code: 'RATE_LIMITED', message: 'Try again later' } }, 429)
  }
  return next()
})

app.all('/api/auth/*', async (c) => {
  if (!hasAuthBindings(c.env)) return notReady(c)
  const response = await withDatabase(c.env, (db) => createAuth(db, c.env).handler(c.req.raw))
  return response.ok ? response : normalizeAuthError(response)
})

app.get('/api/me', async (c) => {
  if (!hasAuthBindings(c.env)) return notReady(c)
  return withDatabase(c.env, async (db) => {
    const auth = createAuth(db, c.env)
    const session = await auth.api.getSession({ headers: c.req.raw.headers })
    if (!session) return unauthorized(c)

    const accesses = await findAccesses(db, session.user.id)
    const requestedWorkspaceId = c.req.header('x-workspace-id')
    const access = accesses.find(({ id }) => id === requestedWorkspaceId) ?? accesses.at(0) ?? null
    return c.json({
      user: { id: session.user.id, name: session.user.name, email: session.user.email },
      workspaces: accesses,
      workspace: access,
    })
  })
})

app.post('/api/workspaces', async (c) => {
  if (!hasAuthBindings(c.env)) return notReady(c)
  return withDatabase(c.env, async (db) => {
    const auth = createAuth(db, c.env)
    const session = await auth.api.getSession({ headers: c.req.raw.headers })
    if (!session) return unauthorized(c)

    const input = workspaceInput.safeParse(await c.req.json().catch(() => null))
    if (!input.success) {
      return c.json({ error: { code: 'INVALID_REQUEST', message: 'Enter a workspace name' } }, 400)
    }

    const created = await bootstrapWorkspace(db, {
      userId: session.user.id,
      userName: session.user.name,
      name: input.data.name,
    })
    return c.json({ workspace: created }, 201)
  })
})

app.get('/api/workspaces/:workspaceId', async (c) => {
  if (!hasAuthBindings(c.env)) return notReady(c)
  return withDatabase(c.env, async (db) => {
    const session = await createAuth(db, c.env).api.getSession({ headers: c.req.raw.headers })
    if (!session) return unauthorized(c)

    const [access] = await findAccesses(db, session.user.id, c.req.param('workspaceId'))
    return access
      ? c.json({ workspace: access })
      : c.json({ error: { code: 'FORBIDDEN', message: 'Workspace access required' } }, 403)
  })
})

function hasApplicationBindings(env: Bindings): boolean {
  return Boolean(
    hasAuthBindings(env) &&
      env.META_APP_SECRET &&
      env.META_VERIFY_TOKEN &&
      env.META_PAGE_ID &&
      env.META_PAGE_ACCESS_TOKEN &&
      env.META_GRAPH_API_VERSION &&
      env.M0_FIXED_REPLY,
  )
}

function hasAuthBindings(env: Bindings): boolean {
  return Boolean(
    env.APP_URL &&
      env.AUTH_RATE_LIMITER &&
      env.BETTER_AUTH_SECRET &&
      env.HYPERDRIVE?.connectionString,
  )
}

async function withDatabase<T>(env: Bindings, work: (db: Database) => T | Promise<T>): Promise<T> {
  const pool = new Pool({ connectionString: env.HYPERDRIVE.connectionString, max: 1 })
  try {
    return await work(createDatabase(pool))
  } finally {
    await pool.end()
  }
}

async function findAccesses(db: Database, userId: string, workspaceId?: string) {
  return db
    .select({
      id: workspace.id,
      name: workspace.name,
      role: workspaceUserAccess.role,
      memberId: member.id,
    })
    .from(workspaceUserAccess)
    .innerJoin(workspace, eq(workspace.id, workspaceUserAccess.workspaceId))
    .innerJoin(member, eq(member.workspaceUserAccessId, workspaceUserAccess.id))
    .where(
      workspaceId
        ? and(eq(workspaceUserAccess.userId, userId), eq(workspace.id, workspaceId))
        : eq(workspaceUserAccess.userId, userId),
    )
    .orderBy(workspace.createdAt, workspace.id)
}

function unauthorized(c: Context<{ Bindings: Bindings }>) {
  return c.json({ error: { code: 'UNAUTHORIZED', message: 'Sign in required' } }, 401)
}

function notReady(c: Context<{ Bindings: Bindings }>) {
  return c.json(
    { ok: false, error: { code: 'NOT_READY', message: 'Database is unavailable' } },
    503,
  )
}

async function normalizeAuthError(response: Response): Promise<Response> {
  const payload = (await response
    .clone()
    .json()
    .catch(() => ({}))) as {
    code?: unknown
    message?: unknown
  }
  const code = typeof payload.code === 'string' ? payload.code : 'AUTH_FAILED'
  const message = typeof payload.message === 'string' ? payload.message : 'Authentication failed'
  const headers = new Headers(response.headers)
  headers.set('Content-Type', 'application/json; charset=UTF-8')
  return new Response(JSON.stringify({ error: { code, message } }), {
    status: response.status,
    headers,
  })
}

app.get('/webhooks/facebook', (c) => {
  const verified =
    Boolean(c.env.META_VERIFY_TOKEN) &&
    c.req.query('hub.mode') === 'subscribe' &&
    c.req.query('hub.verify_token') === c.env.META_VERIFY_TOKEN

  return verified ? c.text(c.req.query('hub.challenge') ?? '') : c.text('Forbidden', 403)
})

app.post('/webhooks/facebook', async (c) => {
  const body = await c.req.arrayBuffer()
  if (
    !(await hasValidSignature(body, c.req.header('x-hub-signature-256'), c.env.META_APP_SECRET))
  ) {
    console.warn(JSON.stringify({ event: 'webhook_rejected', reason: 'invalid_signature' }))
    return c.text('Unauthorized', 401)
  }

  let payload: WebhookPayload
  try {
    payload = JSON.parse(new TextDecoder().decode(body)) as WebhookPayload
  } catch {
    return c.text('Bad Request', 400)
  }

  const messages = inboundTexts(payload, c.env.META_PAGE_ID)
  console.log(JSON.stringify({ event: 'webhook_received', messages: messages.length }))
  c.executionCtx.waitUntil(
    Promise.all(messages.map((message) => sendFixedReply(message, c.env))).then(() => undefined),
  )

  return c.text('EVENT_RECEIVED')
})

function inboundTexts(payload: WebhookPayload, expectedPageId: string): InboundText[] {
  if (payload.object !== 'page' || !Array.isArray(payload.entry)) return []

  const messages: InboundText[] = []
  for (const entry of payload.entry) {
    if (entry.id !== expectedPageId || !Array.isArray(entry.messaging)) continue
    for (const event of entry.messaging) {
      const { id: senderId } = event.sender ?? {}
      const { mid: messageId, text, is_echo: isEcho } = event.message ?? {}
      if (
        typeof senderId !== 'string' ||
        typeof messageId !== 'string' ||
        typeof text !== 'string' ||
        isEcho === true ||
        !remember(messageId)
      ) {
        continue
      }
      messages.push({ pageId: entry.id, senderId, messageId })
    }
  }
  return messages
}

function remember(messageId: string): boolean {
  if (recentMessageIds.has(messageId)) return false
  // ponytail: isolate-local M0 dedupe only; replace with PostgreSQL uniqueness for V1.
  if (recentMessageIds.size >= 1_000) recentMessageIds.clear()
  recentMessageIds.add(messageId)
  return true
}

async function hasValidSignature(
  body: ArrayBuffer,
  header: string | undefined,
  appSecret: string,
): Promise<boolean> {
  if (!header?.startsWith('sha256=') || !appSecret) return false
  const hex = header.slice(7)
  if (!/^[0-9a-f]{64}$/i.test(hex)) return false

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(appSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  )
  const bytes = hex.match(/.{2}/g)
  if (!bytes) return false
  const signature = Uint8Array.from(bytes, (byte) => Number.parseInt(byte, 16))
  return crypto.subtle.verify('HMAC', key, signature, body)
}

async function sendFixedReply(message: InboundText, env: Bindings): Promise<void> {
  console.log(
    JSON.stringify({
      event: 'send_attempt',
      pageId: message.pageId,
      messageId: message.messageId,
      inboundType: 'text',
    }),
  )

  let response: Response
  try {
    response = await fetch(
      `https://graph.facebook.com/${env.META_GRAPH_API_VERSION}/${env.META_PAGE_ID}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.META_PAGE_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          recipient: { id: message.senderId },
          messaging_type: 'RESPONSE',
          message: { text: env.M0_FIXED_REPLY },
        }),
      },
    )
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'send_failed',
        messageId: message.messageId,
        reason: 'network_error',
        error: error instanceof Error ? error.message : 'unknown',
      }),
    )
    return
  }

  const result = (await response.json().catch(() => ({}))) as {
    message_id?: unknown
    error?: { code?: unknown; error_subcode?: unknown; message?: unknown; type?: unknown }
  }
  if (!response.ok) {
    console.error(
      JSON.stringify({
        event: 'send_failed',
        messageId: message.messageId,
        status: response.status,
        metaCode: result.error?.code,
        metaSubcode: result.error?.error_subcode,
        metaType: result.error?.type,
        metaMessage:
          typeof result.error?.message === 'string' && env.META_PAGE_ACCESS_TOKEN
            ? result.error.message.replaceAll(env.META_PAGE_ACCESS_TOKEN, '[redacted]')
            : result.error?.message,
      }),
    )
    return
  }

  console.log(
    JSON.stringify({
      event: 'send_succeeded',
      messageId: message.messageId,
      outboundMessageId: result.message_id,
    }),
  )
}

export { app, hasValidSignature, inboundTexts }
export default app
