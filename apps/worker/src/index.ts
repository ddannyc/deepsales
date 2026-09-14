import {
  acceptInvitation,
  AssignmentError,
  bootstrapWorkspace,
  claimOutboundMessage,
  completeOutboundMessage,
  createDatabase,
  createAiMember,
  createInvitation,
  createHumanReply,
  disableFacebookChannel,
  FacebookError,
  InboxError,
  ReplyError,
  failOutboundMessage,
  listFacebookChannels,
  listFacebookChannelsPage,
  listConversations,
  listMessages,
  deleteMember,
  listTeam,
  MemberError,
  processFacebookInbound,
  member,
  setMemberChannelAccess,
  takeOverConversation,
  updateMember,
  workspace,
  workspaceUserAccess,
  type Database,
  MAX_OUTBOUND_TEXT_LENGTH,
  type FacebookChannelCursor,
} from '@deepsales/db'
import { and, eq, sql } from 'drizzle-orm'
import { Hono, type Context } from 'hono'
import { Pool } from 'pg'
import { z } from 'zod'
import { createAuth } from './auth'
import type { Bindings } from './bindings'
import {
  FacebookProviderError,
  facebookOutboundJobSchema,
  facebookWebhookJobSchema,
  isFacebookReplyWindowOpen,
  normalizeFacebookWebhook,
  decryptFacebookToken,
  createFacebookAdapter,
  redactedFacebookFailure,
} from './facebook'
import {
  beginFacebookOAuth,
  completeFacebookOAuth,
  facebookServiceConfig,
  listFacebookOAuthPages,
  recheckFacebookPage,
  selectFacebookPages,
} from './facebook-service'

import { publishRealtime, WorkspaceRealtime } from './realtime'

const app = new Hono<{ Bindings: Bindings }>()

const workspaceInput = z.object({ name: z.string().trim().min(1).max(100) })
const invitationInput = z.object({
  email: z
    .string()
    .trim()
    .email()
    .transform((email) => email.toLowerCase()),
  role: z.enum(['ADMIN', 'AGENT']),
  displayName: z.string().trim().min(1).max(100).nullable().optional(),
  available: z.boolean().optional(),
  autoAssignmentEnabled: z.boolean().optional(),
  maxActiveConversations: z.number().int().min(0).max(10_000).optional(),
  channelIds: z.array(z.string().uuid()).max(100).optional(),
})
const aiMemberInput = z.object({
  type: z.literal('AI').optional(),
  displayName: z.string().trim().min(1).max(100),
  avatarUrl: z.string().trim().max(2_000).nullable().optional(),
  autoAssignmentEnabled: z.boolean().optional(),
  maxActiveConversations: z.number().int().min(0).max(10_000).optional(),
  channelIds: z.array(z.string().uuid()).max(100).optional(),
})
const memberUpdateInput = z.object({
  displayName: z.string().trim().min(1).max(100).nullable().optional(),
  avatarUrl: z.string().trim().max(2_000).nullable().optional(),
  status: z.enum(['ACTIVE', 'DISABLED']).optional(),
  autoAssignmentEnabled: z.boolean().optional(),
  maxActiveConversations: z.number().int().min(0).max(10_000).optional(),
  available: z.boolean().optional(),
  role: z.enum(['ADMIN', 'AGENT']).optional(),
  channelIds: z.array(z.string().uuid()).max(100).optional(),
})
const channelAccessInput = z.object({ channelIds: z.array(z.string().uuid()).max(100) })
const invitationAcceptInput = z.object({ token: z.string().min(1).max(200) })
const facebookOAuthCallbackInput = z.object({
  state: z.string().regex(/^[0-9a-f]{64}$/i),
  code: z.string().min(1).max(4_096),
})
const facebookPageSelectionInput = z.object({
  pageIds: z.array(z.string().trim().min(1).max(200)).min(1).max(100),
})
const facebookCursorInput = z.object({ displayName: z.string().max(200), id: z.string().uuid() })
const conversationViewInput = z.enum([
  'my',
  'waiting-human',
  'ai-handling',
  'unassigned',
  'all-open',
])
const conversationCursorInput = z.object({
  updatedAt: z.string().datetime(),
  id: z.string().uuid(),
})
const messageCursorInput = z.object({ createdAt: z.string().datetime(), id: z.string().uuid() })
const replyInput = z
  .object({ text: z.string().trim().min(1).max(MAX_OUTBOUND_TEXT_LENGTH) })
  .strict()

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

app.get('/api/workspaces/:workspaceId/channels', async (c) => {
  if (!hasAuthBindings(c.env)) return notReady(c)
  return withDatabase(c.env, async (db) => {
    const session = await createAuth(db, c.env).api.getSession({ headers: c.req.raw.headers })
    if (!session) return unauthorized(c)
    try {
      const page = await listFacebookChannelsPage(db, c.req.param('workspaceId'), session.user.id, {
        after: decodeFacebookCursor(c.req.query('cursor')),
      })
      return c.json({
        channels: page.channels,
        nextCursor: page.nextCursor ? encodeFacebookCursor(page.nextCursor) : null,
      })
    } catch (error) {
      return facebookErrorResponse(c, error)
    }
  })
})

app.post('/api/workspaces/:workspaceId/facebook/oauth/start', async (c) => {
  if (!hasFacebookBindings(c.env)) return notReady(c)
  return withDatabase(c.env, async (db) => {
    const session = await createAuth(db, c.env).api.getSession({ headers: c.req.raw.headers })
    if (!session) return unauthorized(c)
    const limited = await rateLimit(c, `facebook-oauth-start:${session.user.id}`)
    if (limited) return limited
    c.header('Cache-Control', 'no-store')
    try {
      return c.json(
        await beginFacebookOAuth(db, facebookServiceConfig(c.env), {
          workspaceId: c.req.param('workspaceId'),
          userId: session.user.id,
        }),
      )
    } catch (error) {
      return facebookErrorResponse(c, error)
    }
  })
})

app.get('/api/facebook/oauth/callback', async (c) => {
  if (!hasFacebookBindings(c.env)) return notReady(c)
  const callback = facebookOAuthCallbackInput.safeParse({
    state: c.req.query('state'),
    code: c.req.query('code'),
  })
  if (!callback.success) {
    return c.json(
      {
        error: {
          code: 'FACEBOOK_OAUTH_STATE_INVALID',
          message: 'Facebook authorization is invalid',
        },
      },
      400,
    )
  }
  const { state, code } = callback.data

  return withDatabase(c.env, async (db) => {
    const session = await createAuth(db, c.env).api.getSession({ headers: c.req.raw.headers })
    if (!session) return unauthorized(c)
    const limited = await rateLimit(c, `facebook-oauth-callback:${session.user.id}`)
    if (limited) return limited
    c.header('Cache-Control', 'no-store')

    try {
      const result = await completeFacebookOAuth(db, facebookServiceConfig(c.env), {
        state,
        code,
        userId: session.user.id,
      })
      return c.req.header('accept')?.includes('text/html')
        ? c.redirect(`/settings/facebook?oauthStateId=${result.stateId}`, 303)
        : c.json(result)
    } catch (error) {
      return error instanceof FacebookError
        ? facebookErrorResponse(c, error)
        : facebookProviderResponse(c, error, 'FACEBOOK_PROVIDER_ERROR')
    }
  })
})

app.get('/api/workspaces/:workspaceId/facebook/oauth/:stateId/pages', async (c) => {
  if (!hasFacebookBindings(c.env)) return notReady(c)
  return withDatabase(c.env, async (db) => {
    const session = await createAuth(db, c.env).api.getSession({ headers: c.req.raw.headers })
    if (!session) return unauthorized(c)
    const limited = await rateLimit(c, `facebook-oauth-pages:${session.user.id}`)
    if (limited) return limited
    c.header('Cache-Control', 'no-store')
    try {
      return c.json({
        pages: await listFacebookOAuthPages(db, facebookServiceConfig(c.env), {
          stateId: c.req.param('stateId'),
          workspaceId: c.req.param('workspaceId'),
          userId: session.user.id,
        }),
      })
    } catch (error) {
      return error instanceof FacebookProviderError
        ? facebookProviderResponse(c, error, 'FACEBOOK_PROVIDER_ERROR')
        : facebookErrorResponse(c, error)
    }
  })
})

app.post('/api/workspaces/:workspaceId/facebook/oauth/:stateId/pages', async (c) => {
  if (!hasFacebookBindings(c.env)) return notReady(c)
  return withDatabase(c.env, async (db) => {
    const session = await createAuth(db, c.env).api.getSession({ headers: c.req.raw.headers })
    if (!session) return unauthorized(c)
    const limited = await rateLimit(c, `facebook-oauth-pages:${session.user.id}`)
    if (limited) return limited
    const input = facebookPageSelectionInput.safeParse(await c.req.json().catch(() => null))
    if (!input.success) {
      return c.json(
        { error: { code: 'INVALID_REQUEST', message: 'Select at least one Page' } },
        400,
      )
    }

    try {
      await selectFacebookPages(db, facebookServiceConfig(c.env), {
        stateId: c.req.param('stateId'),
        workspaceId: c.req.param('workspaceId'),
        userId: session.user.id,
        pageIds: input.data.pageIds,
      })
      return c.json({
        channels: await listFacebookChannels(db, c.req.param('workspaceId'), session.user.id),
      })
    } catch (error) {
      return error instanceof FacebookProviderError
        ? facebookProviderResponse(c, error, 'FACEBOOK_SUBSCRIPTION_FAILED')
        : facebookErrorResponse(c, error)
    }
  })
})

app.post('/api/workspaces/:workspaceId/channels/:channelId/recheck', async (c) => {
  if (!hasFacebookBindings(c.env)) return notReady(c)
  return withDatabase(c.env, async (db) => {
    const session = await createAuth(db, c.env).api.getSession({ headers: c.req.raw.headers })
    if (!session) return unauthorized(c)
    const limited = await rateLimit(c, `facebook-recheck:${session.user.id}`)
    if (limited) return limited
    try {
      await recheckFacebookPage(db, facebookServiceConfig(c.env), {
        workspaceId: c.req.param('workspaceId'),
        channelId: c.req.param('channelId'),
        userId: session.user.id,
      })
    } catch (error) {
      return facebookErrorResponse(c, error)
    }
    return c.json({
      channel: (await listFacebookChannels(db, c.req.param('workspaceId'), session.user.id)).find(
        ({ id }) => id === c.req.param('channelId'),
      ),
    })
  })
})

app.post('/api/workspaces/:workspaceId/channels/:channelId/disable', async (c) => {
  if (!hasAuthBindings(c.env)) return notReady(c)
  return withDatabase(c.env, async (db) => {
    const session = await createAuth(db, c.env).api.getSession({ headers: c.req.raw.headers })
    if (!session) return unauthorized(c)
    const limited = await rateLimit(c, `facebook-disable:${session.user.id}`)
    if (limited) return limited
    try {
      await disableFacebookChannel(db, {
        workspaceId: c.req.param('workspaceId'),
        channelId: c.req.param('channelId'),
        userId: session.user.id,
      })
      return c.json({
        channel: (await listFacebookChannels(db, c.req.param('workspaceId'), session.user.id)).find(
          ({ id }) => id === c.req.param('channelId'),
        ),
      })
    } catch (error) {
      return facebookErrorResponse(c, error)
    }
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

app.get('/api/workspaces/:workspaceId/team', async (c) => {
  if (!hasAuthBindings(c.env)) return notReady(c)
  return withDatabase(c.env, async (db) => {
    const session = await createAuth(db, c.env).api.getSession({ headers: c.req.raw.headers })
    if (!session) return unauthorized(c)
    if (!(await findWorkspaceAccess(db, session.user.id, c.req.param('workspaceId')))) {
      return forbidden(c)
    }
    return c.json(await listTeam(db, c.req.param('workspaceId')))
  })
})

app.get('/api/workspaces/:workspaceId/conversations', async (c) => {
  if (!hasAuthBindings(c.env)) return notReady(c)
  return withDatabase(c.env, async (db) => {
    const session = await createAuth(db, c.env).api.getSession({ headers: c.req.raw.headers })
    if (!session) return unauthorized(c)

    try {
      const viewResult = conversationViewInput.safeParse(c.req.query('view') ?? 'all-open')
      if (!viewResult.success) throw new InboxError('INVALID_REQUEST', 'Invalid conversation view')
      const page = await listConversations(db, {
        workspaceId: c.req.param('workspaceId'),
        userId: session.user.id,
        view: viewResult.data,
        after: decodeConversationCursor(c.req.query('cursor')),
      })
      return c.json({
        conversations: page.conversations,
        nextCursor: page.nextCursor
          ? encodeCursor({
              updatedAt: page.nextCursor.updatedAt.toISOString(),
              id: page.nextCursor.id,
            })
          : null,
      })
    } catch (error) {
      return inboxErrorResponse(c, error)
    }
  })
})

app.get('/api/workspaces/:workspaceId/conversations/:conversationId', async (c) => {
  if (!hasAuthBindings(c.env)) return notReady(c)
  return withDatabase(c.env, async (db) => {
    const session = await createAuth(db, c.env).api.getSession({ headers: c.req.raw.headers })
    if (!session) return unauthorized(c)

    try {
      const page = await listConversations(db, {
        workspaceId: c.req.param('workspaceId'),
        userId: session.user.id,
        view: 'all-open',
        conversationId: c.req.param('conversationId'),
      })
      const conversation = page.conversations[0]
      if (!conversation) throw new InboxError('NOT_FOUND', 'Conversation not found')
      return c.json({ conversation })
    } catch (error) {
      return inboxErrorResponse(c, error)
    }
  })
})

app.get('/api/workspaces/:workspaceId/conversations/:conversationId/messages', async (c) => {
  if (!hasAuthBindings(c.env)) return notReady(c)
  return withDatabase(c.env, async (db) => {
    const session = await createAuth(db, c.env).api.getSession({ headers: c.req.raw.headers })
    if (!session) return unauthorized(c)

    try {
      const page = await listMessages(db, {
        workspaceId: c.req.param('workspaceId'),
        userId: session.user.id,
        conversationId: c.req.param('conversationId'),
        after: decodeMessageCursor(c.req.query('cursor')),
      })
      return c.json({
        messages: page.messages,
        nextCursor: page.nextCursor
          ? encodeCursor({
              createdAt: page.nextCursor.createdAt.toISOString(),
              id: page.nextCursor.id,
            })
          : null,
      })
    } catch (error) {
      return inboxErrorResponse(c, error)
    }
  })
})

app.post('/api/workspaces/:workspaceId/conversations/:conversationId/takeover', async (c) => {
  if (!hasAuthBindings(c.env)) return notReady(c)
  return withDatabase(c.env, async (db) => {
    const session = await createAuth(db, c.env).api.getSession({ headers: c.req.raw.headers })
    if (!session) return unauthorized(c)

    try {
      const result = await takeOverConversation(db, {
        workspaceId: c.req.param('workspaceId'),
        conversationId: c.req.param('conversationId'),
        actingUserId: session.user.id,
      })
      await publishInboxChange(
        c.env,
        c.req.param('workspaceId'),
        result.conversationId,
        'conversation.changed',
      )
      const page = await listConversations(db, {
        workspaceId: c.req.param('workspaceId'),
        userId: session.user.id,
        view: 'all-open',
        conversationId: result.conversationId,
      })
      return c.json({ conversation: page.conversations[0], changed: result.changed })
    } catch (error) {
      return assignmentErrorResponse(c, error)
    }
  })
})

app.post('/api/workspaces/:workspaceId/conversations/:conversationId/replies', async (c) => {
  if (!hasAuthBindings(c.env)) return notReady(c)
  return withDatabase(c.env, async (db) => {
    const session = await createAuth(db, c.env).api.getSession({ headers: c.req.raw.headers })
    if (!session) return unauthorized(c)
    const limited = await rateLimit(c, `outbound-reply:${session.user.id}`)
    if (limited) return limited

    const input = replyInput.safeParse(await c.req.json().catch(() => null))
    if (!input.success) {
      return c.json({ error: { code: 'INVALID_REQUEST', message: 'Enter a text reply' } }, 400)
    }

    try {
      const created = await createHumanReply(
        db,
        {
          workspaceId: c.req.param('workspaceId'),
          conversationId: c.req.param('conversationId'),
          actingUserId: session.user.id,
          text: input.data.text,
        },
        isFacebookReplyWindowOpen,
      )
      const job = {
        v: 1 as const,
        type: 'facebook.outbound' as const,
        messageId: created.message.id,
      }
      try {
        await c.env.OUTBOUND_QUEUE?.send(job)
      } catch {
        console.warn(
          JSON.stringify({ event: 'outbound_queue_failed', messageId: created.message.id }),
        )
      }
      await publishInboxChange(
        c.env,
        c.req.param('workspaceId'),
        created.message.id,
        'message.changed',
      )
      return c.json({ message: created.message }, 201)
    } catch (error) {
      return replyErrorResponse(c, error)
    }
  })
})

app.get('/api/workspaces/:workspaceId/realtime', async (c) => {
  if (!hasAuthBindings(c.env)) return notReady(c)
  if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') {
    return c.text('WebSocket upgrade required', 426)
  }
  const realtime = c.env.WORKSPACE_REALTIME
  if (!realtime) return notReady(c)

  return withDatabase(c.env, async (db) => {
    const session = await createAuth(db, c.env).api.getSession({ headers: c.req.raw.headers })
    if (!session) return unauthorized(c)
    if (!(await findWorkspaceAccess(db, session.user.id, c.req.param('workspaceId')))) {
      return forbidden(c)
    }

    const request = new Request('https://realtime/connect', {
      headers: {
        Upgrade: 'websocket',
        'x-user-id': session.user.id,
        'x-workspace-id': c.req.param('workspaceId'),
      },
    })
    return realtime.get(realtime.idFromName(c.req.param('workspaceId'))).fetch(request)
  })
})

app.post('/api/workspaces/:workspaceId/invitations', async (c) => {
  if (!hasAuthBindings(c.env)) return notReady(c)
  return withDatabase(c.env, async (db) => {
    const session = await createAuth(db, c.env).api.getSession({ headers: c.req.raw.headers })
    if (!session) return unauthorized(c)

    const input = invitationInput.safeParse(await c.req.json().catch(() => null))
    if (!input.success) {
      return c.json(
        { error: { code: 'INVALID_REQUEST', message: 'Enter a valid invitation' } },
        400,
      )
    }

    try {
      const invitation = await createInvitation(db, {
        workspaceId: c.req.param('workspaceId'),
        createdByUserId: session.user.id,
        ...input.data,
      })
      return c.json(
        {
          invitation: {
            id: invitation.id,
            workspaceId: invitation.workspaceId,
            email: invitation.email,
            role: invitation.role,
            displayName: invitation.displayName,
            expiresAt: invitation.expiresAt,
            token: invitation.token,
            url: invitationUrl(c.env.APP_URL, invitation.token),
          },
        },
        201,
      )
    } catch (error) {
      return memberErrorResponse(c, error)
    }
  })
})

app.post('/api/invitations/accept', async (c) => {
  if (!hasAuthBindings(c.env)) return notReady(c)
  return withDatabase(c.env, async (db) => {
    const session = await createAuth(db, c.env).api.getSession({ headers: c.req.raw.headers })
    if (!session) return unauthorized(c)

    const input = invitationAcceptInput.safeParse(await c.req.json().catch(() => null))
    if (!input.success) {
      return c.json(
        { error: { code: 'INVITATION_INVALID', message: 'Invitation is invalid' } },
        400,
      )
    }

    try {
      const accepted = await acceptInvitation(db, {
        token: input.data.token,
        userId: session.user.id,
        userEmail: session.user.email,
        userName: session.user.name,
      })
      const [access] = await findAccesses(db, session.user.id, accepted.workspaceId)
      return c.json({ workspace: access, memberId: accepted.memberId })
    } catch (error) {
      return memberErrorResponse(c, error)
    }
  })
})

app.post('/api/workspaces/:workspaceId/members', async (c) => {
  if (!hasAuthBindings(c.env)) return notReady(c)
  return withDatabase(c.env, async (db) => {
    const session = await createAuth(db, c.env).api.getSession({ headers: c.req.raw.headers })
    if (!session) return unauthorized(c)
    const input = aiMemberInput.safeParse(await c.req.json().catch(() => null))
    if (!input.success) {
      return c.json({ error: { code: 'INVALID_REQUEST', message: 'Enter a valid AI member' } }, 400)
    }

    try {
      const created = await createAiMember(db, {
        workspaceId: c.req.param('workspaceId'),
        createdByUserId: session.user.id,
        ...input.data,
      })
      const team = await listTeam(db, c.req.param('workspaceId'))
      return c.json({ member: team.members.find(({ id }) => id === created.id) }, 201)
    } catch (error) {
      return memberErrorResponse(c, error)
    }
  })
})

app.patch('/api/workspaces/:workspaceId/members/:memberId', async (c) => {
  if (!hasAuthBindings(c.env)) return notReady(c)
  return withDatabase(c.env, async (db) => {
    const session = await createAuth(db, c.env).api.getSession({ headers: c.req.raw.headers })
    if (!session) return unauthorized(c)
    const input = memberUpdateInput.safeParse(await c.req.json().catch(() => null))
    if (!input.success) {
      return c.json(
        { error: { code: 'INVALID_REQUEST', message: 'Enter valid member settings' } },
        400,
      )
    }

    try {
      await updateMember(db, {
        workspaceId: c.req.param('workspaceId'),
        memberId: c.req.param('memberId'),
        actingUserId: session.user.id,
        ...input.data,
      })
      const team = await listTeam(db, c.req.param('workspaceId'))
      return c.json({ member: team.members.find(({ id }) => id === c.req.param('memberId')) })
    } catch (error) {
      return memberErrorResponse(c, error)
    }
  })
})

app.put('/api/workspaces/:workspaceId/members/:memberId/channels', async (c) => {
  if (!hasAuthBindings(c.env)) return notReady(c)
  return withDatabase(c.env, async (db) => {
    const session = await createAuth(db, c.env).api.getSession({ headers: c.req.raw.headers })
    if (!session) return unauthorized(c)
    const input = channelAccessInput.safeParse(await c.req.json().catch(() => null))
    if (!input.success) {
      return c.json(
        { error: { code: 'INVALID_REQUEST', message: 'Enter valid channel access' } },
        400,
      )
    }

    try {
      const access = await setMemberChannelAccess(db, {
        workspaceId: c.req.param('workspaceId'),
        memberId: c.req.param('memberId'),
        actingUserId: session.user.id,
        channelIds: input.data.channelIds,
      })
      return c.json({ access })
    } catch (error) {
      return memberErrorResponse(c, error)
    }
  })
})

app.delete('/api/workspaces/:workspaceId/members/:memberId', async (c) => {
  if (!hasAuthBindings(c.env)) return notReady(c)
  return withDatabase(c.env, async (db) => {
    const session = await createAuth(db, c.env).api.getSession({ headers: c.req.raw.headers })
    if (!session) return unauthorized(c)
    try {
      await deleteMember(db, {
        workspaceId: c.req.param('workspaceId'),
        memberId: c.req.param('memberId'),
        actingUserId: session.user.id,
      })
      return c.body(null, 204)
    } catch (error) {
      return memberErrorResponse(c, error)
    }
  })
})

function hasApplicationBindings(env: Bindings): boolean {
  return Boolean(
    hasAuthBindings(env) &&
      env.META_APP_ID &&
      env.META_APP_SECRET &&
      env.META_VERIFY_TOKEN &&
      env.META_GRAPH_API_VERSION &&
      env.TOKEN_ENCRYPTION_KEY &&
      env.WEBHOOKS_QUEUE &&
      env.OUTBOUND_QUEUE &&
      env.WORKSPACE_REALTIME,
  )
}

function hasFacebookBindings(env: Bindings): boolean {
  return Boolean(
    hasAuthBindings(env) &&
      env.APP_URL &&
      env.META_APP_ID &&
      env.META_APP_SECRET &&
      env.META_GRAPH_API_VERSION &&
      env.TOKEN_ENCRYPTION_KEY,
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

async function findWorkspaceAccess(db: Database, userId: string, workspaceId: string) {
  const [access] = await db
    .select({ id: workspaceUserAccess.id, role: workspaceUserAccess.role })
    .from(workspaceUserAccess)
    .where(
      and(eq(workspaceUserAccess.userId, userId), eq(workspaceUserAccess.workspaceId, workspaceId)),
    )
    .limit(1)
  return access ?? null
}

function unauthorized(c: Context<{ Bindings: Bindings }>) {
  return c.json({ error: { code: 'UNAUTHORIZED', message: 'Sign in required' } }, 401)
}

async function rateLimit(c: Context<{ Bindings: Bindings }>, key: string) {
  const { success } = await c.env.AUTH_RATE_LIMITER.limit({ key })
  return success
    ? null
    : c.json({ error: { code: 'RATE_LIMITED', message: 'Try again later' } }, 429)
}

function forbidden(c: Context<{ Bindings: Bindings }>) {
  return c.json({ error: { code: 'FORBIDDEN', message: 'Workspace access required' } }, 403)
}

function invitationUrl(appUrl: string, token: string) {
  return `${appUrl.replace(/\/$/, '')}/invite?token=${encodeURIComponent(token)}`
}

function encodeFacebookCursor(cursor: FacebookChannelCursor) {
  const bytes = new TextEncoder().encode(JSON.stringify(cursor))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function encodeCursor(cursor: object) {
  const bytes = new TextEncoder().encode(JSON.stringify(cursor))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function decodeFacebookCursor(value: string | undefined): FacebookChannelCursor | undefined {
  if (!value) return undefined
  try {
    const normalized = value.replaceAll('-', '+').replaceAll('_', '/')
    const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='))
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
    const cursor = facebookCursorInput.safeParse(JSON.parse(new TextDecoder().decode(bytes)))
    if (!cursor.success) throw new Error('invalid cursor')
    return cursor.data
  } catch {
    throw new FacebookError('INVALID_REQUEST', 'Invalid channel cursor')
  }
}

function decodeConversationCursor(value: string | undefined) {
  if (!value) return undefined
  try {
    const cursor = conversationCursorInput.safeParse(JSON.parse(decodeCursorValue(value)))
    if (!cursor.success) throw new Error('invalid cursor')
    return { updatedAt: new Date(cursor.data.updatedAt), id: cursor.data.id }
  } catch {
    throw new InboxError('INVALID_REQUEST', 'Invalid conversation cursor')
  }
}

function decodeMessageCursor(value: string | undefined) {
  if (!value) return undefined
  try {
    const cursor = messageCursorInput.safeParse(JSON.parse(decodeCursorValue(value)))
    if (!cursor.success) throw new Error('invalid cursor')
    return { createdAt: new Date(cursor.data.createdAt), id: cursor.data.id }
  } catch {
    throw new InboxError('INVALID_REQUEST', 'Invalid message cursor')
  }
}

function decodeCursorValue(value: string) {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/')
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='))
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

function memberErrorResponse(c: Context<{ Bindings: Bindings }>, error: unknown) {
  if (!(error instanceof MemberError)) throw error
  const status =
    error.code === 'FORBIDDEN' || error.code === 'INVITATION_EMAIL_MISMATCH'
      ? 403
      : error.code === 'NOT_FOUND'
        ? 404
        : error.code === 'ALREADY_MEMBER' || error.code === 'INVITATION_USED'
          ? 409
          : 400
  return c.json({ error: { code: error.code, message: error.message } }, status)
}

function facebookErrorResponse(c: Context<{ Bindings: Bindings }>, error: unknown) {
  if (!(error instanceof FacebookError)) throw error
  const status =
    error.code === 'FORBIDDEN' || error.code === 'FACEBOOK_OAUTH_STATE_MISMATCH'
      ? 403
      : error.code === 'NOT_FOUND'
        ? 404
        : error.code === 'FACEBOOK_PAGE_ALREADY_CONNECTED'
          ? 409
          : 400
  return c.json({ error: { code: error.code, message: error.message } }, status)
}

function facebookProviderResponse(
  c: Context<{ Bindings: Bindings }>,
  error: unknown,
  code: 'FACEBOOK_PROVIDER_ERROR' | 'FACEBOOK_SUBSCRIPTION_FAILED',
) {
  if (error instanceof FacebookProviderError) {
    return c.json({ error: { code, message: 'Facebook connection requires attention' } }, 502)
  }
  if (error instanceof Error && error.message === 'Unsupported token key version') {
    return c.json(
      { error: { code: 'FACEBOOK_PROVIDER_ERROR', message: 'Facebook connection failed' } },
      502,
    )
  }
  throw error
}

function inboxErrorResponse(c: Context<{ Bindings: Bindings }>, error: unknown) {
  if (!(error instanceof InboxError)) throw error
  const status = error.code === 'FORBIDDEN' ? 403 : error.code === 'NOT_FOUND' ? 404 : 400
  return c.json({ error: { code: error.code, message: error.message } }, status)
}

function assignmentErrorResponse(c: Context<{ Bindings: Bindings }>, error: unknown) {
  if (!(error instanceof AssignmentError)) throw error
  const status =
    error.code === 'FORBIDDEN'
      ? 403
      : error.code === 'NOT_FOUND'
        ? 404
        : error.code === 'ALREADY_ASSIGNED' || error.code === 'CONVERSATION_CLOSED'
          ? 409
          : 400
  return c.json({ error: { code: error.code, message: error.message } }, status)
}

function replyErrorResponse(c: Context<{ Bindings: Bindings }>, error: unknown) {
  if (!(error instanceof ReplyError)) throw error
  const status =
    error.code === 'FORBIDDEN'
      ? 403
      : error.code === 'NOT_FOUND'
        ? 404
        : error.code === 'REPLY_WINDOW_CLOSED' || error.code === 'CONVERSATION_CLOSED'
          ? 409
          : 400
  return c.json({ error: { code: error.code, message: error.message } }, status)
}

async function publishInboxChange(
  env: Bindings,
  workspaceId: string,
  entityId: string,
  type: 'conversation.changed' | 'message.changed',
) {
  try {
    await publishRealtime(env.WORKSPACE_REALTIME, workspaceId, { type, entityId })
  } catch {
    console.warn(JSON.stringify({ event: 'realtime_publish_failed', type }))
  }
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
  const challenge = c.req.query('hub.challenge')
  const verified =
    Boolean(c.env.META_VERIFY_TOKEN) &&
    c.req.query('hub.mode') === 'subscribe' &&
    c.req.query('hub.verify_token') === c.env.META_VERIFY_TOKEN &&
    Boolean(challenge)

  return verified && challenge ? c.text(challenge) : c.text('Forbidden', 403)
})

app.post('/webhooks/facebook', async (c) => {
  const body = await c.req.arrayBuffer()
  if (
    !(await hasValidSignature(body, c.req.header('x-hub-signature-256'), c.env.META_APP_SECRET))
  ) {
    console.warn(JSON.stringify({ event: 'webhook_rejected', reason: 'invalid_signature' }))
    return c.text('Unauthorized', 401)
  }

  let payload: unknown
  try {
    payload = JSON.parse(new TextDecoder().decode(body)) as unknown
  } catch {
    return c.text('Bad Request', 400)
  }

  const events = normalizeFacebookWebhook(payload)
  if (!events.length) return c.text('EVENT_RECEIVED')

  const queue = c.env.WEBHOOKS_QUEUE
  if (!queue) {
    return c.json(
      { error: { code: 'QUEUE_UNAVAILABLE', message: 'Webhook queue is unavailable' } },
      503,
    )
  }

  const receivedAt = new Date()
  const payloadSha256 = await sha256Hex(body)
  const jobs = events.map((event) =>
    facebookWebhookJobSchema.safeParse({
      v: 1,
      type: 'facebook.inbound',
      ingressId: crypto.randomUUID(),
      payloadSha256,
      receivedAt: receivedAt.toISOString(),
      event: {
        ...event,
        providerSentAt: event.providerSentAt?.toISOString() ?? null,
      },
    }),
  )
  if (jobs.some((job) => !job.success)) return c.text('Bad Request', 400)

  try {
    await Promise.all(jobs.map((job) => queue.send(job.data)))
  } catch {
    console.error(JSON.stringify({ event: 'webhook_queue_failed', messages: events.length }))
    return c.json(
      { error: { code: 'QUEUE_UNAVAILABLE', message: 'Webhook queue is unavailable' } },
      503,
    )
  }

  console.log(JSON.stringify({ event: 'webhook_queued', messages: events.length }))

  return c.text('EVENT_RECEIVED')
})

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

async function sha256Hex(body: ArrayBuffer) {
  const digest = await crypto.subtle.digest('SHA-256', body)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function handleWebhookBatch(batch: MessageBatch<unknown>, env: Bindings) {
  for (const message of batch.messages) {
    const job = facebookWebhookJobSchema.safeParse(message.body)
    if (!job.success) {
      message.ack()
      continue
    }

    try {
      const result = await withDatabase(env, (db) =>
        processFacebookInbound(db, {
          ingressId: job.data.ingressId,
          pageId: job.data.event.pageId,
          externalUserId: job.data.event.externalUserId,
          externalMessageId: job.data.event.externalMessageId,
          text: job.data.event.text,
          providerSentAt: job.data.event.providerSentAt
            ? new Date(job.data.event.providerSentAt)
            : null,
          receivedAt: new Date(job.data.receivedAt),
          payloadSha256: job.data.payloadSha256,
          eventFragment: job.data.event.eventFragment,
        }),
      )
      if (result.kind === 'created') {
        try {
          await publishRealtime(env.WORKSPACE_REALTIME, result.workspaceId, {
            type: 'conversation.changed',
            entityId: result.conversationId,
          })
        } catch {
          console.warn(JSON.stringify({ event: 'realtime_publish_failed' }))
        }
      }
      message.ack()
    } catch {
      console.error(JSON.stringify({ event: 'webhook_processing_failed' }))
      message.retry()
    }
  }
}

export async function handleOutboundBatch(batch: MessageBatch<unknown>, env: Bindings) {
  for (const queueMessage of batch.messages) {
    const job = facebookOutboundJobSchema.safeParse(queueMessage.body)
    if (!job.success) {
      queueMessage.ack()
      continue
    }

    let claimed: Awaited<ReturnType<typeof claimOutboundMessage>>
    try {
      claimed = await withDatabase(env, (db) =>
        claimOutboundMessage(db, { messageId: job.data.messageId }),
      )
    } catch {
      queueMessage.retry()
      continue
    }
    if (!claimed) {
      queueMessage.ack()
      continue
    }

    let pageAccessToken = ''
    try {
      if (!isFacebookReplyWindowOpen(claimed.eligibleUntil)) {
        await withDatabase(env, (db) =>
          failOutboundMessage(db, {
            messageId: claimed.id,
            attemptId: claimed.attemptId,
            failureCode: 'REPLY_WINDOW_CLOSED',
            failureMessage: 'Messenger reply window is closed',
            attempt: { message: 'Messenger reply window is closed' },
          }),
        )
        await publishInboxChange(env, claimed.workspaceId, job.data.messageId, 'message.changed')
        queueMessage.ack()
        continue
      }
      if (!claimed.text) throw new Error('Outbound text is missing')

      pageAccessToken = await decryptFacebookToken(
        {
          ciphertext: claimed.encryptedPageAccessToken,
          iv: claimed.tokenIv,
          keyVersion: claimed.tokenKeyVersion,
        },
        env.TOKEN_ENCRYPTION_KEY,
      )
      const sent = await createFacebookAdapter({
        appId: env.META_APP_ID,
        appSecret: env.META_APP_SECRET,
        graphApiVersion: env.META_GRAPH_API_VERSION,
        graphBaseUrl: env.FACEBOOK_GRAPH_BASE_URL,
      }).sendText(claimed.pageId, claimed.externalUserId, claimed.text, pageAccessToken)
      await withDatabase(env, (db) =>
        completeOutboundMessage(db, {
          messageId: claimed.id,
          attemptId: claimed.attemptId,
          externalMessageId: sent.externalMessageId,
        }),
      )
      await publishInboxChange(env, claimed.workspaceId, job.data.messageId, 'message.changed')
      queueMessage.ack()
    } catch (error) {
      const providerFailure = redactedFacebookFailure(error, [
        pageAccessToken,
        env.META_APP_SECRET,
        env.TOKEN_ENCRYPTION_KEY,
      ])
      const ambiguous = error instanceof FacebookProviderError && error.status === 0
      try {
        await withDatabase(env, (db) =>
          failOutboundMessage(db, {
            messageId: claimed.id,
            attemptId: claimed.attemptId,
            failureCode: ambiguous ? 'AMBIGUOUS_DELIVERY' : 'FACEBOOK_DELIVERY_FAILED',
            failureMessage: ambiguous
              ? 'Delivery result was ambiguous'
              : 'Facebook delivery failed',
            attempt: {
              httpStatus:
                error instanceof FacebookProviderError && error.status > 0 ? error.status : null,
              code: error instanceof FacebookProviderError ? error.providerCode : null,
              subcode: error instanceof FacebookProviderError ? error.providerSubcode : null,
              type: error instanceof FacebookProviderError ? error.providerType : null,
              message: providerFailure.message,
            },
          }),
        )
        await publishInboxChange(env, claimed.workspaceId, job.data.messageId, 'message.changed')
        queueMessage.ack()
      } catch {
        queueMessage.retry()
      }
    }
  }
}

export { app, hasValidSignature, WorkspaceRealtime }

const worker = {
  fetch: (request: Request, env: Bindings, executionContext: ExecutionContext) =>
    app.fetch(request, env, executionContext),
  queue: (batch: MessageBatch<unknown>, env: Bindings) =>
    batch.queue === 'deepsales-outbound'
      ? handleOutboundBatch(batch, env)
      : handleWebhookBatch(batch, env),
}

export default worker
