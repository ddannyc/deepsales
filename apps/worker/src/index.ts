import {
  AiMemberError,
  AiResponseError,
  AiUsageError,
  AssignmentError,
  AttachmentError,
  acceptAnyInvitation,
  acknowledgeConversationRead,
  assertInboxViewer,
  assertKnowledgeBaseManager,
  autoAssignConversation,
  CustomerError,
  campaignDeliveryContext,
  changeCustomerIdentity,
  chunkKnowledgeText,
  claimAiResponseRun,
  claimFacebookInboundAttachment,
  claimKnowledgeDocument,
  claimOutboundMessage,
  clearCustomerMemory,
  closeConversation,
  commitAiResponse,
  completeFacebookInboundAttachment,
  completeKnowledgeDocument,
  completeMessageTranslation,
  completeOutboundMessage,
  completeReplySuggestion,
  createAiMember,
  createDatabase,
  createFacebookHumanReply,
  createFileKnowledgeDocument,
  createInlineKnowledgeDocument,
  createInternalNote,
  createInvitation,
  createKnowledgeBase,
  createKnowledgeQuestions,
  createMediaAsset,
  createMessageTranslation,
  createReplySuggestion,
  createWorkspaceFromRegistrationInvite,
  type Database,
  deleteInboxView,
  deleteKnowledgeDocument,
  deleteMember,
  deleteOldFacebookWebhookReceipts,
  deleteReplyTemplate,
  disableFacebookChannel,
  expireFacebookInboundAttachments,
  type FacebookChannelCursor,
  FacebookError,
  failFacebookInboundAttachment,
  failKnowledgeDocument,
  failOutboundMessage,
  finishAiOperation,
  getAiFacebookAdvertisingContext,
  getAiMemberConfig,
  getCustomerProfile,
  getFacebookAttachmentForDownload,
  getFacebookOutboundDelivery,
  getFacebookOutboundMedia,
  getKnowledgeDocumentStorageKey,
  getMediaAsset,
  handoffAiConversation,
  hashKnowledgeText,
  InboxError,
  inboxFilterOptions,
  KnowledgeError,
  KnowledgeProcessingError,
  listCustomerLinkTargets,
  listCustomerPropertyHistory,
  listDueCustomerMemoryIds,
  listFacebookChannels,
  listFacebookChannelsPage,
  listFacebookConversations,
  listFacebookMessages,
  listFacebookReferrals,
  listInboxViews,
  listInternalNotes,
  listKnowledgeBases,
  listKnowledgeDocuments,
  listMediaAssets,
  listPendingFacebookInboundAttachmentIds,
  listPendingKnowledgeDocumentIds,
  listQueuedAiResponseRunIds,
  listDueAiFollowUpConversations,
  startAiFollowUp,
  listQueuedConversationIds,
  listReplyTemplates,
  listStaleAiResponseRuns,
  listTeam,
  listUnclaimedOutboundMessageIds,
  MAX_INBOUND_ATTACHMENT_BYTES,
  MAX_INLINE_KNOWLEDGE_CODE_POINTS,
  MAX_OUTBOUND_TEXT_LENGTH,
  MemberError,
  member,
  normalizeKnowledgeText,
  processFacebookInbound,
  processFacebookReceipt,
  processFacebookReferral,
  propertyDependencies,
  publishAiMemberConfig,
  ReplyError,
  readReplySuggestionContext,
  recordAiResponseRetrievedChunks,
  recoverAiOperations,
  recoverStaleOutboundMessages,
  releaseFacebookInboundAttachment,
  releaseKnowledgeDocument,
  releaseOutboundMessage,
  removeCustomerTagDefinition,
  retryAiResponseRun,
  retryFacebookHumanReply,
  saveCustomerTagDefinition,
  saveInboxView,
  savePropertyDefinition,
  saveReplyTemplate,
  setConversationMute,
  setCustomerProperty,
  setCustomerTag,
  setMemberChannelAccess,
  storeFacebookMediaUpload,
  TRANSLATION_LANGUAGES,
  takeOverConversation,
  transferConversation,
  unassignConversation,
  updateAiMemberConfig,
  updateCustomerProfile,
  updateKnowledgeQuestion,
  updateMediaAsset,
  updateMember,
  validateAnyInvitation,
  workspace,
  workspaceUserAccess,
} from '@deepsales/db'
import { and, eq, sql } from 'drizzle-orm'
import { type Context, Hono } from 'hono'
import { Pool } from 'pg'
import { z } from 'zod'
import {
  AIEmbeddingError,
  AIOutputError,
  AIProviderError,
  ALIBABA_EMBEDDING_PROVIDER,
  ALIBABA_LLM_PROVIDER,
  aiMemberRuntimeSnapshotSchema,
  aiStopRulesSchema,
  aiTimeZoneSchema,
  applyHandoffPolicy,
  createAlibabaEmbeddingProvider,
  createAlibabaLlmProvider,
  DEFAULT_EMBEDDING_MODEL,
  detectConfiguredHandoff,
  EMBEDDING_DIMENSIONS,
  enforceGrounding,
  isLlmProviderConfigurationUsable,
  MAX_AI_CURRENT_INPUT_CODE_POINTS,
  matchedHandoffRuleId,
} from './ai'
import { aiOperationsRoutes } from './ai-operations'
import { meteredAiFetch } from './ai-usage'
import { createAuth } from './auth'
import type { Bindings } from './bindings'
import { campaignRoutes, campaignTickSchema, pumpCampaigns } from './campaigns'
import { customerMemoryJobSchema, processCustomerMemoryJob } from './customer-memory'
import {
  createFacebookAdapter,
  decryptFacebookToken,
  encryptFacebookAttachmentSources,
  FacebookProviderError,
  FacebookWebhookPayloadError,
  facebookAttachmentJobSchema,
  facebookOutboundJobSchema,
  facebookReceiptJobSchema,
  facebookWebhookJobSchema,
  isFacebookReplyWindowOpen,
  isHttpUrl,
  isRetryableFacebookFailure,
  isValidTokenEncryptionKey,
  MAX_FACEBOOK_WEBHOOK_EVENTS,
  normalizeFacebookReceipts,
  normalizeFacebookWebhook,
  redactedFacebookFailure,
} from './facebook'
import { facebookReferralJobSchema, normalizeFacebookReferrals } from './facebook-referrals'
import {
  beginFacebookOAuth,
  completeFacebookOAuth,
  facebookServiceConfig,
  listFacebookOAuthPages,
  recheckFacebookPage,
  selectFacebookPages,
} from './facebook-service'
import { knowledgeDocumentJobSchema, retrieveKnowledgeChunks } from './knowledge'
import {
  extractKnowledgeText,
  KnowledgeFileError,
  knowledgeFileTypeForName,
  MAX_KNOWLEDGE_FILE_BYTES,
  readKnowledgeFileBody,
  validateKnowledgeFile,
} from './knowledge-files'
import { MAX_FACEBOOK_WEBHOOK_BODY_BYTES } from './limits'
import { MAX_MEDIA_BYTES, validateMediaFile } from './media-files'
import { createObjectStorage } from './object-storage'
import { createJobQueue, type JobQueue } from './queue'
import { publishRealtime, WorkspaceRealtime } from './realtime'
import { aiResponseJobSchema, maintenanceRoutingJobSchema } from './routing'

const app = new Hono<{ Bindings: Bindings }>()
const MAX_KNOWLEDGE_UPLOAD_BODY_BYTES = MAX_KNOWLEDGE_FILE_BYTES + 64 * 1024
const MAX_INLINE_KNOWLEDGE_BODY_BYTES = 8 * 1024 * 1024
const ATTACHMENT_SOURCE_TIMEOUT_MS = 30_000
const safeRequestMethods = new Set(['GET', 'HEAD', 'OPTIONS'])

app.use('*', async (c, next) => {
  await next()
  c.header('X-Content-Type-Options', 'nosniff')
  c.header('X-Frame-Options', 'DENY')
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin')
  c.header('Permissions-Policy', 'camera=(), microphone=(self), geolocation=()')
  if (c.env.APP_URL?.startsWith('https://')) {
    c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
  }
})

app.use('/api/*', async (c, next) => {
  if (safeRequestMethods.has(c.req.method)) return next()

  const origin = c.req.header('origin')
  if (!origin || !c.env.APP_URL) return next()

  try {
    if (new URL(origin).origin !== new URL(c.env.APP_URL).origin) {
      return c.json(
        { error: { code: 'ORIGIN_NOT_ALLOWED', message: 'Request origin is not allowed' } },
        403,
      )
    }
  } catch {
    return c.json(
      { error: { code: 'ORIGIN_NOT_ALLOWED', message: 'Request origin is not allowed' } },
      403,
    )
  }

  return next()
})

const workspaceInput = z.object({ name: z.string().trim().min(1).max(100) })
const invitationInput = z.object({
  email: z
    .string()
    .trim()
    .max(320)
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
const invitationTokenInput = z.string().trim().min(1).max(200)
const invitationSignupInput = z.object({
  email: z
    .string()
    .trim()
    .max(320)
    .email()
    .transform((email) => email.toLowerCase()),
  invitationToken: invitationTokenInput,
})
const authSignupResponse = z.object({
  user: z.object({ id: z.string().min(1), email: z.string().email(), name: z.string() }),
})
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
  'closed',
  'team',
])

const inboxFiltersInput = z
  .object({
    view: conversationViewInput,
    query: z.string().trim().min(1).max(200).optional(),
    memberIds: z.array(z.string().uuid()).max(50).optional(),
    tagIds: z.array(z.string().uuid()).max(50).optional(),
    customerId: z.string().uuid().optional(),
    updatedFrom: z.string().datetime({ offset: true }).optional(),
    updatedTo: z.string().datetime({ offset: true }).optional(),
    attention: z.enum(['unread', 'unanswered']).optional(),
    mute: z.enum(['muted', 'unmuted']).optional(),
    properties: z
      .array(
        z
          .object({
            definitionId: z.string().uuid(),
            value: z.union([z.string().max(2000), z.number().finite()]),
          })
          .strict(),
      )
      .max(20)
      .optional(),
  })
  .strict()
  .refine(
    (f) => !f.updatedFrom || !f.updatedTo || Date.parse(f.updatedFrom) <= Date.parse(f.updatedTo),
  )
const conversationCursorInput = z.object({
  updatedAt: z.string().datetime(),
  id: z.string().uuid(),
})
const messageCursorInput = z.object({ createdAt: z.string().datetime(), id: z.string().uuid() })
const replyInput = z
  .object({
    text: z.string().trim().min(1).max(MAX_OUTBOUND_TEXT_LENGTH).optional(),
    assetId: z.string().uuid().optional(),
    clientKey: z.string().uuid().optional(),
    suggestionId: z.string().uuid().optional(),
    translation: z
      .object({
        id: z.string().uuid(),
        sourceText: z.string().trim().min(1).max(2000),
        sourceVersion: z.string().uuid(),
        targetLanguage: z.string().max(20),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    (value) =>
      Boolean(value.text) !== Boolean(value.assetId) &&
      (!value.assetId || Boolean(value.clientKey)),
  )
const transferInput = z
  .object({ targetMemberId: z.string().uuid(), confirmOverride: z.boolean().optional() })
  .strict()
const knowledgeBaseInput = z.object({ name: z.string().trim().min(1).max(100) }).strict()
const knowledgeTextInput = z
  .object({
    mediaAssetId: z.string().uuid().optional(),
    name: z.string().trim().min(1).max(100),
    text: z
      .string()
      .refine((value) => Array.from(value).length <= MAX_INLINE_KNOWLEDGE_CODE_POINTS),
  })
  .strict()
const aiMemberConfigInput = z
  .object({
    stopRules: aiStopRulesSchema.optional(),
    splitRepliesEnabled: z.boolean().optional(),
    automaticLanguageEnabled: z.boolean().optional(),
    timeZone: aiTimeZoneSchema.optional(),
    instructions: z.string().max(20_000).optional(),
    responseLanguage: z.string().max(100).optional(),
    knowledgeBaseId: z.string().uuid().nullable().optional(),
    handoffOnCustomerRequest: z.boolean().optional(),
    handoffOnNoKnowledge: z.boolean().optional(),
    handoffOnNegativeSentiment: z.boolean().optional(),
    handoffOnUnableToAnswer: z.boolean().optional(),
    handoffKeywords: z.array(z.string().max(100)).max(100).optional(),
    adLearningEnabled: z.boolean().optional(),
    naturalToneEnabled: z.boolean().optional(),
    unparsedFallbackEnabled: z.boolean().optional(),
    unparsedFallbackTexts: z
      .array(
        z
          .string()
          .trim()
          .min(1)
          .max(1000)
          .refine((s) => Array.from(s).length <= 500),
      )
      .max(10)
      .optional(),
    memoryEnabled: z.boolean().optional(),
    tagsEnabled: z.boolean().optional(),
    replyWaitEnabled: z.boolean().optional(),
    adMappings: z
      .array(z.object({ adId: z.string().max(200), content: z.string().max(4000) }).strict())
      .max(100)
      .optional(),
  })
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
    c.req.method === 'POST' && (isEmailSignInPath(c.req.path) || isEmailSignupPath(c.req.path))
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

app.use('/api/auth/*', async (c, next) => {
  if (c.req.method !== 'POST' || !isEmailSignupPath(c.req.path)) return next()

  const body = (await c.req.raw
    .clone()
    .json()
    .catch(() => null)) as Record<string, unknown> | null
  const input = invitationSignupInput.safeParse(body)
  if (!input.success) return invitationRequired(c)

  try {
    return await withDatabase(c.env, (db) =>
      db.transaction(async (tx) => {
        const transactionalDb = tx as unknown as Database
        await validateAnyInvitation(transactionalDb, {
          token: input.data.invitationToken,
          userEmail: input.data.email,
        })

        const response = await createAuth(transactionalDb, c.env).handler(c.req.raw)
        if (!response.ok) return normalizeAuthError(response)

        const payload = authSignupResponse.safeParse(
          await response
            .clone()
            .json()
            .catch(() => null),
        )
        if (!payload.success) {
          throw new MemberError('INVITATION_INVALID', 'Invitation registration failed')
        }

        await acceptAnyInvitation(transactionalDb, {
          token: input.data.invitationToken,
          userId: payload.data.user.id,
          userEmail: payload.data.user.email,
          userName: payload.data.user.name,
        })
        return response
      }),
    )
  } catch (error) {
    return memberErrorResponse(c, error)
  }
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
    const limited = await rateLimit(c, `workspace-create:${session.user.id}`)
    if (limited) return limited

    const input = workspaceInput.safeParse(await c.req.json().catch(() => null))
    if (!input.success) {
      return c.json({ error: { code: 'INVALID_REQUEST', message: 'Enter a workspace name' } }, 400)
    }

    try {
      const created = await createWorkspaceFromRegistrationInvite(db, {
        userId: session.user.id,
        userName: session.user.name,
        name: input.data.name,
      })
      return c.json({ workspace: created }, 201)
    } catch (error) {
      return memberErrorResponse(c, error)
    }
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

app.get('/api/workspaces/:workspaceId/ai-members/:memberId/config', async (c) => {
  if (!hasAuthBindings(c.env)) return notReady(c)
  return withDatabase(c.env, async (db) => {
    const session = await createAuth(db, c.env).api.getSession({ headers: c.req.raw.headers })
    if (!session) return unauthorized(c)
    try {
      return c.json({
        config: await getAiMemberConfig(db, {
          workspaceId: c.req.param('workspaceId'),
          memberId: c.req.param('memberId'),
          actingUserId: session.user.id,
        }),
      })
    } catch (error) {
      return aiMemberErrorResponse(c, error)
    }
  })
})

app.patch('/api/workspaces/:workspaceId/ai-members/:memberId/config', async (c) => {
  if (!hasAuthBindings(c.env)) return notReady(c)
  return withDatabase(c.env, async (db) => {
    const session = await createAuth(db, c.env).api.getSession({ headers: c.req.raw.headers })
    if (!session) return unauthorized(c)
    const body = await readLimitedRequestBody(c.req.raw, 1024 * 1024)
    if (!body)
      return c.json({ error: { code: 'TOO_LARGE', message: 'Configuration is too large' } }, 413)
    let parsed: unknown = null
    try {
      parsed = JSON.parse(new TextDecoder().decode(body))
    } catch {}
    const input = aiMemberConfigInput.safeParse(parsed)
    if (!input.success) {
      return c.json(
        { error: { code: 'INVALID_REQUEST', message: 'Invalid AI configuration' } },
        400,
      )
    }
    try {
      const config = await updateAiMemberConfig(db, {
        workspaceId: c.req.param('workspaceId'),
        memberId: c.req.param('memberId'),
        actingUserId: session.user.id,
        ...input.data,
      })
      await publishMemberChange(c.env, c.req.param('workspaceId'), c.req.param('memberId'))
      return c.json({ config })
    } catch (error) {
      return aiMemberErrorResponse(c, error)
    }
  })
})

app.post('/api/workspaces/:workspaceId/ai-members/:memberId/publish', async (c) => {
  if (!hasAuthBindings(c.env)) return notReady(c)
  return withDatabase(c.env, async (db) => {
    const session = await createAuth(db, c.env).api.getSession({ headers: c.req.raw.headers })
    if (!session) return unauthorized(c)
    const limited = await rateLimit(c, `ai-publish:${session.user.id}`)
    if (limited) return limited
    try {
      const config = await publishAiMemberConfig(db, {
        workspaceId: c.req.param('workspaceId'),
        memberId: c.req.param('memberId'),
        actingUserId: session.user.id,
        providerConfigured: isLlmProviderConfigurationUsable({
          apiKey: c.env.AI_API_KEY,
          baseUrl: c.env.AI_BASE_URL,
          provider: c.env.LLM_PROVIDER,
          model: c.env.LLM_MODEL,
        }),
      })
      await enqueueQueuedConversations(c.env, db, c.req.param('workspaceId'))
      for (const runId of await listQueuedAiResponseRunIds(db, 100, config.memberId))
        await enqueueAiResponseJob(c.env, runId)
      await publishMemberChange(c.env, c.req.param('workspaceId'), c.req.param('memberId'))
      return c.json({ config })
    } catch (error) {
      return aiMemberErrorResponse(c, error)
    }
  })
})

app.route('/', aiOperationsRoutes(withDatabase))
app.route('/', campaignRoutes(withDatabase))

app.get('/api/workspaces/:workspaceId/knowledge-bases', async (c) => {
  if (!hasAuthBindings(c.env)) return notReady(c)
  return withDatabase(c.env, async (db) => {
    const session = await createAuth(db, c.env).api.getSession({ headers: c.req.raw.headers })
    if (!session) return unauthorized(c)
    try {
      return c.json({
        knowledgeBases: await listKnowledgeBases(db, {
          workspaceId: c.req.param('workspaceId'),
          userId: session.user.id,
        }),
      })
    } catch (error) {
      return knowledgeErrorResponse(c, error)
    }
  })
})

app.post('/api/workspaces/:workspaceId/knowledge-bases', async (c) => {
  if (!hasAuthBindings(c.env)) return notReady(c)
  return withDatabase(c.env, async (db) => {
    const session = await createAuth(db, c.env).api.getSession({ headers: c.req.raw.headers })
    if (!session) return unauthorized(c)
    const limited = await rateLimit(c, `knowledge-base:${session.user.id}`)
    if (limited) return limited
    const input = knowledgeBaseInput.safeParse(await c.req.json().catch(() => null))
    if (!input.success) {
      return c.json(
        { error: { code: 'INVALID_REQUEST', message: 'Enter a knowledge base name' } },
        400,
      )
    }
    try {
      const knowledgeBase = await createKnowledgeBase(db, {
        workspaceId: c.req.param('workspaceId'),
        createdByUserId: session.user.id,
        name: input.data.name,
      })
      await publishKnowledgeChange(c.env, c.req.param('workspaceId'), knowledgeBase.id)
      return c.json({ knowledgeBase }, 201)
    } catch (error) {
      return knowledgeErrorResponse(c, error)
    }
  })
})

app.get('/api/workspaces/:workspaceId/knowledge-bases/:knowledgeBaseId/documents', async (c) => {
  if (!hasAuthBindings(c.env)) return notReady(c)
  return withDatabase(c.env, async (db) => {
    const session = await createAuth(db, c.env).api.getSession({ headers: c.req.raw.headers })
    if (!session) return unauthorized(c)
    try {
      return c.json({
        documents: await listKnowledgeDocuments(db, {
          workspaceId: c.req.param('workspaceId'),
          knowledgeBaseId: c.req.param('knowledgeBaseId'),
          userId: session.user.id,
        }),
      })
    } catch (error) {
      return knowledgeErrorResponse(c, error)
    }
  })
})

app.post(
  '/api/workspaces/:workspaceId/knowledge-bases/:knowledgeBaseId/documents/text',
  async (c) => {
    if (!hasAuthBindings(c.env)) return notReady(c)
    return withDatabase(c.env, async (db) => {
      const session = await createAuth(db, c.env).api.getSession({ headers: c.req.raw.headers })
      if (!session) return unauthorized(c)
      const limited = await rateLimit(c, `knowledge-document:${session.user.id}`)
      if (limited) return limited
      const body = await readLimitedRequestBody(c.req.raw, MAX_INLINE_KNOWLEDGE_BODY_BYTES)
      if (!body) {
        return c.json(
          { error: { code: 'TOO_LARGE', message: 'Document request is too large' } },
          413,
        )
      }
      let parsedBody: unknown = null
      try {
        parsedBody = JSON.parse(new TextDecoder().decode(body))
      } catch {
        parsedBody = null
      }
      const input = knowledgeTextInput.safeParse(parsedBody)
      if (!input.success) {
        return c.json({ error: { code: 'INVALID_REQUEST', message: 'Enter document text' } }, 400)
      }
      try {
        const document = await createInlineKnowledgeDocument(db, {
          workspaceId: c.req.param('workspaceId'),
          knowledgeBaseId: c.req.param('knowledgeBaseId'),
          createdByUserId: session.user.id,
          name: input.data.name,
          text: input.data.text,
          mediaAssetId: input.data.mediaAssetId,
        })
        if (document.status === 'UPLOADED') {
          await enqueueKnowledgeDocumentJob(c.env.DOCUMENTS_QUEUE, document.id)
        }
        await publishKnowledgeChange(c.env, c.req.param('workspaceId'), document.id)
        return c.json({ document }, 201)
      } catch (error) {
        return knowledgeErrorResponse(c, error)
      }
    })
  },
)

const knowledgeQuestionInput = z
  .object({ question: z.string().max(1600), answer: z.string().max(6000) })
  .strict()
async function knowledgeQuestionsRequest(c: Context<{ Bindings: Bindings }>) {
  if (!hasAuthBindings(c.env)) return notReady(c)
  const ids = z
    .object({
      workspaceId: z.string().uuid(),
      knowledgeBaseId: z.string().uuid(),
      documentId: z.string().uuid().optional(),
    })
    .safeParse(c.req.param())
  if (!ids.success) return knowledgeErrorResponse(c, new KnowledgeError('INVALID_REQUEST'))
  return withDatabase(c.env, async (db) => {
    const session = await createAuth(db, c.env).api.getSession({ headers: c.req.raw.headers })
    if (!session) return unauthorized(c)
    const limited = await rateLimit(c, `knowledge-document:${session.user.id}`)
    if (limited) return limited
    const body = await readLimitedRequestBody(c.req.raw, 1024 * 1024)
    if (!body)
      return c.json({ error: { code: 'TOO_LARGE', message: 'Question import is too large' } }, 413)
    let json: unknown = null
    try {
      json = JSON.parse(new TextDecoder().decode(body))
    } catch {}
    if (c.req.method === 'PATCH') {
      const edit = knowledgeQuestionInput
        .extend({ expectedRevision: z.number().int().min(1).max(2147483646) })
        .safeParse(json)
      if (!edit.success || !ids.data.documentId)
        return knowledgeErrorResponse(c, new KnowledgeError('INVALID_REQUEST'))
      try {
        const document = await updateKnowledgeQuestion(db, {
          ...ids.data,
          documentId: ids.data.documentId,
          actingUserId: session.user.id,
          ...edit.data,
        })
        if (document.status === 'UPLOADED')
          await enqueueKnowledgeDocumentJob(c.env.DOCUMENTS_QUEUE, document.id)
        await publishKnowledgeChange(c.env, ids.data.workspaceId, document.id)
        return c.json({ document })
      } catch (error) {
        return knowledgeErrorResponse(c, error)
      }
    }
    const parsed = z
      .object({
        items: z
          .array(knowledgeQuestionInput.extend({ id: z.string().uuid() }))
          .min(1)
          .max(100),
      })
      .strict()
      .safeParse(json)
    if (!parsed.success) return knowledgeErrorResponse(c, new KnowledgeError('INVALID_REQUEST'))
    try {
      const documents = await createKnowledgeQuestions(db, {
        ...ids.data,
        actingUserId: session.user.id,
        items: parsed.data.items,
      })
      for (const document of documents) {
        if (document.status === 'UPLOADED')
          await enqueueKnowledgeDocumentJob(c.env.DOCUMENTS_QUEUE, document.id)
        await publishKnowledgeChange(c.env, ids.data.workspaceId, document.id)
      }
      return c.json({ documents }, 201)
    } catch (error) {
      return knowledgeErrorResponse(c, error)
    }
  })
}
app.post(
  '/api/workspaces/:workspaceId/knowledge-bases/:knowledgeBaseId/documents/questions',
  knowledgeQuestionsRequest,
)
app.patch(
  '/api/workspaces/:workspaceId/knowledge-bases/:knowledgeBaseId/documents/questions/:documentId',
  knowledgeQuestionsRequest,
)

app.post(
  '/api/workspaces/:workspaceId/knowledge-bases/:knowledgeBaseId/documents/upload',
  async (c) => {
    if (!hasAuthBindings(c.env)) return notReady(c)
    const objects = c.env.OBJECTS
    if (!objects) {
      return c.json(
        { error: { code: 'STORAGE_UNAVAILABLE', message: 'File storage is unavailable' } },
        503,
      )
    }
    return withDatabase(c.env, async (db) => {
      const session = await createAuth(db, c.env).api.getSession({ headers: c.req.raw.headers })
      if (!session) return unauthorized(c)
      const limited = await rateLimit(c, `knowledge-upload:${session.user.id}`)
      if (limited) return limited

      try {
        await assertKnowledgeBaseManager(db, {
          workspaceId: c.req.param('workspaceId'),
          knowledgeBaseId: c.req.param('knowledgeBaseId'),
          userId: session.user.id,
        })
        const uploadBody = await readLimitedRequestBody(c.req.raw, MAX_KNOWLEDGE_UPLOAD_BODY_BYTES)
        if (!uploadBody) {
          return c.json(
            { error: { code: 'TOO_LARGE', message: 'Upload request is too large' } },
            413,
          )
        }
        const form = await new Request(c.req.raw, { body: uploadBody }).formData().catch(() => null)
        const fileInput = z.object({ file: z.instanceof(File) }).safeParse({
          file: form?.get('file'),
        })
        if (!fileInput.success) {
          return c.json({ error: { code: 'INVALID_REQUEST', message: 'Choose a file' } }, 400)
        }
        const value = fileInput.data.file
        const fileType = knowledgeFileTypeForName(value.name)
        if (!fileType) {
          return c.json(
            {
              error: { code: 'UNSUPPORTED_FILE_TYPE', message: 'Use PDF, DOCX, TXT, or Markdown' },
            },
            400,
          )
        }

        const documentInput = {
          workspaceId: c.req.param('workspaceId'),
          knowledgeBaseId: c.req.param('knowledgeBaseId'),
          createdByUserId: session.user.id,
          name: displayFileName(value.name),
          sourceType: fileType.sourceType,
        }
        const createFailure = async (failureCode: string) => {
          const document = await createFileKnowledgeDocument(db, { ...documentInput, failureCode })
          await publishKnowledgeChange(c.env, c.req.param('workspaceId'), document.id)
          return c.json({ document }, 201)
        }

        if (value.size > MAX_KNOWLEDGE_FILE_BYTES) return createFailure('TOO_LARGE')

        let bytes: Uint8Array
        try {
          bytes = new Uint8Array(await value.arrayBuffer())
        } catch {
          return createFailure('UPLOAD_READ_FAILED')
        }
        try {
          const validated = validateKnowledgeFile(value.name, value.type, bytes)
          const storageKey = `knowledge/${crypto.randomUUID()}`
          const storage = createObjectStorage(objects)
          try {
            await storage.put(storageKey, bytes, validated.mimeType)
          } catch {
            return c.json(
              { error: { code: 'STORAGE_UNAVAILABLE', message: 'File storage is unavailable' } },
              503,
            )
          }

          let document: Awaited<ReturnType<typeof createFileKnowledgeDocument>>
          try {
            document = await createFileKnowledgeDocument(db, {
              ...documentInput,
              sourceType: validated.sourceType,
              storageKey,
            })
          } catch (error) {
            await storage.delete(storageKey).catch(() => {})
            throw error
          }
          await enqueueKnowledgeDocumentJob(c.env.DOCUMENTS_QUEUE, document.id)
          await publishKnowledgeChange(c.env, c.req.param('workspaceId'), document.id)
          return c.json({ document }, 201)
        } catch (error) {
          if (!(error instanceof KnowledgeFileError)) throw error
          return createFailure(error.code)
        }
      } catch (error) {
        return knowledgeErrorResponse(c, error)
      }
    })
  },
)

app.delete(
  '/api/workspaces/:workspaceId/knowledge-bases/:knowledgeBaseId/documents/:documentId',
  async (c) => {
    if (!hasAuthBindings(c.env)) return notReady(c)
    return withDatabase(c.env, async (db) => {
      const session = await createAuth(db, c.env).api.getSession({ headers: c.req.raw.headers })
      if (!session) return unauthorized(c)
      const limited = await rateLimit(c, `knowledge-delete:${session.user.id}`)
      if (limited) return limited
      try {
        const document = await getKnowledgeDocumentStorageKey(db, {
          workspaceId: c.req.param('workspaceId'),
          knowledgeBaseId: c.req.param('knowledgeBaseId'),
          documentId: c.req.param('documentId'),
          actingUserId: session.user.id,
        })
        if (document.storageKey) {
          if (!c.env.OBJECTS) {
            return c.json(
              { error: { code: 'STORAGE_UNAVAILABLE', message: 'File storage is unavailable' } },
              503,
            )
          }
          try {
            await createObjectStorage(c.env.OBJECTS).delete(document.storageKey)
          } catch {
            return c.json(
              { error: { code: 'STORAGE_UNAVAILABLE', message: 'File storage is unavailable' } },
              503,
            )
          }
        }
        const deleted = await deleteKnowledgeDocument(db, {
          workspaceId: c.req.param('workspaceId'),
          knowledgeBaseId: c.req.param('knowledgeBaseId'),
          documentId: c.req.param('documentId'),
          actingUserId: session.user.id,
        })
        await publishKnowledgeChange(c.env, c.req.param('workspaceId'), deleted.id)
        return c.body(null, 204)
      } catch (error) {
        return knowledgeErrorResponse(c, error)
      }
    })
  },
)

app.get('/api/workspaces/:workspaceId/inbox-filter-options', async (c) => {
  if (!hasAuthBindings(c.env)) return notReady(c)
  return withDatabase(c.env, async (db) => {
    const session = await createAuth(db, c.env).api.getSession({ headers: c.req.raw.headers })
    if (!session) return unauthorized(c)
    try {
      return c.json(
        await inboxFilterOptions(db, {
          workspaceId: c.req.param('workspaceId'),
          userId: session.user.id,
        }),
      )
    } catch (error) {
      return inboxErrorResponse(c, error)
    }
  })
})
app.get('/api/workspaces/:workspaceId/inbox-views', async (c) => {
  if (!hasAuthBindings(c.env)) return notReady(c)
  return withDatabase(c.env, async (db) => {
    const session = await createAuth(db, c.env).api.getSession({ headers: c.req.raw.headers })
    if (!session) return unauthorized(c)
    try {
      return c.json(
        await listInboxViews(db, {
          workspaceId: c.req.param('workspaceId'),
          userId: session.user.id,
        }),
      )
    } catch (error) {
      return inboxErrorResponse(c, error)
    }
  })
})
const savedInboxViewInput = z
  .object({
    name: z.string().trim().min(1).max(100),
    scope: z.enum(['PERSONAL', 'PUBLIC']),
    filters: inboxFiltersInput,
  })
  .strict()
app.on(
  ['POST', 'PATCH', 'DELETE'],
  ['/api/workspaces/:workspaceId/inbox-views', '/api/workspaces/:workspaceId/inbox-views/:viewId'],
  async (c) => {
    if (!hasAuthBindings(c.env)) return notReady(c)
    return withDatabase(c.env, async (db) => {
      const session = await createAuth(db, c.env).api.getSession({ headers: c.req.raw.headers })
      if (!session) return unauthorized(c)
      try {
        const id = c.req.param('viewId')
        if (
          (c.req.method === 'POST' && id) ||
          (c.req.method !== 'POST' && !id) ||
          (id && !z.string().uuid().safeParse(id).success)
        )
          throw new InboxError('INVALID_REQUEST')
        const context = { workspaceId: c.req.param('workspaceId'), userId: session.user.id }
        if (c.req.method === 'DELETE') {
          if (!id) throw new InboxError('INVALID_REQUEST')
          await deleteInboxView(db, { ...context, id })
          return c.body(null, 204)
        }
        const parsed = savedInboxViewInput.safeParse(await c.req.json().catch(() => null))
        if (!parsed.success) throw new InboxError('INVALID_REQUEST', 'Invalid saved view')
        return c.json(
          await saveInboxView(db, { ...context, ...parsed.data, id }),
          c.req.method === 'POST' ? 201 : 200,
        )
      } catch (error) {
        return inboxErrorResponse(c, error)
      }
    })
  },
)

app.get('/api/workspaces/:workspaceId/conversations', async (c) => {
  if (!hasAuthBindings(c.env)) return notReady(c)
  return withDatabase(c.env, async (db) => {
    const session = await createAuth(db, c.env).api.getSession({ headers: c.req.raw.headers })
    if (!session) return unauthorized(c)

    try {
      let properties: unknown
      try {
        const raw = c.req.query('properties')
        properties = raw ? JSON.parse(raw) : undefined
      } catch {
        throw new InboxError('INVALID_REQUEST', 'Invalid property filters')
      }
      const filters = inboxFiltersInput.safeParse({
        view: c.req.query('view') ?? 'all-open',
        query: c.req.query('query'),
        memberIds: c.req.query('memberIds')?.split(','),
        tagIds: c.req.query('tagIds')?.split(','),
        customerId: c.req.query('customerId'),
        updatedFrom: c.req.query('updatedFrom'),
        updatedTo: c.req.query('updatedTo'),
        attention: c.req.query('attention'),
        mute: c.req.query('mute'),
        properties,
      })
      if (!filters.success) throw new InboxError('INVALID_REQUEST', 'Invalid inbox filters')
      const selected = z.string().uuid().optional().safeParse(c.req.query('conversationId'))
      if (!selected.success) throw new InboxError('INVALID_REQUEST', 'Invalid conversation ID')
      const page = await listFacebookConversations(db, {
        workspaceId: c.req.param('workspaceId'),
        userId: session.user.id,
        tagId: c.req.query('tagId'),
        ...filters.data,
        conversationId: selected.data,
        after: decodeConversationCursor(c.req.query('cursor')),
      })
      return c.json({
        conversations: page.conversations,
        nextCursor: page.nextCursor
          ? encodeCursor({
              updatedAt: page.nextCursor.updatedAt,
              id: page.nextCursor.id,
            })
          : null,
      })
    } catch (error) {
      return inboxErrorResponse(c, error)
    }
  })
})

app.on(['GET', 'POST'], '/api/workspaces/:workspaceId/media-assets', async (c) => {
  if (!hasAuthBindings(c.env)) return notReady(c)
  return withDatabase(c.env, async (db) => {
    const session = await createAuth(db, c.env).api.getSession({ headers: c.req.raw.headers })
    if (!session) return unauthorized(c)
    const context = { workspaceId: c.req.param('workspaceId'), userId: session.user.id }
    try {
      if (c.req.method === 'GET')
        return c.json(
          await listMediaAssets(db, { ...context, query: c.req.query('query')?.slice(0, 200) }),
        )
      await assertInboxViewer(db, context.workspaceId, context.userId)
      const limited = await rateLimit(c, `media-upload:${session.user.id}`)
      if (limited) return limited
      if (!c.env.OBJECTS) return notReady(c)
      const id = z.string().uuid().safeParse(c.req.header('X-Upload-Id'))
      if (!id.success) throw new InboxError('INVALID_REQUEST', 'Invalid upload ID')
      const body = await readLimitedRequestBody(c.req.raw, MAX_MEDIA_BYTES)
      if (!body)
        return c.json({ error: { code: 'MEDIA_TOO_LARGE', message: 'Media is too large' } }, 413)
      let validated: ReturnType<typeof validateMediaFile>
      try {
        validated = validateMediaFile(
          decodeURIComponent(c.req.header('X-Filename') ?? ''),
          c.req.header('Content-Type') ?? '',
          new Uint8Array(body),
        )
      } catch {
        return c.json(
          {
            error: {
              code: 'MEDIA_INVALID_FILE',
              message: 'Unsupported media type, signature or size',
            },
          },
          400,
        )
      }
      const sha256 = await sha256Hex(body)
      const storageKey = `media/${context.workspaceId}/${id.data}/${sha256}`
      await createObjectStorage(c.env.OBJECTS).put(
        storageKey,
        new Uint8Array(body),
        validated.mimeType,
      )
      const result = await createMediaAsset(db, {
        ...context,
        asset: {
          ...validated,
          id: id.data,
          workspaceId: context.workspaceId,
          title: validated.filename,
          sha256,
          storageKey,
          byteSize: body.byteLength,
          inLibrary: c.req.header('X-Library') === 'true',
        },
      })
      return c.json(result, 201)
    } catch (error) {
      return inboxErrorResponse(c, error)
    }
  })
})

app.get('/api/workspaces/:workspaceId/media-assets/:assetId/file', async (c) => {
  if (!hasAuthBindings(c.env)) return notReady(c)
  return withDatabase(c.env, async (db) => {
    const session = await createAuth(db, c.env).api.getSession({ headers: c.req.raw.headers })
    if (!session) return unauthorized(c)
    try {
      const asset = await getMediaAsset(db, {
        workspaceId: c.req.param('workspaceId'),
        userId: session.user.id,
        assetId: c.req.param('assetId'),
      })
      if (!c.env.OBJECTS) return notReady(c)
      const object = await createObjectStorage(c.env.OBJECTS).get(asset.storageKey)
      if (!object) throw new InboxError('NOT_FOUND', 'Media is unavailable')
      return new Response(object.body, {
        headers: {
          'Cache-Control': 'private, no-store',
          'X-Content-Type-Options': 'nosniff',
          'Content-Type': safeContentType(asset.mimeType),
          'Content-Disposition': contentDisposition(asset.filename, asset.kind),
        },
      })
    } catch (error) {
      return inboxErrorResponse(c, error)
    }
  })
})

app.on(['PATCH', 'DELETE'], '/api/workspaces/:workspaceId/media-assets/:assetId', async (c) => {
  if (!hasAuthBindings(c.env)) return notReady(c)
  return withDatabase(c.env, async (db) => {
    const session = await createAuth(db, c.env).api.getSession({ headers: c.req.raw.headers })
    if (!session) return unauthorized(c)
    try {
      const parsed = z
        .object({
          title: z.string().trim().min(1).max(100).optional(),
          inLibrary: z.boolean().optional(),
        })
        .strict()
        .safeParse(c.req.method === 'DELETE' ? {} : await c.req.json().catch(() => null))
      if (!parsed.success || (c.req.method === 'PATCH' && !Object.keys(parsed.data).length))
        throw new InboxError('INVALID_REQUEST', 'Invalid media metadata')
      return c.json(
        await updateMediaAsset(db, {
          workspaceId: c.req.param('workspaceId'),
          userId: session.user.id,
          assetId: c.req.param('assetId'),
          ...parsed.data,
          deleted: c.req.method === 'DELETE',
        }),
      )
    } catch (error) {
      return inboxErrorResponse(c, error)
    }
  })
})

app.on(['GET', 'POST'], '/api/workspaces/:workspaceId/reply-templates', async (c) => {
  if (!hasAuthBindings(c.env)) return notReady(c)
  return withDatabase(c.env, async (db) => {
    const session = await createAuth(db, c.env).api.getSession({ headers: c.req.raw.headers })
    if (!session) return unauthorized(c)
    const context = { workspaceId: c.req.param('workspaceId'), userId: session.user.id }
    try {
      if (c.req.method === 'GET')
        return c.json(
          await listReplyTemplates(db, { ...context, query: c.req.query('query')?.slice(0, 200) }),
        )
      const parsed = z
        .object({
          title: z.string().trim().min(1).max(100),
          text: z.string().trim().min(1).max(2000),
        })
        .strict()
        .safeParse(await c.req.json().catch(() => null))
      if (!parsed.success) throw new InboxError('INVALID_REQUEST', 'Invalid reply template')
      return c.json(await saveReplyTemplate(db, { ...context, ...parsed.data }), 201)
    } catch (error) {
      return inboxErrorResponse(c, error)
    }
  })
})

app.on(['PUT', 'DELETE'], '/api/workspaces/:workspaceId/reply-templates/:templateId', async (c) => {
  if (!hasAuthBindings(c.env)) return notReady(c)
  return withDatabase(c.env, async (db) => {
    const session = await createAuth(db, c.env).api.getSession({ headers: c.req.raw.headers })
    if (!session) return unauthorized(c)
    const context = {
      workspaceId: c.req.param('workspaceId'),
      userId: session.user.id,
      id: c.req.param('templateId'),
    }
    try {
      if (c.req.method === 'DELETE') return c.json(await deleteReplyTemplate(db, context))
      const parsed = z
        .object({
          title: z.string().trim().min(1).max(100),
          text: z.string().trim().min(1).max(2000),
        })
        .strict()
        .safeParse(await c.req.json().catch(() => null))
      if (!parsed.success) throw new InboxError('INVALID_REQUEST', 'Invalid reply template')
      return c.json(await saveReplyTemplate(db, { ...context, ...parsed.data }))
    } catch (error) {
      return inboxErrorResponse(c, error)
    }
  })
})

app.post(
  '/api/workspaces/:workspaceId/conversations/:conversationId/messages/:messageId/retry',
  async (c) => {
    if (!hasAuthBindings(c.env)) return notReady(c)
    return withDatabase(c.env, async (db) => {
      const session = await createAuth(db, c.env).api.getSession({ headers: c.req.raw.headers })
      if (!session) return unauthorized(c)
      const limited = await rateLimit(c, `outbound-retry:${session.user.id}`)
      if (limited) return limited
      try {
        const result = await retryFacebookHumanReply(db, {
          workspaceId: c.req.param('workspaceId'),
          conversationId: c.req.param('conversationId'),
          actingUserId: session.user.id,
          messageId: c.req.param('messageId'),
        })
        if (result.message.deliveryState === 'PENDING')
          await enqueueOutboundMessage(c.env, result.message.id)
        await publishInboxChange(
          c.env,
          c.req.param('workspaceId'),
          result.message.id,
          'message.changed',
        )
        return c.json(result)
      } catch (error) {
        return replyErrorResponse(c, error)
      }
    })
  },
)

app.put('/api/workspaces/:workspaceId/conversations/:conversationId/mute', async (c) => {
  if (!hasAuthBindings(c.env)) return notReady(c)
  return withDatabase(c.env, async (db) => {
    const session = await createAuth(db, c.env).api.getSession({ headers: c.req.raw.headers })
    if (!session) return unauthorized(c)
    const parsed = z
      .object({ muted: z.boolean() })
      .strict()
      .safeParse(await c.req.json().catch(() => null))
    if (!parsed.success)
      return c.json({ error: { code: 'INVALID_REQUEST', message: 'Invalid mute preference' } }, 400)
    try {
      const result = await setConversationMute(db, {
        workspaceId: c.req.param('workspaceId'),
        userId: session.user.id,
        conversationId: c.req.param('conversationId'),
        ...parsed.data,
      })
      await publishInboxChange(
        c.env,
        c.req.param('workspaceId'),
        c.req.param('conversationId'),
        'conversation.changed',
      )
      return c.json(result)
    } catch (error) {
      return inboxErrorResponse(c, error)
    }
  })
})

app.get('/api/workspaces/:workspaceId/conversations/:conversationId/notes', async (c) => {
  if (!hasAuthBindings(c.env)) return notReady(c)
  return withDatabase(c.env, async (db) => {
    const session = await createAuth(db, c.env).api.getSession({ headers: c.req.raw.headers })
    if (!session) return unauthorized(c)
    try {
      const page = await listInternalNotes(db, {
        workspaceId: c.req.param('workspaceId'),
        userId: session.user.id,
        conversationId: c.req.param('conversationId'),
        before: decodeMessageCursor(c.req.query('before')),
      })
      return c.json({
        notes: page.notes,
        olderCursor: page.olderCursor ? encodeCursor(page.olderCursor) : null,
      })
    } catch (error) {
      return inboxErrorResponse(c, error)
    }
  })
})
app.post('/api/workspaces/:workspaceId/conversations/:conversationId/notes', async (c) => {
  if (!hasAuthBindings(c.env)) return notReady(c)
  return withDatabase(c.env, async (db) => {
    const session = await createAuth(db, c.env).api.getSession({ headers: c.req.raw.headers })
    if (!session) return unauthorized(c)
    const parsed = z
      .object({ clientKey: z.string().uuid(), text: z.string().trim().min(1).max(2000) })
      .strict()
      .safeParse(await c.req.json().catch(() => null))
    if (!parsed.success)
      return c.json({ error: { code: 'INVALID_REQUEST', message: 'Invalid internal note' } }, 400)
    try {
      const result = await createInternalNote(db, {
        workspaceId: c.req.param('workspaceId'),
        userId: session.user.id,
        conversationId: c.req.param('conversationId'),
        ...parsed.data,
      })
      await publishInboxChange(
        c.env,
        c.req.param('workspaceId'),
        c.req.param('conversationId'),
        'conversation.changed',
      )
      return c.json(result, 201)
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
      const page = await listFacebookConversations(db, {
        workspaceId: c.req.param('workspaceId'),
        userId: session.user.id,
        view: 'all-open',
        conversationId: c.req.param('conversationId'),
        includeClosed: true,
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
      if (c.req.query('cursor') && (c.req.query('before') || c.req.query('history')))
        throw new InboxError('INVALID_REQUEST', 'Conflicting message cursors')
      if (c.req.query('history') && c.req.query('history') !== 'latest')
        throw new InboxError('INVALID_REQUEST', 'Invalid history direction')
      const page = await listFacebookMessages(db, {
        workspaceId: c.req.param('workspaceId'),
        userId: session.user.id,
        conversationId: c.req.param('conversationId'),
        after: decodeMessageCursor(c.req.query('cursor')),
        before: decodeMessageCursor(c.req.query('before')),
        latest: c.req.query('history') === 'latest',
      })
      return c.json({
        messages: page.messages,
        nextCursor: page.nextCursor
          ? encodeCursor({
              createdAt: page.nextCursor.createdAt,
              id: page.nextCursor.id,
            })
          : null,
        olderCursor: page.olderCursor ? encodeCursor(page.olderCursor) : null,
      })
    } catch (error) {
      return inboxErrorResponse(c, error)
    }
  })
})

app.post('/api/workspaces/:workspaceId/conversations/:conversationId/read', async (c) => {
  if (!hasAuthBindings(c.env)) return notReady(c)
  return withDatabase(c.env, async (db) => {
    const session = await createAuth(db, c.env).api.getSession({ headers: c.req.raw.headers })
    if (!session) return unauthorized(c)
    try {
      const input = z
        .object({ messageIds: z.array(z.string().uuid()).min(1).max(100) })
        .strict()
        .safeParse(await c.req.json().catch(() => null))
      if (!input.success) throw new InboxError('INVALID_REQUEST', 'Customer message IDs required')
      await acknowledgeConversationRead(db, {
        workspaceId: c.req.param('workspaceId'),
        userId: session.user.id,
        conversationId: c.req.param('conversationId'),
        ...input.data,
      })
      await publishInboxChange(
        c.env,
        c.req.param('workspaceId'),
        c.req.param('conversationId'),
        'conversation.changed',
      )
      return c.json({ acknowledged: true })
    } catch (error) {
      return inboxErrorResponse(c, error)
    }
  })
})

app.get('/api/workspaces/:workspaceId/attachments/:attachmentId', async (c) => {
  if (!hasAuthBindings(c.env)) return notReady(c)
  return withDatabase(c.env, async (db) => {
    const session = await createAuth(db, c.env).api.getSession({ headers: c.req.raw.headers })
    if (!session) return unauthorized(c)
    if (!c.env.OBJECTS) {
      return c.json(
        { error: { code: 'STORAGE_UNAVAILABLE', message: 'Attachment storage is unavailable' } },
        503,
      )
    }

    try {
      const storage = createObjectStorage(c.env.OBJECTS)
      const attachment = await getFacebookAttachmentForDownload(db, {
        workspaceId: c.req.param('workspaceId'),
        userId: session.user.id,
        attachmentId: c.req.param('attachmentId'),
      })
      const object = await storage.get(attachment.storageKey)
      if (!object?.body) throw new AttachmentError('NOT_FOUND', 'Attachment not found')

      const headers = new Headers({
        'Cache-Control': 'private, no-store',
        'Content-Disposition': contentDisposition(attachment.filename, attachment.kind),
        'Content-Type': safeContentType(attachment.mimeType),
        'X-Content-Type-Options': 'nosniff',
      })
      return new Response(object.body, { status: 200, headers })
    } catch (error) {
      return attachmentErrorResponse(c, error)
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
      const page = await listFacebookConversations(db, {
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

app.post('/api/workspaces/:workspaceId/conversations/:conversationId/transfer', async (c) => {
  if (!hasAuthBindings(c.env)) return notReady(c)
  return withDatabase(c.env, async (db) => {
    const session = await createAuth(db, c.env).api.getSession({ headers: c.req.raw.headers })
    if (!session) return unauthorized(c)
    const limited = await rateLimit(c, `conversation-transfer:${session.user.id}`)
    if (limited) return limited
    const input = transferInput.safeParse(await c.req.json().catch(() => null))
    if (!input.success) {
      return c.json({ error: { code: 'INVALID_REQUEST', message: 'Choose a member' } }, 400)
    }

    try {
      const result = await transferConversation(db, {
        workspaceId: c.req.param('workspaceId'),
        conversationId: c.req.param('conversationId'),
        actingUserId: session.user.id,
        ...input.data,
      })
      if (result.aiResponseRunId) await enqueueAiResponseJob(c.env, result.aiResponseRunId)
      await publishInboxChange(
        c.env,
        c.req.param('workspaceId'),
        result.conversationId,
        'conversation.changed',
      )
      const page = await listFacebookConversations(db, {
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

app.post('/api/workspaces/:workspaceId/conversations/:conversationId/unassign', async (c) => {
  if (!hasAuthBindings(c.env)) return notReady(c)
  return withDatabase(c.env, async (db) => {
    const session = await createAuth(db, c.env).api.getSession({ headers: c.req.raw.headers })
    if (!session) return unauthorized(c)
    const limited = await rateLimit(c, `conversation-unassign:${session.user.id}`)
    if (limited) return limited

    try {
      const result = await unassignConversation(db, {
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
      const page = await listFacebookConversations(db, {
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

app.post('/api/workspaces/:workspaceId/conversations/:conversationId/close', async (c) => {
  if (!hasAuthBindings(c.env)) return notReady(c)
  return withDatabase(c.env, async (db) => {
    const session = await createAuth(db, c.env).api.getSession({ headers: c.req.raw.headers })
    if (!session) return unauthorized(c)

    try {
      const result = await closeConversation(db, {
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
      return c.json({ conversation: null, changed: result.changed, closed: true })
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
      const created = await createFacebookHumanReply(db, {
        workspaceId: c.req.param('workspaceId'),
        conversationId: c.req.param('conversationId'),
        actingUserId: session.user.id,
        ...input.data,
      })
      await enqueueOutboundMessage(c.env, created.message.id)
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

app.post('/api/workspaces/:workspaceId/conversations/:conversationId/suggestions', async (c) => {
  if (!hasAuthBindings(c.env)) return notReady(c)
  return withDatabase(c.env, async (db) => {
    const session = await createAuth(db, c.env).api.getSession({ headers: c.req.raw.headers })
    if (!session) return unauthorized(c)
    const limited = await rateLimit(c, `suggestion:${session.user.id}`)
    if (limited) return limited
    const input = z
      .object({ id: z.string().uuid(), aiMemberId: z.string().uuid() })
      .strict()
      .safeParse(await c.req.json().catch(() => null))
    if (!input.success) return c.json({ error: { code: 'INVALID_REQUEST' } }, 400)
    const identity = {
      workspaceId: c.req.param('workspaceId'),
      conversationId: c.req.param('conversationId'),
      userId: session.user.id,
    }
    let operationId: string | undefined
    try {
      const record = await createReplySuggestion(db, { ...identity, ...input.data })
      const publicSuggestion = (value: typeof record) => ({
        id: value.id,
        inputMessageId: value.inputMessageId,
        aiMemberId: value.aiMemberId,
        text: value.suggestedText,
        chunkIds: value.chunkIds,
      })
      if (record.suggestedText) return c.json({ suggestion: publicSuggestion(record) })
      const context = await readReplySuggestionContext(db, { ...identity, id: record.id })
      operationId = record.id
      const fetcher = meteredAiFetch((work) => withDatabase(c.env, work), {
        id: record.id,
        workspaceId: identity.workspaceId,
        memberId: record.aiMemberId,
        kind: 'SUGGESTION',
        configVersionId: record.configVersionId,
        snapshot: record.snapshot,
        text: context.messages[0].text,
      })
      const embedding = createAlibabaEmbeddingProvider(
        {
          provider: c.env.EMBEDDING_PROVIDER,
          apiKey: c.env.AI_API_KEY,
          baseUrl: c.env.AI_BASE_URL,
          model: c.env.EMBEDDING_MODEL,
          dimensions: Number(c.env.EMBEDDING_DIMENSIONS),
        },
        fetcher,
      )
      const chunks = await retrieveKnowledgeChunks(db, embedding, c.env, {
        workspaceId: identity.workspaceId,
        knowledgeBaseId: record.snapshot.knowledgeBaseId,
        query: context.messages[0].text ?? '',
      })
      const llm = createAlibabaLlmProvider(
        {
          provider: c.env.LLM_PROVIDER,
          apiKey: c.env.AI_API_KEY,
          baseUrl: c.env.AI_BASE_URL,
          model: c.env.LLM_MODEL,
        },
        fetcher,
      )
      const decision = await llm.generateResponse({
        instructions: record.snapshot.instructions,
        variableInput: context.variableInput,
        now: new Date(context.variableInput.capturedAt),
        responseLanguage: record.snapshot.responseLanguage,
        timeZone: record.snapshot.timeZone,
        naturalToneEnabled: record.snapshot.naturalToneEnabled,
        messages: context.messages,
        history: context.history,
        knowledgeChunks: chunks,
      })
      const grounded = enforceGrounding(
        decision,
        chunks.map(({ id }) => id),
        record.snapshot,
      ).decision
      if (grounded.decision !== 'ANSWER' || decision.mediaAssetId || decision.handoffRuleId)
        throw new AIOutputError()
      const suggestion = await completeReplySuggestion(db, {
        ...identity,
        id: record.id,
        text: grounded.response,
        chunkIds: grounded.usedChunkIds,
        variableInput: context.variableInput,
      })
      await finishAiOperation(db, { operationId: record.id, state: 'COMPLETED' })
      return c.json({ suggestion: publicSuggestion(suggestion) })
    } catch (error) {
      if (error instanceof AiUsageError)
        return c.json({ error: { code: error.code, retryAfterMs: error.retryAfterMs } }, 409)
      if (operationId && !(error instanceof AIProviderError && error.retryable))
        await finishAiOperation(db, {
          operationId,
          state: 'FAILED',
          failureCode: 'SUGGESTION_FAILED',
        })
      if (
        error instanceof AIProviderError ||
        error instanceof AIOutputError ||
        error instanceof AIEmbeddingError
      )
        return c.json({ error: { code: 'SUGGESTION_UNAVAILABLE' } }, 502)
      return replyErrorResponse(c, error)
    }
  })
})

app.post('/api/workspaces/:workspaceId/conversations/:conversationId/translations', async (c) => {
  if (!hasAuthBindings(c.env)) return notReady(c)
  return withDatabase(c.env, async (db) => {
    const session = await createAuth(db, c.env).api.getSession({ headers: c.req.raw.headers })
    if (!session) return unauthorized(c)
    const limited = await rateLimit(c, `translation:${session.user.id}`)
    if (limited) return limited
    const input = z
      .object({
        id: z.string().uuid(),
        sourceMessageId: z.string().uuid().optional(),
        sourceText: z.string().trim().min(1).max(2000).optional(),
        sourceVersion: z.string().uuid(),
        targetLanguage: z.enum(TRANSLATION_LANGUAGES),
      })
      .strict()
      .refine((v) => Boolean(v.sourceMessageId) !== Boolean(v.sourceText))
      .safeParse(await c.req.json().catch(() => null))
    if (!input.success) return c.json({ error: { code: 'INVALID_REQUEST' } }, 400)
    const identity = {
      workspaceId: c.req.param('workspaceId'),
      conversationId: c.req.param('conversationId'),
      userId: session.user.id,
    }
    let operationId: string | undefined
    try {
      const record = await createMessageTranslation(db, { ...identity, ...input.data })
      if (record.translatedText) return c.json({ translation: record })
      operationId = record.id
      const provider = createAlibabaLlmProvider(
        {
          provider: c.env.LLM_PROVIDER,
          apiKey: c.env.AI_API_KEY,
          baseUrl: c.env.AI_BASE_URL,
          model: c.env.LLM_MODEL,
        },
        meteredAiFetch((work) => withDatabase(c.env, work), {
          id: record.id,
          workspaceId: identity.workspaceId,
          memberId: record.requesterMemberId,
          kind: 'TRANSLATION',
          text: record.sourceText,
        }),
      )
      const decision = await provider.generateResponse({
        purpose: 'TRANSLATION',
        instructions: '',
        responseLanguage: record.targetLanguage,
        messages: [{ id: record.id, text: record.sourceText }],
        history: [],
        knowledgeChunks: [],
      })
      if (
        decision.decision !== 'ANSWER' ||
        decision.handoffReason !== null ||
        decision.usedChunkIds.length ||
        decision.mediaAssetId ||
        decision.handoffRuleId ||
        decision.containsBusinessFacts
      )
        throw new AIOutputError()
      const translated = await completeMessageTranslation(db, {
        ...identity,
        id: record.id,
        text: decision.response,
      })
      await finishAiOperation(db, { operationId: record.id, state: 'COMPLETED' })
      return c.json({ translation: translated })
    } catch (error) {
      if (error instanceof AiUsageError)
        return c.json({ error: { code: error.code, retryAfterMs: error.retryAfterMs } }, 409)
      if (operationId && !(error instanceof AIProviderError && error.retryable))
        await finishAiOperation(db, {
          operationId,
          state: 'FAILED',
          failureCode: 'TRANSLATION_FAILED',
        })
      if (error instanceof AIProviderError || error instanceof AIOutputError)
        return c.json({ error: { code: 'TRANSLATION_FAILED' } }, 502)
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
    const limited = await rateLimit(c, `workspace-invitation:${session.user.id}`)
    if (limited) return limited

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

app.get('/api/invitations/:token', async (c) => {
  if (!hasAuthBindings(c.env)) return notReady(c)
  c.header('Cache-Control', 'no-store')
  const token = invitationTokenInput.safeParse(c.req.param('token'))
  if (!token.success) {
    return c.json({ error: { code: 'INVITATION_INVALID', message: 'Invitation is invalid' } }, 400)
  }

  try {
    const invitation = await withDatabase(c.env, (db) =>
      validateAnyInvitation(db, { token: token.data }),
    )
    return c.json({ invitation })
  } catch (error) {
    return memberErrorResponse(c, error)
  }
})

app.post('/api/invitations/accept', async (c) => {
  if (!hasAuthBindings(c.env)) return notReady(c)
  return withDatabase(c.env, async (db) => {
    const session = await createAuth(db, c.env).api.getSession({ headers: c.req.raw.headers })
    if (!session) return unauthorized(c)
    const limited = await rateLimit(c, `invitation-accept:${session.user.id}`)
    if (limited) return limited

    const input = invitationAcceptInput.safeParse(await c.req.json().catch(() => null))
    if (!input.success) {
      return c.json(
        { error: { code: 'INVITATION_INVALID', message: 'Invitation is invalid' } },
        400,
      )
    }

    try {
      const accepted = await acceptAnyInvitation(db, {
        token: input.data.token,
        userId: session.user.id,
        userEmail: session.user.email,
        userName: session.user.name,
      })
      if (accepted.type === 'WORKSPACE_CREATOR') {
        return c.json({ type: accepted.type })
      }
      await enqueueQueuedConversations(c.env, db, accepted.workspaceId)
      const [access] = await findAccesses(db, session.user.id, accepted.workspaceId)
      return c.json({ type: accepted.type, workspace: access, memberId: accepted.memberId })
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
    const limited = await rateLimit(c, `ai-trigger:${session.user.id}`)
    if (limited) return limited
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
      await enqueueQueuedConversations(c.env, db, c.req.param('workspaceId'))
      await publishMemberChange(c.env, c.req.param('workspaceId'), created.id)
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
    const limited = await rateLimit(c, `ai-trigger:${session.user.id}`)
    if (limited) return limited
    const input = memberUpdateInput.safeParse(await c.req.json().catch(() => null))
    if (!input.success) {
      return c.json(
        { error: { code: 'INVALID_REQUEST', message: 'Enter valid member settings' } },
        400,
      )
    }

    try {
      const updated = await updateMember(db, {
        workspaceId: c.req.param('workspaceId'),
        memberId: c.req.param('memberId'),
        actingUserId: session.user.id,
        ...input.data,
      })
      for (const conversationId of updated.requeuedConversationIds) {
        await publishInboxChange(
          c.env,
          c.req.param('workspaceId'),
          conversationId,
          'conversation.changed',
        )
      }
      await enqueueQueuedConversations(c.env, db, c.req.param('workspaceId'))
      await publishMemberChange(c.env, c.req.param('workspaceId'), c.req.param('memberId'))
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
    const limited = await rateLimit(c, `ai-trigger:${session.user.id}`)
    if (limited) return limited
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
      await enqueueQueuedConversations(c.env, db, c.req.param('workspaceId'))
      await publishMemberChange(c.env, c.req.param('workspaceId'), c.req.param('memberId'))
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

const customerProfileInput = z
  .object({
    expectedCustomerId: z.string().uuid(),
    expectedRevision: z.number().int().nonnegative(),
    displayName: z.string().trim().max(100).nullable().optional(),
    email: z.string().trim().email().max(254).nullable().optional(),
    phone: z.string().trim().max(50).nullable().optional(),
    preferredLanguage: z.string().trim().max(100).nullable().optional(),
    notes: z.string().max(2000).nullable().optional(),
    ownerMemberId: z.string().uuid().nullable().optional(),
  })
  .strict()

async function customerRequest(
  c: Context<{ Bindings: Bindings }>,
  work: (
    db: Database,
    input: { workspaceId: string; userId: string; conversationId: string },
  ) => Promise<unknown>,
) {
  if (!hasAuthBindings(c.env)) return notReady(c)
  const workspaceId = c.req.param('workspaceId') ?? ''
  const conversationId = c.req.param('conversationId') ?? ''
  if (
    !z.string().uuid().safeParse(workspaceId).success ||
    !z.string().uuid().safeParse(conversationId).success
  )
    return c.json({ error: { code: 'INVALID_REQUEST', message: 'Invalid identifier' } }, 400)
  return withDatabase(c.env, async (db) => {
    const session = await createAuth(db, c.env).api.getSession({ headers: c.req.raw.headers })
    if (!session) return unauthorized(c)
    if (c.req.method !== 'GET') {
      const limited = await rateLimit(c, `customer:${session.user.id}`)
      if (limited) return limited
    }
    try {
      const result = await work(db, { workspaceId, userId: session.user.id, conversationId })
      if (c.req.method !== 'GET')
        await publishInboxChange(c.env, workspaceId, conversationId, 'conversation.changed')
      return c.json(result as Record<string, unknown>)
    } catch (error) {
      if (!(error instanceof CustomerError)) throw error
      return c.json(
        { error: { code: error.code, message: error.message } },
        error.code === 'FORBIDDEN'
          ? 403
          : error.code === 'NOT_FOUND'
            ? 404
            : error.code === 'CONFLICT'
              ? 409
              : 400,
      )
    }
  })
}

app.get('/api/workspaces/:workspaceId/conversations/:conversationId/customer-profile', (c) =>
  customerRequest(c, getCustomerProfile),
)
app.get('/api/workspaces/:workspaceId/conversations/:conversationId/referrals', async (c) => {
  if (!hasAuthBindings(c.env)) return notReady(c)
  const ids = z
    .object({
      workspaceId: z.string().uuid(),
      conversationId: z.string().uuid(),
      before: z.string().uuid().optional(),
    })
    .safeParse({ ...c.req.param(), before: c.req.query('before') })
  if (!ids.success) return inboxErrorResponse(c, new InboxError('INVALID_REQUEST'))
  return withDatabase(c.env, async (db) => {
    const session = await createAuth(db, c.env).api.getSession({ headers: c.req.raw.headers })
    if (!session) return unauthorized(c)
    try {
      return c.json(await listFacebookReferrals(db, { ...ids.data, userId: session.user.id }))
    } catch (error) {
      return inboxErrorResponse(c, error)
    }
  })
})
app.patch('/api/workspaces/:workspaceId/conversations/:conversationId/customer-profile', (c) =>
  customerRequest(c, async (db, context) => {
    const parsed = customerProfileInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) throw new CustomerError('INVALID_REQUEST', 'Invalid customer profile')
    return updateCustomerProfile(db, { ...context, ...parsed.data })
  }),
)
app.post('/api/workspaces/:workspaceId/conversations/:conversationId/customer-memory/clear', (c) =>
  customerRequest(c, async (db, context) => {
    const input = z
      .object({
        expectedCustomerId: z.string().uuid(),
        expectedRevision: z.number().int().nonnegative(),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null))
    if (!input.success)
      throw new CustomerError('INVALID_REQUEST', 'Customer and memory revision required')
    return clearCustomerMemory(db, { ...context, ...input.data })
  }),
)

const propertyDefinitionInput = z
  .object({
    name: z.string().trim().min(1).max(100),
    level: z.enum(['CUSTOMER', 'CONVERSATION']),
    type: z.enum(['TEXT', 'NUMBER', 'OPTION']),
    options: z.array(z.string().trim().min(1).max(100)).max(50).default([]),
    maxLength: z.number().int().min(1).max(2000).default(2000),
    expectedRevision: z.number().int().nonnegative().optional(),
  })
  .strict()
app.get('/api/workspaces/:workspaceId/conversations/:conversationId/property-history', (c) =>
  customerRequest(c, (db, context) => {
    const before = c.req.query('before')
    if (before && !z.string().uuid().safeParse(before).success)
      throw new CustomerError('INVALID_REQUEST', 'Invalid cursor')
    return listCustomerPropertyHistory(db, { ...context, before })
  }),
)
const propertyValueInput = z
  .object({
    expectedCustomerId: z.string().uuid(),
    value: z.union([z.string().max(2000), z.number().finite(), z.null()]),
    expectedRevision: z.number().int().nonnegative(),
    allowAutomaticUpdate: z.boolean(),
  })
  .strict()
function customerParam(c: Context<{ Bindings: Bindings }>, name: string) {
  const parsed = z.string().uuid().safeParse(c.req.param(name))
  if (!parsed.success) throw new CustomerError('INVALID_REQUEST', 'Invalid identifier')
  return parsed.data
}
app.post('/api/workspaces/:workspaceId/conversations/:conversationId/property-definitions', (c) =>
  customerRequest(c, async (db, context) => {
    const parsed = propertyDefinitionInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) throw new CustomerError('INVALID_REQUEST', 'Invalid property definition')
    return savePropertyDefinition(db, { ...context, ...parsed.data })
  }),
)
app.patch(
  '/api/workspaces/:workspaceId/conversations/:conversationId/property-definitions/:definitionId',
  (c) =>
    customerRequest(c, async (db, context) => {
      const parsed = propertyDefinitionInput.safeParse(await c.req.json().catch(() => null))
      if (!parsed.success) throw new CustomerError('INVALID_REQUEST', 'Invalid property definition')
      return savePropertyDefinition(db, {
        ...context,
        ...parsed.data,
        definitionId: customerParam(c, 'definitionId'),
      })
    }),
)
app.get(
  '/api/workspaces/:workspaceId/conversations/:conversationId/property-definitions/:definitionId/dependencies',
  (c) =>
    customerRequest(c, (db, context) =>
      propertyDependencies(db, { ...context, definitionId: customerParam(c, 'definitionId') }),
    ),
)
app.delete(
  '/api/workspaces/:workspaceId/conversations/:conversationId/property-definitions/:definitionId',
  (c) =>
    customerRequest(c, (db, context) =>
      propertyDependencies(db, {
        ...context,
        definitionId: customerParam(c, 'definitionId'),
        remove: true,
      }),
    ),
)
app.put(
  '/api/workspaces/:workspaceId/conversations/:conversationId/properties/:definitionId',
  (c) =>
    customerRequest(c, async (db, context) => {
      const parsed = propertyValueInput.safeParse(await c.req.json().catch(() => null))
      if (!parsed.success) throw new CustomerError('INVALID_REQUEST', 'Invalid property value')
      return setCustomerProperty(db, {
        ...context,
        ...parsed.data,
        definitionId: customerParam(c, 'definitionId'),
      })
    }),
)

const customerTagInput = z
  .object({ name: z.string().trim().min(1).max(100), level: z.enum(['CUSTOMER', 'CONVERSATION']) })
  .strict()
app.post('/api/workspaces/:workspaceId/conversations/:conversationId/tag-definitions', (c) =>
  customerRequest(c, async (db, context) => {
    const parsed = customerTagInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) throw new CustomerError('INVALID_REQUEST', 'Invalid tag')
    return saveCustomerTagDefinition(db, { ...context, ...parsed.data })
  }),
)
app.patch(
  '/api/workspaces/:workspaceId/conversations/:conversationId/tag-definitions/:tagId',
  (c) =>
    customerRequest(c, async (db, context) => {
      const parsed = customerTagInput.safeParse(await c.req.json().catch(() => null))
      if (!parsed.success) throw new CustomerError('INVALID_REQUEST', 'Invalid tag')
      return saveCustomerTagDefinition(db, {
        ...context,
        ...parsed.data,
        tagId: customerParam(c, 'tagId'),
      })
    }),
)
app.delete(
  '/api/workspaces/:workspaceId/conversations/:conversationId/tag-definitions/:tagId',
  (c) =>
    customerRequest(c, (db, context) =>
      removeCustomerTagDefinition(db, { ...context, tagId: customerParam(c, 'tagId') }),
    ),
)
app.put('/api/workspaces/:workspaceId/conversations/:conversationId/tags/:tagId', (c) =>
  customerRequest(c, async (db, context) => {
    const parsed = z
      .object({ expectedCustomerId: z.string().uuid() })
      .strict()
      .safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) throw new CustomerError('INVALID_REQUEST', 'Customer identifier required')
    return setCustomerTag(db, { ...context, ...parsed.data, tagId: customerParam(c, 'tagId') })
  }),
)
app.delete('/api/workspaces/:workspaceId/conversations/:conversationId/tags/:tagId', (c) =>
  customerRequest(c, async (db, context) => {
    const parsed = z
      .object({ expectedCustomerId: z.string().uuid() })
      .strict()
      .safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) throw new CustomerError('INVALID_REQUEST', 'Customer identifier required')
    return setCustomerTag(db, {
      ...context,
      ...parsed.data,
      tagId: customerParam(c, 'tagId'),
      remove: true,
    })
  }),
)

const customerIdentityInput = z
  .object({
    targetCustomerId: z.string().uuid().nullable(),
    expectedCustomerId: z.string().uuid(),
    confirmed: z.literal(true).optional(),
  })
  .strict()
app.get('/api/workspaces/:workspaceId/conversations/:conversationId/customer-link-targets', (c) =>
  customerRequest(c, (db, context) => {
    const after = c.req.query('after')
    if (after && !z.string().uuid().safeParse(after).success)
      throw new CustomerError('INVALID_REQUEST', 'Invalid cursor')
    return listCustomerLinkTargets(db, { ...context, after })
  }),
)
app.post(
  '/api/workspaces/:workspaceId/conversations/:conversationId/identities/:identityId/preview',
  (c) =>
    customerRequest(c, async (db, context) => {
      const parsed = customerIdentityInput.safeParse(await c.req.json().catch(() => null))
      if (!parsed.success) throw new CustomerError('INVALID_REQUEST', 'Invalid identity link')
      return changeCustomerIdentity(db, {
        ...context,
        ...parsed.data,
        identityId: customerParam(c, 'identityId'),
        preview: true,
      })
    }),
)
app.put('/api/workspaces/:workspaceId/conversations/:conversationId/identities/:identityId', (c) =>
  customerRequest(c, async (db, context) => {
    const parsed = customerIdentityInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) throw new CustomerError('INVALID_REQUEST', 'Invalid identity link')
    return changeCustomerIdentity(db, {
      ...context,
      ...parsed.data,
      identityId: customerParam(c, 'identityId'),
    })
  }),
)

function hasApplicationBindings(env: Bindings): boolean {
  return Boolean(
    hasAuthBindings(env) &&
      isConfigured(env.META_APP_ID) &&
      isConfigured(env.META_APP_SECRET) &&
      isConfigured(env.META_VERIFY_TOKEN) &&
      isConfigured(env.META_GRAPH_API_VERSION) &&
      isValidTokenEncryptionKey(env.TOKEN_ENCRYPTION_KEY) &&
      isConfigured(env.AI_API_KEY) &&
      isConfigured(env.AI_BASE_URL) &&
      env.EMBEDDING_PROVIDER === ALIBABA_EMBEDDING_PROVIDER &&
      isConfigured(env.EMBEDDING_MODEL) &&
      env.EMBEDDING_MODEL === DEFAULT_EMBEDDING_MODEL &&
      isConfigured(env.EMBEDDING_DIMENSIONS) &&
      env.EMBEDDING_DIMENSIONS === String(EMBEDDING_DIMENSIONS) &&
      env.LLM_PROVIDER === ALIBABA_LLM_PROVIDER &&
      isConfigured(env.LLM_MODEL) &&
      env.AI_DEBOUNCE_SECONDS === '2' &&
      env.WEBHOOKS_QUEUE &&
      env.OUTBOUND_QUEUE &&
      env.AI_QUEUE &&
      env.DOCUMENTS_QUEUE &&
      env.MAINTENANCE_QUEUE &&
      env.JOBS_DLQ &&
      env.OBJECTS &&
      env.WORKSPACE_REALTIME,
  )
}

function hasFacebookBindings(env: Bindings): boolean {
  return Boolean(
    hasAuthBindings(env) &&
      isConfigured(env.META_APP_ID) &&
      isConfigured(env.META_APP_SECRET) &&
      isConfigured(env.META_GRAPH_API_VERSION) &&
      isValidTokenEncryptionKey(env.TOKEN_ENCRYPTION_KEY),
  )
}

function hasAuthBindings(env: Bindings): boolean {
  return Boolean(
    isUsableAppUrl(env.APP_URL) &&
      env.AUTH_RATE_LIMITER &&
      isConfigured(env.BETTER_AUTH_SECRET) &&
      env.HYPERDRIVE?.connectionString,
  )
}

function isConfigured(value: string | undefined) {
  const normalized = value?.trim() ?? ''
  return Boolean(normalized) && !/(replace-with|your-|choose-a-)/i.test(normalized)
}

function isUsableAppUrl(value: string | undefined) {
  if (!isConfigured(value)) return false
  try {
    const url = new URL(value as string)
    return url.protocol === 'https:' || url.hostname === 'localhost' || url.hostname === '127.0.0.1'
  } catch {
    return false
  }
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

function invitationRequired(c: Context<{ Bindings: Bindings }>) {
  return c.json(
    {
      error: {
        code: 'INVITATION_REQUIRED',
        message: 'Registration is currently invitation only.',
      },
    },
    403,
  )
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

function isEmailSignupPath(path: string) {
  return path.replace(/\/+$/, '').endsWith('/sign-up/email')
}

function isEmailSignInPath(path: string) {
  return path.replace(/\/+$/, '').endsWith('/sign-in/email')
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
    return cursor.data
  } catch {
    throw new InboxError('INVALID_REQUEST', 'Invalid conversation cursor')
  }
}

function decodeMessageCursor(value: string | undefined) {
  if (!value) return undefined
  try {
    const cursor = messageCursorInput.safeParse(JSON.parse(decodeCursorValue(value)))
    if (!cursor.success) throw new Error('invalid cursor')
    return cursor.data
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
    error.code === 'FORBIDDEN' ||
    error.code === 'INVITATION_EMAIL_MISMATCH' ||
    error.code === 'WORKSPACE_SETUP_REQUIRED'
      ? 403
      : error.code === 'NOT_FOUND'
        ? 404
        : error.code === 'ALREADY_MEMBER' ||
            error.code === 'INVITATION_USED' ||
            error.code === 'WORKSPACE_ALREADY_EXISTS'
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

function knowledgeErrorResponse(c: Context<{ Bindings: Bindings }>, error: unknown) {
  if (!(error instanceof KnowledgeError)) throw error
  const status =
    error.code === 'FORBIDDEN'
      ? 403
      : error.code === 'NOT_FOUND'
        ? 404
        : error.code === 'CONFLICT'
          ? 409
          : 400
  return c.json({ error: { code: error.code, message: error.message } }, status)
}

function aiMemberErrorResponse(c: Context<{ Bindings: Bindings }>, error: unknown) {
  if (!(error instanceof AiMemberError)) throw error
  const status = error.code === 'FORBIDDEN' ? 403 : error.code === 'NOT_FOUND' ? 404 : 400
  return c.json({ error: { code: error.code, message: error.message } }, status)
}

function attachmentErrorResponse(c: Context<{ Bindings: Bindings }>, error: unknown) {
  if (!(error instanceof AttachmentError)) throw error
  return c.json(
    { error: { code: error.code, message: error.message } },
    error.code === 'FORBIDDEN' ? 403 : 404,
  )
}

function contentDisposition(filename: string | null, kind: string) {
  const fallback = `${kind.toLowerCase()}-attachment`
  const safeName =
    Array.from(filename ?? fallback, (character) =>
      character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 || '"\\/'.includes(character)
        ? '_'
        : character,
    )
      .join('')
      .trim()
      .slice(0, 180) || fallback
  const disposition = kind === 'IMAGE' ? 'inline' : 'attachment'
  return `${disposition}; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(safeName)}`
}

function displayFileName(filename: string) {
  return filename.split(/[\\/]/).pop()?.trim() || 'Uploaded document'
}

function safeContentType(value: string | null) {
  return safeMimeType(value) ?? 'application/octet-stream'
}

function assignmentErrorResponse(c: Context<{ Bindings: Bindings }>, error: unknown) {
  if (!(error instanceof AssignmentError)) throw error
  const status =
    error.code === 'FORBIDDEN'
      ? 403
      : error.code === 'NOT_FOUND'
        ? 404
        : error.code === 'ALREADY_ASSIGNED' ||
            error.code === 'CONVERSATION_CLOSED' ||
            error.code === 'TRANSFER_CONFIRMATION_REQUIRED'
          ? 409
          : 400
  return c.json({ error: { code: error.code, message: error.message } }, status)
}

function replyErrorResponse(c: Context<{ Bindings: Bindings }>, error: unknown) {
  if (error instanceof InboxError) return inboxErrorResponse(c, error)
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
  const body = await readLimitedRequestBody(c.req.raw, MAX_FACEBOOK_WEBHOOK_BODY_BYTES)
  if (!body) return c.text('Payload Too Large', 413)
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

  let events: ReturnType<typeof normalizeFacebookWebhook>
  let receiptEvents: ReturnType<typeof normalizeFacebookReceipts>
  let referralEvents: ReturnType<typeof normalizeFacebookReferrals>
  try {
    events = normalizeFacebookWebhook(payload)
    receiptEvents = normalizeFacebookReceipts(payload)
    referralEvents = normalizeFacebookReferrals(payload)
    if (events.length + receiptEvents.length + referralEvents.length > MAX_FACEBOOK_WEBHOOK_EVENTS)
      throw new FacebookWebhookPayloadError('TOO_MANY_EVENTS')
  } catch (error) {
    if (error instanceof FacebookWebhookPayloadError) return c.text('Payload Too Large', 413)
    throw error
  }
  if (!events.length && !receiptEvents.length && !referralEvents.length)
    return c.text('EVENT_RECEIVED')

  const queue = c.env.WEBHOOKS_QUEUE ? createJobQueue(c.env.WEBHOOKS_QUEUE) : undefined
  if (!queue) {
    return c.json(
      { error: { code: 'QUEUE_UNAVAILABLE', message: 'Webhook queue is unavailable' } },
      503,
    )
  }

  const receivedAt = new Date()
  const payloadSha256 = await sha256Hex(body)
  let encryptedEvents: Awaited<ReturnType<typeof encryptFacebookAttachmentSources>>[]
  try {
    encryptedEvents = await Promise.all(
      events.map((event) =>
        encryptFacebookAttachmentSources(event, c.env.TOKEN_ENCRYPTION_KEY, receivedAt),
      ),
    )
  } catch {
    console.error(JSON.stringify({ event: 'attachment_source_encryption_failed' }))
    return c.json(
      { error: { code: 'ATTACHMENT_UNAVAILABLE', message: 'Attachment intake is unavailable' } },
      503,
    )
  }
  const jobs = encryptedEvents.map((event) =>
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
    await Promise.all([
      ...jobs.map((job) => queue.send(job.data)),
      ...receiptEvents.map((event) =>
        queue.send(facebookReceiptJobSchema.parse({ v: 1, type: 'facebook.receipt', event })),
      ),
      ...referralEvents.map((event) =>
        queue.send(
          facebookReferralJobSchema.parse({
            v: 1,
            type: 'facebook.referral',
            receivedAt: receivedAt.toISOString(),
            event,
          }),
        ),
      ),
    ])
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

async function readLimitedRequestBody(request: Request, maxBytes: number) {
  const contentLength = Number(request.headers.get('content-length'))
  if (Number.isFinite(contentLength) && contentLength > maxBytes) return null
  if (!request.body) return new ArrayBuffer(0)

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let byteLength = 0
  try {
    while (true) {
      const result = await reader.read()
      if (result.done) break
      byteLength += result.value.byteLength
      if (byteLength > maxBytes) {
        await reader.cancel().catch(() => {})
        return null
      }
      chunks.push(result.value)
    }
  } finally {
    reader.releaseLock()
  }

  const body = new Uint8Array(byteLength)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body.buffer
}

async function sha256Hex(body: ArrayBuffer) {
  const digest = await crypto.subtle.digest('SHA-256', body)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function enqueueAttachmentJobs(queue: JobQueue | undefined, attachmentIds: string[]) {
  if (!attachmentIds.length) return
  if (!queue) {
    console.warn(
      JSON.stringify({ event: 'attachment_queue_unavailable', attachments: attachmentIds.length }),
    )
    return
  }
  try {
    await Promise.all(
      attachmentIds.map((attachmentId) =>
        queue.send({ v: 1, type: 'facebook.attachment', attachmentId }),
      ),
    )
  } catch {
    console.warn(
      JSON.stringify({ event: 'attachment_queue_failed', attachments: attachmentIds.length }),
    )
  }
}

async function enqueueKnowledgeDocumentJob(queue: Queue | undefined, documentId: string) {
  if (!queue) return
  try {
    await createJobQueue(queue).send({ v: 1, type: 'knowledge.document', documentId })
  } catch {
    console.warn(JSON.stringify({ event: 'knowledge_queue_failed', documentId }))
  }
}

async function enqueueAiResponseJob(env: Bindings, runId: string) {
  if (!env.AI_QUEUE) {
    console.warn(JSON.stringify({ event: 'ai_queue_unavailable', runId }))
    return
  }
  try {
    await createJobQueue(env.AI_QUEUE).send({ v: 1, type: 'ai.response', runId })
  } catch {
    console.warn(JSON.stringify({ event: 'ai_queue_failed', runId }))
  }
}

async function enqueueOutboundMessage(env: Bindings, messageId: string) {
  if (!env.OUTBOUND_QUEUE) return
  try {
    await createJobQueue(env.OUTBOUND_QUEUE).send({
      v: 1,
      type: 'facebook.outbound',
      messageId,
    })
  } catch {
    console.warn(JSON.stringify({ event: 'outbound_queue_failed', messageId }))
  }
}

async function enqueueMaintenanceJobs(
  env: Bindings,
  conversations: Array<{ workspaceId: string; conversationId: string }>,
) {
  if (!conversations.length || !env.MAINTENANCE_QUEUE) return
  try {
    const queue = createJobQueue(env.MAINTENANCE_QUEUE)
    await Promise.all(
      conversations.map(({ workspaceId, conversationId }) =>
        queue.send({ v: 1, type: 'routing.conversation', workspaceId, conversationId }),
      ),
    )
  } catch {
    console.warn(JSON.stringify({ event: 'maintenance_queue_failed' }))
  }
}

async function enqueueQueuedConversations(env: Bindings, db: Database, workspaceId?: string) {
  await enqueueMaintenanceJobs(env, await listQueuedConversationIds(db, { workspaceId }))
}

async function publishKnowledgeChange(env: Bindings, workspaceId: string, documentId: string) {
  try {
    await publishRealtime(env.WORKSPACE_REALTIME, workspaceId, {
      type: 'knowledge.changed',
      entityId: documentId,
    })
  } catch {
    console.warn(JSON.stringify({ event: 'realtime_publish_failed', type: 'knowledge.changed' }))
  }
}

async function publishMemberChange(env: Bindings, workspaceId: string, memberId: string) {
  try {
    await publishRealtime(env.WORKSPACE_REALTIME, workspaceId, {
      type: 'member.changed',
      entityId: memberId,
    })
  } catch {
    console.warn(JSON.stringify({ event: 'realtime_publish_failed', type: 'member.changed' }))
  }
}

export async function handleWebhookBatch(batch: MessageBatch<unknown>, env: Bindings) {
  const documentsQueue = env.DOCUMENTS_QUEUE ? createJobQueue(env.DOCUMENTS_QUEUE) : undefined
  for (const message of batch.messages) {
    const referral = facebookReferralJobSchema.safeParse(message.body)
    if (referral.success) {
      try {
        const changed = await withDatabase(env, (db) =>
          processFacebookReferral(db, {
            ...referral.data.event,
            receivedAt: new Date(referral.data.receivedAt),
          }),
        )
        if (changed)
          for (const id of changed.conversationIds)
            await publishInboxChange(env, changed.workspaceId, id, 'conversation.changed')
        message.ack()
      } catch {
        message.retry()
      }
      continue
    }
    const receipt = facebookReceiptJobSchema.safeParse(message.body)
    if (receipt.success) {
      try {
        const changed = await withDatabase(env, (db) =>
          processFacebookReceipt(db, receipt.data.event),
        )
        if (changed)
          for (const id of changed.conversationIds)
            await publishInboxChange(env, changed.workspaceId, id, 'message.changed')
        message.ack()
      } catch {
        message.retry()
      }
      continue
    }
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
          attachments: job.data.event.attachments.map((attachment) => ({
            kind: attachment.kind,
            filename: attachment.filename,
            mimeType: attachment.mimeType,
            encryptedSourceUrl: attachment.encryptedSourceUrl,
            urlIv: attachment.urlIv,
            tokenKeyVersion: attachment.tokenKeyVersion,
            expiresAt: new Date(attachment.expiresAt),
          })),
          providerSentAt: job.data.event.providerSentAt
            ? new Date(job.data.event.providerSentAt)
            : null,
          receivedAt: new Date(job.data.receivedAt),
          payloadSha256: job.data.payloadSha256,
          eventFragment: job.data.event.eventFragment,
        }),
      )
      if (result.kind === 'created' || result.kind === 'duplicate-message') {
        await enqueueAttachmentJobs(documentsQueue, result.attachmentIds)
        const routing = await withDatabase(env, (db) =>
          autoAssignConversation(db, {
            workspaceId: result.workspaceId,
            conversationId: result.conversationId,
          }),
        )
        if (result.kind === 'created' || routing.changed) {
          await publishInboxChange(
            env,
            result.workspaceId,
            result.conversationId,
            'conversation.changed',
          )
        }
        if (result.kind === 'created' && result.aiResponseRunId) {
          await enqueueAiResponseJob(env, result.aiResponseRunId)
        }
        if (routing.aiResponseRunId) await enqueueAiResponseJob(env, routing.aiResponseRunId)
      }
      message.ack()
    } catch {
      console.error(JSON.stringify({ event: 'webhook_processing_failed' }))
      message.retry()
    }
  }
}

export async function handleAiResponseBatch(batch: MessageBatch<unknown>, env: Bindings) {
  for (const queueMessage of batch.messages) {
    const job = aiResponseJobSchema.safeParse(queueMessage.body)
    if (!job.success) {
      queueMessage.ack()
      continue
    }

    let claimed: Awaited<ReturnType<typeof claimAiResponseRun>>
    try {
      claimed = await withDatabase(env, (db) => claimAiResponseRun(db, { runId: job.data.runId }))
    } catch {
      queueMessage.retry()
      continue
    }
    if (!claimed) {
      queueMessage.ack()
      continue
    }
    if (claimed.kind === 'DELAYED') {
      queueMessage.retry({ delaySeconds: Math.max(1, Math.ceil(claimed.retryAfterMs / 1_000)) })
      continue
    }
    if (claimed.kind === 'CANCELLED') {
      if (claimed.aiResponseRunId) await enqueueAiResponseJob(env, claimed.aiResponseRunId)
      await publishInboxChange(
        env,
        claimed.workspaceId,
        claimed.conversationId,
        'conversation.changed',
      )
      queueMessage.ack()
      continue
    }

    await publishInboxChange(
      env,
      claimed.workspaceId,
      claimed.conversationId,
      'conversation.changed',
    )
    let snapshot: ReturnType<typeof aiMemberRuntimeSnapshotSchema.parse> | null = null
    try {
      const parsedSnapshot = aiMemberRuntimeSnapshotSchema.safeParse(claimed.publishedSnapshot)
      if (!parsedSnapshot.success) throw new AIOutputError()
      const currentSnapshot = {
        ...parsedSnapshot.data,
        responseLanguage:
          parsedSnapshot.data.automaticLanguageEnabled && claimed.replyLanguage
            ? claimed.replyLanguage
            : parsedSnapshot.data.responseLanguage,
      }
      snapshot = currentSnapshot

      const configuredReason = detectConfiguredHandoff(
        claimed.followUp ? [] : claimed.inputMessages,
        currentSnapshot,
      )
      if (configuredReason) {
        await completeAiHandoff(env, claimed, {
          reason: configuredReason,
          noticeText: handoffNotice(currentSnapshot.responseLanguage),
          failureCode: configuredReason,
          failureMessage: 'Configured handoff trigger matched',
        })
        queueMessage.ack()
        continue
      }

      const inputMessages = (claimed.followUp ? [] : claimed.inputMessages)
        .filter(({ text }) => Boolean(text?.trim()))
        .map(({ id, text }) => ({ id, text: text as string }))
      const inputSize = inputMessages.reduce((sum, { text }) => sum + Array.from(text).length, 0)
      let handoffEvaluation:
        | { rules: { id: string; revision: number }[]; matchedRuleId: string | null }
        | undefined
      let customerRequestChecked = false
      const commitReply = async (input: Parameters<typeof commitAiResponse>[1]) => {
        for (let checks = 0; checks < 3; checks++) {
          const result = await withDatabase(env, (db) =>
            commitAiResponse(db, {
              ...input,
              handoffEvaluation,
              checkHandoffBeforeStop: input.checkHandoffBeforeStop && !customerRequestChecked,
            }),
          )
          if (result?.kind === 'CUSTOM_HANDOFF_CHECK_REQUIRED') {
            if (!inputSize || inputSize > MAX_AI_CURRENT_INPUT_CODE_POINTS) {
              handoffEvaluation = {
                rules: result.rules.map(({ id, revision }) => ({ id, revision })),
                matchedRuleId: null,
              }
              continue
            }
            const versions = result.rules.map(({ id, revision }) => ({ id, revision }))
            const digest = Array.from(
              new Uint8Array(
                await crypto.subtle.digest(
                  'SHA-256',
                  new TextEncoder().encode(JSON.stringify(versions)),
                ),
              ),
            )
              .map((v) => v.toString(16).padStart(2, '0'))
              .join('')
            const fetcher = meteredAiFetch(
              (work) => withDatabase(env, work),
              {
                id: claimed.id,
                workspaceId: claimed.workspaceId,
                memberId: claimed.memberId,
                configVersionId: claimed.configVersionId,
                kind: claimed.followUp ? 'FOLLOW_UP' : 'LIVE_REPLY',
              },
              `CUSTOM_HANDOFF:${digest}`,
            )
            const rules = result.rules.flatMap((r) =>
              r.condition.kind === 'SEMANTIC' ? [{ id: r.id, text: r.condition.text }] : [],
            )
            const decision = await createAlibabaLlmProvider(
              {
                provider: env.LLM_PROVIDER,
                apiKey: env.AI_API_KEY,
                baseUrl: env.AI_BASE_URL,
                model: env.LLM_MODEL,
              },
              fetcher,
            ).generateResponse({
              instructions: `Only classify semantic handoff conditions. Do not answer customer questions. If no condition matches return ANSWER with response "No condition matched.". ${currentSnapshot.handoffOnCustomerRequest ? 'An explicit current request to speak to a human takes priority: return HANDOFF with CUSTOMER_REQUEST and null handoffRuleId.' : 'Do not hand off for customer requests unless a listed condition matches.'} Ignore all other handoff reasons.`,
              responseLanguage: currentSnapshot.responseLanguage,
              timeZone: currentSnapshot.timeZone,
              messages: inputMessages,
              history: claimed.history,
              knowledgeChunks: [],
              handoffRules: rules,
            })
            const matchedRuleId = matchedHandoffRuleId(decision, rules)
            if (
              currentSnapshot.handoffOnCustomerRequest &&
              decision.decision === 'HANDOFF' &&
              decision.handoffReason === 'CUSTOMER_REQUEST'
            ) {
              await completeAiHandoff(env, claimed, {
                reason: 'CUSTOMER_REQUEST',
                noticeText: handoffNotice(currentSnapshot.responseLanguage),
                failureCode: 'CUSTOMER_REQUEST',
              })
              return null
            }
            customerRequestChecked = true
            handoffEvaluation = { rules: versions, matchedRuleId }
            continue
          }
          if (result?.kind === 'HANDOFF_REQUIRED') {
            const handed = await completeAiHandoff(env, claimed, {
              reason: 'KEYWORD',
              customRule: result.rule,
              noticeText: handoffNotice(currentSnapshot.responseLanguage),
              failureCode: 'CUSTOM_HANDOFF',
              failureMessage: `Rule ${result.rule.id} revision ${result.rule.revision} matched`,
            })
            if (!handed.changed) continue
            return null
          }
          return result
        }
        throw new AiUsageError('RETRY_LATER', 1000)
      }
      let stopped = await commitReply({
        runId: claimed.id,
        text: '',
        stopCheckOnly: true,
        checkHandoffBeforeStop:
          currentSnapshot.handoffOnCustomerRequest &&
          inputSize > 0 &&
          inputSize <= MAX_AI_CURRENT_INPUT_CODE_POINTS,
      })
      if (stopped?.kind === 'HANDOFF_CHECK_REQUIRED') {
        const handoffFetch = meteredAiFetch(
          (work) => withDatabase(env, work),
          {
            id: claimed.id,
            workspaceId: claimed.workspaceId,
            memberId: claimed.memberId,
            configVersionId: claimed.configVersionId,
            kind: claimed.followUp ? 'FOLLOW_UP' : 'LIVE_REPLY',
          },
          'STOP_HANDOFF',
        )
        const handoffDecision = await createAlibabaLlmProvider(
          {
            provider: env.LLM_PROVIDER,
            apiKey: env.AI_API_KEY,
            baseUrl: env.AI_BASE_URL,
            model: env.LLM_MODEL,
          },
          handoffFetch,
        ).generateResponse({
          instructions:
            'The AI is stopped. Only determine whether the CURRENT customer messages explicitly ask to talk to a human member of the team. If so return HANDOFF with CUSTOMER_REQUEST. Otherwise return ANSWER with response "Stopped.". Do not answer questions or hand off for any other reason. Do not include business facts, knowledge citations or media.',
          responseLanguage: currentSnapshot.responseLanguage,
          timeZone: currentSnapshot.timeZone,
          messages: inputMessages,
          history: claimed.history,
          knowledgeChunks: [],
        })
        if (
          handoffDecision.decision === 'HANDOFF' &&
          handoffDecision.handoffReason === 'CUSTOMER_REQUEST'
        ) {
          await withDatabase(env, (db) =>
            finishAiOperation(db, { operationId: claimed.id, state: 'COMPLETED' }),
          )
          await completeAiHandoff(env, claimed, {
            reason: 'CUSTOMER_REQUEST',
            noticeText: handoffNotice(currentSnapshot.responseLanguage),
            failureCode: 'CUSTOMER_REQUEST',
            failureMessage: 'Customer requested human support while AI stopped',
          })
          queueMessage.ack()
          continue
        }
        stopped = await commitReply({ runId: claimed.id, text: '', stopCheckOnly: true })
      }
      if (stopped?.kind !== 'CONTINUE') {
        await withDatabase(env, (db) =>
          finishAiOperation(db, { operationId: claimed.id, state: 'COMPLETED' }),
        )
        await publishAiReplyResult(env, claimed, stopped)
        queueMessage.ack()
        continue
      }

      if (inputSize > MAX_AI_CURRENT_INPUT_CODE_POINTS) {
        await completeAiHandoff(env, claimed, {
          reason: 'UNABLE_TO_ANSWER',
          noticeText: handoffNotice(currentSnapshot.responseLanguage),
          failureCode: 'AI_INPUT_LIMIT',
          failureMessage: 'Current input exceeds the supported context budget',
        })
        queueMessage.ack()
        continue
      }
      if (!inputMessages.length && !claimed.followUp) {
        let result = await commitReply({ runId: claimed.id, text: '', unparsedInput: true })
        if (result?.kind === 'UNPARSED_FALLBACK_REQUIRED') {
          const fallbackFetch = meteredAiFetch(
            (work) => withDatabase(env, work),
            {
              id: claimed.id,
              workspaceId: claimed.workspaceId,
              memberId: claimed.memberId,
              configVersionId: claimed.configVersionId,
              kind: claimed.followUp ? 'FOLLOW_UP' : 'LIVE_REPLY',
            },
            'UNPARSED_FALLBACK',
          )
          const translated = await createAlibabaLlmProvider(
            {
              provider: env.LLM_PROVIDER,
              apiKey: env.AI_API_KEY,
              baseUrl: env.AI_BASE_URL,
              model: env.LLM_MODEL,
            },
            fallbackFetch,
          ).generateResponse({
            purpose: 'TRANSLATION',
            history: [],
            instructions: '',
            responseLanguage: currentSnapshot.automaticLanguageEnabled
              ? (claimed.replyLanguage ?? currentSnapshot.responseLanguage)
              : currentSnapshot.responseLanguage,
            messages: [{ id: claimed.inputLastMessageId, text: result.text }],
            knowledgeChunks: [],
          })
          if (
            translated.decision !== 'ANSWER' ||
            translated.handoffReason !== null ||
            translated.containsBusinessFacts ||
            translated.usedChunkIds.length ||
            translated.mediaAssetId ||
            translated.handoffRuleId ||
            translated.languageSelection ||
            translated.collectedProperties?.length
          )
            throw new AIOutputError()
          result = await commitReply({
            runId: claimed.id,
            text: translated.response,
            unparsedInput: true,
          })
        }
        await withDatabase(env, (db) =>
          finishAiOperation(db, { operationId: claimed.id, state: 'COMPLETED' }),
        )
        await publishAiReplyResult(env, claimed, result)
        queueMessage.ack()
        continue
      }

      const advertisingContext = await withDatabase(env, (db) =>
        getAiFacebookAdvertisingContext(db, {
          workspaceId: claimed.workspaceId,
          runId: claimed.id,
        }),
      )
      const meteredFetch = meteredAiFetch((work) => withDatabase(env, work), {
        id: claimed.id,
        workspaceId: claimed.workspaceId,
        memberId: claimed.memberId,
        configVersionId: claimed.configVersionId,
        kind: claimed.followUp ? 'FOLLOW_UP' : 'LIVE_REPLY',
      })
      const embeddingProvider = createAlibabaEmbeddingProvider(
        {
          provider: env.EMBEDDING_PROVIDER,
          apiKey: env.AI_API_KEY,
          baseUrl: env.AI_BASE_URL,
          model: env.EMBEDDING_MODEL,
          dimensions: env.EMBEDDING_DIMENSIONS,
        },
        meteredFetch,
      )
      let retrievedChunks: Awaited<ReturnType<typeof retrieveKnowledgeChunks>> = []
      try {
        retrievedChunks = await withDatabase(env, (db) =>
          retrieveKnowledgeChunks(db, embeddingProvider, env, {
            workspaceId: claimed.workspaceId,
            knowledgeBaseId: currentSnapshot.knowledgeBaseId,
            query: [
              ...claimed.history.map(({ origin, text }) => `${origin}: ${text}`),
              ...inputMessages.map(({ text }) => text),
              ...(advertisingContext.status === 'MAPPED' ? [advertisingContext.content ?? ''] : []),
            ].join('\n'),
          }),
        )
      } catch (error) {
        if (
          !(
            error instanceof KnowledgeError && ['NOT_FOUND', 'INVALID_REQUEST'].includes(error.code)
          )
        ) {
          throw error
        }
      }

      const retrievedChunkIds = retrievedChunks.map(({ id }) => id)
      const recorded = await withDatabase(env, (db) =>
        recordAiResponseRetrievedChunks(db, { runId: claimed.id, chunkIds: retrievedChunkIds }),
      )
      if (!recorded) {
        queueMessage.ack()
        continue
      }

      const llmProvider = createAlibabaLlmProvider(
        {
          provider: env.LLM_PROVIDER,
          apiKey: env.AI_API_KEY,
          baseUrl: env.AI_BASE_URL,
          model: env.LLM_MODEL,
        },
        meteredFetch,
      )
      const decision = await llmProvider.generateResponse({
        automaticLanguageEnabled: currentSnapshot.automaticLanguageEnabled,
        establishedLanguage: currentSnapshot.automaticLanguageEnabled
          ? claimed.replyLanguage
          : null,
        timeZone: currentSnapshot.timeZone,
        naturalToneEnabled: currentSnapshot.naturalToneEnabled,
        proactiveEvent: claimed.followUp,
        customerMemoryInput: claimed.customerMemoryInput,
        propertyRules: claimed.propertyCollection.rules,
        tagRules: claimed.tagCollection.rules,
        variableInput: claimed.variableInput,
        now: new Date(claimed.variableInput.capturedAt),
        instructions: currentSnapshot.instructions,
        responseLanguage: currentSnapshot.responseLanguage,
        messages: inputMessages,
        history: claimed.history,
        advertisingContext,
        knowledgeChunks: retrievedChunks,
      })
      const replyConfig = {
        ...currentSnapshot,
        responseLanguage: currentSnapshot.automaticLanguageEnabled
          ? (decision.languageSelection?.language ?? currentSnapshot.responseLanguage)
          : currentSnapshot.responseLanguage,
      }
      const grounded = enforceGrounding(decision, retrievedChunkIds, replyConfig, retrievedChunks)
      const policy = applyHandoffPolicy(grounded.decision, replyConfig)
      if (policy.kind === 'HANDOFF') {
        await withDatabase(env, (db) =>
          finishAiOperation(db, { operationId: claimed.id, state: 'COMPLETED' }),
        )
        await completeAiHandoff(env, claimed, {
          reason: policy.decision.handoffReason ?? 'UNABLE_TO_ANSWER',
          noticeText: handoffNotice(currentSnapshot.responseLanguage),
          failureCode:
            grounded.kind === 'HANDOFF' && grounded.decision.decision === 'HANDOFF'
              ? grounded.decision.handoffReason === 'NO_KNOWLEDGE'
                ? 'NO_KNOWLEDGE'
                : 'MODEL_HANDOFF'
              : 'GROUNDING_FAILED',
          failureMessage:
            grounded.kind === 'HANDOFF' && grounded.decision.decision === 'HANDOFF'
              ? 'AI requested human handoff'
              : 'AI response was not grounded in published knowledge',
        })
        queueMessage.ack()
        continue
      }

      const result = await commitReply({
        runId: claimed.id,
        text: policy.decision.response,
        mediaAssetId: 'mediaAssetId' in policy.decision ? policy.decision.mediaAssetId : undefined,
        languageSelection: currentSnapshot.automaticLanguageEnabled
          ? decision.languageSelection
          : undefined,
        collectedProperties: decision.collectedProperties,
        appendedTags: decision.appendedTags,
      })
      await withDatabase(env, (db) =>
        finishAiOperation(db, { operationId: claimed.id, state: 'COMPLETED' }),
      )
      await publishAiReplyResult(env, claimed, result)
      queueMessage.ack()
    } catch (error) {
      if (error instanceof AiUsageError && error.code === 'RETRY_LATER') {
        await withDatabase(env, (db) => retryAiResponseRun(db, { runId: claimed.id }))
        queueMessage.retry({ delaySeconds: Math.max(1, Math.ceil(error.retryAfterMs / 1_000)) })
        continue
      }
      if (error instanceof AiUsageError) {
        await completeAiHandoff(env, claimed, {
          reason: 'PROVIDER_FAILURE',
          failureCode: error.code,
          failureMessage: 'AI usage unavailable; human assistance required',
          noticeText: handoffNotice(snapshot?.responseLanguage ?? 'English'),
        })
        queueMessage.ack()
        continue
      }
      if (isRetryableAiFailure(error)) {
        try {
          const retried = await withDatabase(env, (db) =>
            retryAiResponseRun(db, { runId: claimed.id }),
          )
          if (retried) queueMessage.retry()
          else queueMessage.ack()
        } catch {
          queueMessage.retry()
        }
        continue
      }
      try {
        await withDatabase(env, (db) =>
          finishAiOperation(db, { operationId: claimed.id, state: 'FAILED' }),
        )
        await completeAiHandoff(env, claimed, {
          reason: 'PROVIDER_FAILURE',
          runState: 'FAILED',
          failureCode: aiFailureCode(error),
          failureMessage: 'AI response could not be generated',
          markRuntimeUnhealthy: isPersistentAiFailure(error),
          noticeText: handoffNotice(snapshot?.responseLanguage ?? 'English'),
        })
        queueMessage.ack()
      } catch {
        queueMessage.retry()
      }
    }
  }
}

async function publishAiReplyResult(
  env: Bindings,
  identity: { workspaceId: string; conversationId: string },
  result: Awaited<ReturnType<typeof commitAiResponse>>,
) {
  if (!result || result.kind === 'CONTINUE' || result.kind === 'HANDOFF_CHECK_REQUIRED') return
  await publishInboxChange(
    env,
    identity.workspaceId,
    identity.conversationId,
    'conversation.changed',
  )
  if (result.kind === 'COMMITTED') {
    await publishInboxChange(env, result.workspaceId, result.message.id, 'message.changed')
    for (const part of result.messages) await enqueueOutboundMessage(env, part.id)
  }
  if (result.kind === 'CANCELLED' && result.aiResponseRunId)
    await enqueueAiResponseJob(env, result.aiResponseRunId)
}

async function completeAiHandoff(
  env: Bindings,
  claimed: { id: string; workspaceId: string; conversationId: string; memberId: string },
  input: {
    reason:
      | 'CUSTOMER_REQUEST'
      | 'NO_KNOWLEDGE'
      | 'NEGATIVE_SENTIMENT'
      | 'UNABLE_TO_ANSWER'
      | 'KEYWORD'
      | 'UNSUPPORTED_ATTACHMENT'
      | 'PROVIDER_FAILURE'
    noticeText?: string | null
    runState?: 'HANDOFF' | 'FAILED'
    failureCode?: string
    failureMessage?: string
    markRuntimeUnhealthy?: boolean
    customRule?: { id: string; revision: number }
  },
) {
  const result = await withDatabase(env, (db) =>
    handoffAiConversation(db, {
      workspaceId: claimed.workspaceId,
      conversationId: claimed.conversationId,
      memberId: claimed.memberId,
      runId: claimed.id,
      ...input,
    }),
  )
  if (!result.changed) {
    await publishInboxChange(
      env,
      claimed.workspaceId,
      claimed.conversationId,
      'conversation.changed',
    )
    return result
  }

  await publishInboxChange(env, claimed.workspaceId, claimed.conversationId, 'conversation.changed')
  if (result.messageId) {
    await publishInboxChange(env, claimed.workspaceId, result.messageId, 'message.changed')
    await enqueueOutboundMessage(env, result.messageId)
  }
  await enqueueMaintenanceJobs(env, [
    { workspaceId: claimed.workspaceId, conversationId: claimed.conversationId },
  ])
  return result
}

function handoffNotice(responseLanguage: string) {
  return /(^|[-_ ])(?:zh|cn)|chinese|中文|汉语/i.test(responseLanguage)
    ? '我会为你转接人工客服，请稍候。'
    : "I'll connect you with a human teammate. Please wait."
}

function isPersistentAiFailure(error: unknown) {
  return error instanceof AIProviderError && !error.retryable
}

function isRetryableAiFailure(error: unknown) {
  if (error instanceof AIProviderError) return error.retryable
  return !(
    error instanceof AIOutputError ||
    error instanceof AIEmbeddingError ||
    error instanceof AiResponseError ||
    error instanceof AssignmentError ||
    error instanceof KnowledgeError
  )
}

function aiFailureCode(error: unknown) {
  if (error instanceof AiResponseError && error.code === 'HANDOFF_REFERENCE_UNAVAILABLE')
    return error.code
  if (error instanceof AiResponseError && error.code === 'STOP_REFERENCE_UNAVAILABLE')
    return 'STOP_REFERENCE_UNAVAILABLE'
  if (error instanceof AiResponseError && error.code === 'MEDIA_UNAVAILABLE')
    return 'MEDIA_UNAVAILABLE'
  if (error instanceof AIOutputError) return 'INVALID_OUTPUT'
  if (error instanceof AIEmbeddingError) return 'INVALID_EMBEDDING'
  if (error instanceof KnowledgeError) return 'KNOWLEDGE_UNAVAILABLE'
  if (error instanceof AIProviderError) return 'AI_PROVIDER_ERROR'
  return 'AI_RUNTIME_ERROR'
}

class AttachmentProcessingError extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}

class AttachmentRetryError extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}

type DocumentQueueMessage = { ack(): void; retry(options?: { delaySeconds: number }): void }

async function handleKnowledgeDocument(
  queueMessage: DocumentQueueMessage,
  documentId: string,
  env: Bindings,
) {
  let claimed: Awaited<ReturnType<typeof claimKnowledgeDocument>>
  try {
    claimed = await withDatabase(env, (db) => claimKnowledgeDocument(db, { documentId }))
  } catch {
    queueMessage.retry()
    return
  }
  if (!claimed) {
    queueMessage.ack()
    return
  }

  try {
    let extractedText: string
    if (claimed.sourceType === 'TEXT') {
      if (!claimed.sourceText) throw new KnowledgeProcessingError('DOCUMENT_CONTENT_MISSING')
      extractedText = claimed.sourceText
    } else {
      if (!claimed.storageKey) throw new KnowledgeProcessingError('DOCUMENT_CONTENT_MISSING')
      if (!env.OBJECTS) throw new Error('Knowledge file storage is unavailable')
      const object = await createObjectStorage(env.OBJECTS).get(claimed.storageKey)
      if (!object?.body) throw new KnowledgeProcessingError('DOCUMENT_CONTENT_MISSING')
      let bytes: Uint8Array
      try {
        bytes = await readKnowledgeFileBody(object.body)
      } catch (error) {
        if (error instanceof KnowledgeFileError) throw knowledgeFileProcessingError(error)
        throw error
      }
      try {
        extractedText = await extractKnowledgeText(claimed.sourceType, bytes)
      } catch (error) {
        if (error instanceof KnowledgeFileError) throw knowledgeFileProcessingError(error)
        throw error
      }
    }

    const text = normalizeKnowledgeText(extractedText)
    const chunks = chunkKnowledgeText(text)
    if (!chunks.length) throw new KnowledgeProcessingError('EMPTY_CONTENT')

    const embeddingProvider = createAlibabaEmbeddingProvider(
      {
        provider: env.EMBEDDING_PROVIDER,
        apiKey: env.AI_API_KEY,
        baseUrl: env.AI_BASE_URL,
        model: env.EMBEDDING_MODEL,
        dimensions: env.EMBEDDING_DIMENSIONS,
      },
      meteredAiFetch((work) => withDatabase(env, work), {
        id: claimed.indexOperationId,
        workspaceId: claimed.workspaceId,
        kind: 'KNOWLEDGE_INDEX',
      }),
    )
    const embeddings = await embeddingProvider.embed(chunks)
    if (embeddings.length !== chunks.length) throw new AIEmbeddingError()
    const contentSha256 = await hashKnowledgeText(text)

    const completed = await withDatabase(env, (db) =>
      completeKnowledgeDocument(db, {
        documentId: claimed.id,
        workspaceId: claimed.workspaceId,
        knowledgeBaseId: claimed.knowledgeBaseId,
        processingStartedAt: claimed.processingStartedAt,
        revision: claimed.revision,
        contentSha256,
        embeddingMetadata: embeddingProvider.metadata,
        chunks: chunks.map((chunk, index) => ({ text: chunk, embedding: embeddings[index] })),
      }),
    )
    if (completed) await publishKnowledgeChange(env, claimed.workspaceId, claimed.id)
    await withDatabase(env, (db) =>
      finishAiOperation(db, { operationId: claimed.indexOperationId, state: 'COMPLETED' }),
    )
    queueMessage.ack()
  } catch (error) {
    if (error instanceof AiUsageError && error.code === 'RETRY_LATER') {
      await withDatabase(env, (db) =>
        releaseKnowledgeDocument(db, {
          documentId: claimed.id,
          processingStartedAt: claimed.processingStartedAt,
          revision: claimed.revision,
        }),
      )
      queueMessage.retry({ delaySeconds: Math.max(1, Math.ceil(error.retryAfterMs / 1_000)) })
      return
    }
    const retryable =
      error instanceof AIProviderError
        ? error.retryable
        : !(
            error instanceof KnowledgeProcessingError ||
            error instanceof AIEmbeddingError ||
            error instanceof AiUsageError
          )
    if (retryable) {
      try {
        await withDatabase(env, (db) =>
          releaseKnowledgeDocument(db, {
            documentId: claimed.id,
            processingStartedAt: claimed.processingStartedAt,
            revision: claimed.revision,
          }),
        )
      } catch {}
      queueMessage.retry()
      return
    }

    const failureCode =
      error instanceof AiUsageError
        ? error.code
        : error instanceof KnowledgeProcessingError
          ? error.code
          : error instanceof AIEmbeddingError
            ? 'INVALID_EMBEDDING'
            : 'AI_PROVIDER_ERROR'
    try {
      await withDatabase(env, (db) =>
        finishAiOperation(db, { operationId: claimed.indexOperationId, state: 'FAILED' }),
      )
      const failed = await withDatabase(env, (db) =>
        failKnowledgeDocument(db, {
          documentId: claimed.id,
          processingStartedAt: claimed.processingStartedAt,
          revision: claimed.revision,
          failureCode,
          failureMessage:
            error instanceof KnowledgeProcessingError
              ? knowledgeProcessingFailureMessage(error.code)
              : 'Embedding provider returned an invalid response',
        }),
      )
      if (failed) await publishKnowledgeChange(env, claimed.workspaceId, claimed.id)
      queueMessage.ack()
    } catch {
      queueMessage.retry()
    }
  }
}

function knowledgeFileProcessingError(error: KnowledgeFileError) {
  switch (error.code) {
    case 'TOO_LARGE':
      return new KnowledgeProcessingError('TOO_LARGE')
    case 'INVALID_UTF8':
      return new KnowledgeProcessingError('INVALID_UTF8')
    default:
      return new KnowledgeProcessingError('FILE_EXTRACTION_FAILED')
  }
}

function knowledgeProcessingFailureMessage(code: string) {
  return (
    {
      EMPTY_CONTENT: 'Document text is empty',
      DOCUMENT_CONTENT_MISSING: 'Document content is unavailable',
      TOO_LARGE: 'Document is larger than 10 MiB',
      INVALID_UTF8: 'Document is not valid UTF-8',
      FILE_EXTRACTION_FAILED: 'Document could not be extracted',
    }[code] ?? 'Document processing failed'
  )
}

export async function handleDocumentsBatch(batch: MessageBatch<unknown>, env: Bindings) {
  for (const queueMessage of batch.messages) {
    const knowledgeJob = knowledgeDocumentJobSchema.safeParse(queueMessage.body)
    if (knowledgeJob.success) {
      await handleKnowledgeDocument(queueMessage, knowledgeJob.data.documentId, env)
      continue
    }

    const job = facebookAttachmentJobSchema.safeParse(queueMessage.body)
    if (!job.success) {
      queueMessage.ack()
      continue
    }

    let claimed: Awaited<ReturnType<typeof claimFacebookInboundAttachment>>
    try {
      claimed = await withDatabase(env, (db) =>
        claimFacebookInboundAttachment(db, { attachmentId: job.data.attachmentId }),
      )
    } catch {
      queueMessage.retry()
      continue
    }
    if (!claimed) {
      queueMessage.ack()
      continue
    }

    try {
      if (!env.OBJECTS) throw new AttachmentRetryError('STORAGE_UNAVAILABLE')
      const storage = createObjectStorage(env.OBJECTS)
      if (!claimed.expiresAt || claimed.expiresAt.getTime() <= Date.now()) {
        throw new AttachmentProcessingError('SOURCE_EXPIRED')
      }
      if (!claimed.encryptedSourceUrl || !claimed.urlIv || !claimed.tokenKeyVersion) {
        throw new AttachmentProcessingError('SOURCE_MISSING')
      }

      const sourceUrl = await decryptFacebookToken(
        {
          ciphertext: claimed.encryptedSourceUrl,
          iv: claimed.urlIv,
          keyVersion: claimed.tokenKeyVersion,
        },
        env.TOKEN_ENCRYPTION_KEY,
      )
      if (!isHttpUrl(sourceUrl)) throw new AttachmentProcessingError('SOURCE_INVALID')

      let response: Response
      try {
        response = await fetch(sourceUrl, {
          signal: AbortSignal.timeout(ATTACHMENT_SOURCE_TIMEOUT_MS),
        })
      } catch {
        throw new AttachmentRetryError('SOURCE_FETCH_FAILED')
      }
      if (!response.ok) {
        if (response.status === 429 || response.status >= 500) {
          throw new AttachmentRetryError('SOURCE_FETCH_FAILED')
        }
        throw new AttachmentProcessingError('SOURCE_FETCH_FAILED')
      }

      const declaredMimeType = safeMimeType(claimed.mimeType)
      if (declaredMimeType && !isAllowedAttachmentType(claimed.kind, declaredMimeType)) {
        throw new AttachmentProcessingError('UNSUPPORTED_TYPE')
      }
      const responseMimeType = safeMimeType(response.headers.get('content-type'))
      if (
        responseMimeType &&
        responseMimeType !== 'application/octet-stream' &&
        !isAllowedAttachmentType(claimed.kind, responseMimeType)
      ) {
        throw new AttachmentProcessingError('UNSUPPORTED_TYPE')
      }
      const mimeType = declaredMimeType ?? responseMimeType ?? defaultMimeType(claimed.kind)
      if (!isAllowedAttachmentType(claimed.kind, mimeType)) {
        throw new AttachmentProcessingError('UNSUPPORTED_TYPE')
      }

      const contentLength = Number(response.headers.get('content-length'))
      if (Number.isFinite(contentLength) && contentLength > MAX_INBOUND_ATTACHMENT_BYTES) {
        throw new AttachmentProcessingError('TOO_LARGE')
      }
      if (!response.body) throw new AttachmentProcessingError('SOURCE_EMPTY')

      let byteSize = 0
      let body: Uint8Array
      try {
        body = new Uint8Array(
          await new Response(
            limitAttachmentStream(response.body, MAX_INBOUND_ATTACHMENT_BYTES, (size) => {
              byteSize = size
            }),
          ).arrayBuffer(),
        )
      } catch (error) {
        if (error instanceof AttachmentProcessingError) throw error
        throw new AttachmentRetryError('SOURCE_READ_FAILED')
      }
      const storageKey = `attachments/${claimed.id}/${crypto.randomUUID()}`
      try {
        await storage.put(storageKey, body, mimeType)
      } catch (error) {
        if (error instanceof AttachmentProcessingError) throw error
        throw new AttachmentRetryError('STORAGE_FAILED')
      }

      const completed = await withDatabase(env, (db) =>
        completeFacebookInboundAttachment(db, {
          attachmentId: claimed.id,
          storageKey,
          byteSize,
          mimeType,
          processingStartedAt: claimed.processingStartedAt,
        }),
      )
      if (completed) {
        await publishInboxChange(env, claimed.workspaceId, claimed.messageId, 'message.changed')
      }
      queueMessage.ack()
    } catch (error) {
      const failureCode =
        error instanceof AttachmentProcessingError ? error.code : 'ATTACHMENT_PROCESSING_FAILED'
      if (error instanceof AttachmentRetryError) {
        console.warn(
          JSON.stringify({
            event: 'attachment_processing_retry',
            attachmentId: claimed.id,
            failureCode: error.code,
          }),
        )
        try {
          await withDatabase(env, (db) =>
            releaseFacebookInboundAttachment(db, {
              attachmentId: claimed.id,
              processingStartedAt: claimed.processingStartedAt,
            }),
          )
        } catch {}
        queueMessage.retry()
        continue
      }
      console.warn(
        JSON.stringify({
          event: 'attachment_processing_failed',
          attachmentId: claimed.id,
          failureCode,
        }),
      )
      try {
        const failed = await withDatabase(env, (db) =>
          failFacebookInboundAttachment(db, {
            attachmentId: claimed.id,
            failureCode,
            processingStartedAt: claimed.processingStartedAt,
          }),
        )
        if (failed[0]) {
          await publishInboxChange(env, claimed.workspaceId, claimed.messageId, 'message.changed')
        }
        queueMessage.ack()
      } catch {
        queueMessage.retry()
      }
    }
  }
}

function limitAttachmentStream(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
  onComplete: (byteSize: number) => void,
) {
  const reader = body.getReader()
  let byteSize = 0
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const result = await reader.read()
      if (result.done) {
        onComplete(byteSize)
        controller.close()
        return
      }
      byteSize += result.value.byteLength
      if (byteSize > maxBytes) {
        await reader.cancel()
        controller.error(new AttachmentProcessingError('TOO_LARGE'))
        return
      }
      controller.enqueue(result.value)
    },
    cancel(reason) {
      return reader.cancel(reason)
    },
  })
}

function safeMimeType(value: string | null) {
  const mimeType = value?.split(';', 1)[0]?.trim().toLowerCase()
  return mimeType && /^[a-z0-9!#$&^_.+/-]+$/.test(mimeType) ? mimeType : null
}

function isAllowedAttachmentType(kind: 'IMAGE' | 'FILE' | 'AUDIO' | 'VIDEO', mimeType: string) {
  if (kind === 'IMAGE') return /^image\/(jpeg|png|gif|webp|bmp|heic|heif)$/.test(mimeType)
  if (kind === 'AUDIO') return mimeType.startsWith('audio/')
  if (kind === 'VIDEO') return mimeType.startsWith('video/')
  return mimeType.startsWith('application/') || mimeType.startsWith('text/')
}

function defaultMimeType(kind: 'IMAGE' | 'FILE' | 'AUDIO' | 'VIDEO') {
  return {
    IMAGE: 'image/jpeg',
    FILE: 'application/octet-stream',
    AUDIO: 'audio/mpeg',
    VIDEO: 'video/mp4',
  }[kind]
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
    } catch (error) {
      if (error instanceof ReplyError && error.code === 'RETRY_LATER')
        queueMessage.retry({ delaySeconds: Math.max(1, Math.ceil(error.retryAfterMs / 1000)) })
      else queueMessage.retry()
      continue
    }
    if (!claimed) {
      queueMessage.ack()
      continue
    }

    let pageAccessToken = ''
    let recipientId = ''
    let recipientSendStarted = false
    let campaignDelivery: Awaited<ReturnType<typeof campaignDeliveryContext>> = null
    try {
      campaignDelivery = await withDatabase(env, (db) => campaignDeliveryContext(db, claimed.id))
      if (campaignDelivery && !campaignDelivery.allowed) {
        await withDatabase(env, (db) =>
          failOutboundMessage(db, {
            messageId: claimed.id,
            attemptId: claimed.attemptId,
            failureCode: 'CAMPAIGN_NOT_PERMITTED',
            failureMessage: 'Campaign sending permission is no longer valid',
          }),
        )
        queueMessage.ack()
        continue
      }
      const facebookDelivery = await withDatabase(env, (db) =>
        getFacebookOutboundDelivery(db, claimed.id),
      )
      if (!facebookDelivery) throw new Error('Facebook delivery context is missing')
      recipientId = facebookDelivery.externalUserId
      if (!isFacebookReplyWindowOpen(facebookDelivery.eligibleUntil)) {
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

      pageAccessToken = await decryptFacebookToken(
        {
          ciphertext: facebookDelivery.encryptedPageAccessToken,
          iv: facebookDelivery.tokenIv,
          keyVersion: facebookDelivery.tokenKeyVersion,
        },
        env.TOKEN_ENCRYPTION_KEY,
      )
      const adapter = createFacebookAdapter({
        appId: env.META_APP_ID,
        appSecret: env.META_APP_SECRET,
        graphApiVersion: env.META_GRAPH_API_VERSION,
        graphBaseUrl: env.FACEBOOK_GRAPH_BASE_URL,
      })
      let sent: { externalMessageId: string }
      if (claimed.messageType === 'ATTACHMENT') {
        const attachment = await withDatabase(env, (db) => getFacebookOutboundMedia(db, claimed.id))
        if (!attachment?.storageKey || !env.OBJECTS) throw new Error('Private media is unavailable')
        let providerAttachmentId = attachment.providerAttachmentId
        if (!providerAttachmentId) {
          const object = await createObjectStorage(env.OBJECTS).get(attachment.storageKey)
          if (!object) throw new Error('Private media is unavailable')
          const bytes = await new Response(object.body).arrayBuffer()
          const uploadedId = await adapter.uploadAttachment(
            facebookDelivery.pageId,
            attachment.kind,
            new File([bytes], attachment.filename ?? 'attachment', {
              type: attachment.mimeType ?? 'application/octet-stream',
            }),
            pageAccessToken,
          )
          await withDatabase(env, (db) => storeFacebookMediaUpload(db, attachment.id, uploadedId))
          providerAttachmentId = uploadedId
        }
        recipientSendStarted = true
        sent = await adapter.sendAttachment(
          facebookDelivery.pageId,
          recipientId,
          attachment.kind,
          providerAttachmentId,
          pageAccessToken,
          campaignDelivery ? 'UPDATE' : 'RESPONSE',
        )
      } else {
        if (!claimed.text) throw new Error('Outbound text is missing')
        recipientSendStarted = true
        sent = await adapter.sendText(
          facebookDelivery.pageId,
          recipientId,
          claimed.text,
          pageAccessToken,
          campaignDelivery ? 'UPDATE' : 'RESPONSE',
        )
      }
      await withDatabase(env, (db) =>
        completeOutboundMessage(db, {
          messageId: claimed.id,
          attemptId: claimed.attemptId,
          externalMessageId: sent.externalMessageId,
        }),
      )
      await publishInboxChange(env, claimed.workspaceId, job.data.messageId, 'message.changed')
      if (campaignDelivery && env.MAINTENANCE_QUEUE) {
        await env.MAINTENANCE_QUEUE.send(
          { v: 1, type: 'campaign.tick' },
          { delaySeconds: Math.min(43_200, campaignDelivery.intervalSeconds) },
        ).catch(() => undefined)
      }
      queueMessage.ack()
    } catch (error) {
      const providerFailure = redactedFacebookFailure(error, [
        pageAccessToken,
        env.META_APP_SECRET,
        env.TOKEN_ENCRYPTION_KEY,
        recipientId,
        claimed.text ?? '',
      ])
      const attempt = {
        httpStatus:
          error instanceof FacebookProviderError && error.status > 0 ? error.status : null,
        code: error instanceof FacebookProviderError ? error.providerCode : null,
        subcode: error instanceof FacebookProviderError ? error.providerSubcode : null,
        type: error instanceof FacebookProviderError ? error.providerType : null,
        message: providerFailure.message,
        retryNotBefore:
          error instanceof FacebookProviderError && error.retryAfterSeconds !== null
            ? new Date(Date.now() + error.retryAfterSeconds * 1000)
            : null,
      }
      const preparationFailure = claimed.messageType === 'ATTACHMENT' && !recipientSendStarted
      const ambiguous =
        !preparationFailure && error instanceof FacebookProviderError && error.status === 0
      if (
        claimed.messageType !== 'ATTACHMENT' &&
        isRetryableFacebookFailure(error) &&
        (!campaignDelivery || claimed.attemptNumber < 3)
      ) {
        try {
          await withDatabase(env, (db) =>
            releaseOutboundMessage(db, {
              messageId: claimed.id,
              attemptId: claimed.attemptId,
              attempt: campaignDelivery
                ? {
                    ...attempt,
                    retryNotBefore: new Date(
                      Math.max(
                        Date.now() + (claimed.attemptNumber === 1 ? 30_000 : 120_000),
                        attempt.retryNotBefore?.getTime() ?? 0,
                      ),
                    ),
                  }
                : attempt,
            }),
          )
        } catch {}
        queueMessage.retry()
        continue
      }
      try {
        await withDatabase(env, (db) =>
          failOutboundMessage(db, {
            messageId: claimed.id,
            attemptId: claimed.attemptId,
            failureCode: ambiguous
              ? 'AMBIGUOUS_DELIVERY'
              : preparationFailure
                ? 'FACEBOOK_MEDIA_PREPARATION_FAILED'
                : 'FACEBOOK_DELIVERY_FAILED',
            failureMessage: ambiguous
              ? 'Delivery result was ambiguous'
              : 'Facebook delivery failed',
            attempt,
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

async function enqueueFollowUpPage(env: Bindings, after?: string) {
  if (!env.MAINTENANCE_QUEUE) return
  const page = await withDatabase(env, (db) =>
    listDueAiFollowUpConversations(db, new Date(), after),
  )
  for (const conversationId of page.conversations)
    await env.MAINTENANCE_QUEUE.send({ v: 1, type: 'ai.follow-up', conversationId })
  if (page.nextCursor)
    await env.MAINTENANCE_QUEUE.send({ v: 1, type: 'ai.follow-up.scan', after: page.nextCursor })
}

export async function handleMaintenanceBatch(batch: MessageBatch<unknown>, env: Bindings) {
  for (const queueMessage of batch.messages) {
    const scan = z
      .object({ v: z.literal(1), type: z.literal('ai.follow-up.scan'), after: z.string().uuid() })
      .strict()
      .safeParse(queueMessage.body)
    if (scan.success) {
      try {
        await enqueueFollowUpPage(env, scan.data.after)
        queueMessage.ack()
      } catch {
        queueMessage.retry()
      }
      continue
    }
    const followUp = z
      .object({
        v: z.literal(1),
        type: z.literal('ai.follow-up'),
        conversationId: z.string().uuid(),
      })
      .strict()
      .safeParse(queueMessage.body)
    if (followUp.success) {
      try {
        const runId = await withDatabase(env, (db) =>
          startAiFollowUp(db, followUp.data.conversationId),
        )
        if (runId) await enqueueAiResponseJob(env, runId)
        queueMessage.ack()
      } catch {
        queueMessage.retry()
      }
      continue
    }
    if (campaignTickSchema.safeParse(queueMessage.body).success) {
      try {
        await pumpCampaigns(env, withDatabase)
        queueMessage.ack()
      } catch {
        queueMessage.retry()
      }
      continue
    }
    const memoryJob = customerMemoryJobSchema.safeParse(queueMessage.body)
    if (memoryJob.success) {
      try {
        await processCustomerMemoryJob(
          env,
          memoryJob.data.customerId,
          memoryJob.data.revision,
          withDatabase,
        )
        queueMessage.ack()
      } catch (error) {
        if (error instanceof AiUsageError && error.code === 'QUOTA_EXHAUSTED') queueMessage.ack()
        else
          queueMessage.retry({
            delaySeconds:
              error instanceof AiUsageError && error.code === 'RETRY_LATER'
                ? Math.max(1, Math.ceil(error.retryAfterMs / 1000))
                : 30,
          })
      }
      continue
    }
    const job = maintenanceRoutingJobSchema.safeParse(queueMessage.body)
    if (!job.success) {
      queueMessage.ack()
      continue
    }

    try {
      const result = await withDatabase(env, (db) => autoAssignConversation(db, job.data))
      if (result.changed) {
        await publishInboxChange(
          env,
          job.data.workspaceId,
          result.conversationId,
          'conversation.changed',
        )
      }
      if (result.aiResponseRunId) await enqueueAiResponseJob(env, result.aiResponseRunId)
      queueMessage.ack()
    } catch (error) {
      if (error instanceof AssignmentError && error.code === 'NOT_FOUND') queueMessage.ack()
      else queueMessage.retry()
    }
  }
}

export async function handleScheduled(env: Bindings) {
  if (!env.HYPERDRIVE?.connectionString) return

  try {
    await pumpCampaigns(env, withDatabase)
    await enqueueFollowUpPage(env)

    await withDatabase(env, (db) => recoverAiOperations(db))
    const stale = await withDatabase(env, (db) => recoverStaleOutboundMessages(db))
    if (stale.length) {
      console.warn(JSON.stringify({ event: 'outbound_claims_recovered', messages: stale.length }))
      for (const item of stale) {
        await publishInboxChange(env, item.workspaceId, item.id, 'message.changed')
      }
    }
    if (env.OUTBOUND_QUEUE) {
      const pending = await withDatabase(env, (db) => listUnclaimedOutboundMessageIds(db))
      const queue = createJobQueue(env.OUTBOUND_QUEUE)
      for (const messageId of pending) {
        try {
          await queue.send({ v: 1, type: 'facebook.outbound', messageId })
        } catch {
          console.warn(JSON.stringify({ event: 'outbound_queue_failed', messageId }))
        }
      }
    }

    const expiredAttachments = await withDatabase(env, (db) => expireFacebookInboundAttachments(db))
    for (const item of expiredAttachments) {
      await publishInboxChange(env, item.workspaceId, item.messageId, 'message.changed')
    }

    const deletedReceipts = await withDatabase(env, (db) => deleteOldFacebookWebhookReceipts(db))
    if (deletedReceipts) {
      console.log(JSON.stringify({ event: 'webhook_receipts_deleted', receipts: deletedReceipts }))
    }

    if (env.DOCUMENTS_QUEUE) {
      const pendingAttachments = await withDatabase(env, (db) =>
        listPendingFacebookInboundAttachmentIds(db),
      )
      const queue = createJobQueue(env.DOCUMENTS_QUEUE)
      for (const attachmentId of pendingAttachments) {
        try {
          await queue.send({ v: 1, type: 'facebook.attachment', attachmentId })
        } catch {
          console.warn(JSON.stringify({ event: 'attachment_queue_failed', attachmentId }))
        }
      }
      const pendingKnowledgeDocuments = await withDatabase(env, (db) =>
        listPendingKnowledgeDocumentIds(db),
      )
      for (const documentId of pendingKnowledgeDocuments) {
        await enqueueKnowledgeDocumentJob(env.DOCUMENTS_QUEUE, documentId)
      }
    }

    if (env.MAINTENANCE_QUEUE) {
      const memoryCustomerIds = await withDatabase(env, (db) => listDueCustomerMemoryIds(db))
      for (const input of memoryCustomerIds)
        await env.MAINTENANCE_QUEUE.send({ v: 1, type: 'customer.memory', ...input })
      await enqueueMaintenanceJobs(
        env,
        await withDatabase(env, (db) => listQueuedConversationIds(db)),
      )
    }
    const staleAiRuns = await withDatabase(env, (db) => listStaleAiResponseRuns(db))
    for (const item of staleAiRuns) {
      try {
        await completeAiHandoff(
          env,
          {
            id: item.runId,
            workspaceId: item.workspaceId,
            conversationId: item.conversationId,
            memberId: item.memberId,
          },
          {
            reason: 'PROVIDER_FAILURE',
            runState: 'FAILED',
            failureCode: 'AI_GENERATION_TIMEOUT',
            failureMessage: 'AI generation exceeded the recovery timeout',
            noticeText: null,
          },
        )
      } catch {
        console.warn(JSON.stringify({ event: 'ai_recovery_failed' }))
      }
    }
    if (env.AI_QUEUE) {
      const runIds = await withDatabase(env, (db) => listQueuedAiResponseRunIds(db))
      for (const runId of runIds) await enqueueAiResponseJob(env, runId)
    }
  } catch {
    console.error(JSON.stringify({ event: 'scheduled_recovery_failed' }))
  }
}

export { app, hasValidSignature, WorkspaceRealtime }

const worker = {
  fetch: (request: Request, env: Bindings, executionContext: ExecutionContext) =>
    app.fetch(request, env, executionContext),
  queue: (batch: MessageBatch<unknown>, env: Bindings) =>
    batch.queue === 'deepsales-outbound'
      ? handleOutboundBatch(batch, env)
      : batch.queue === 'deepsales-ai'
        ? handleAiResponseBatch(batch, env)
        : batch.queue === 'deepsales-documents'
          ? handleDocumentsBatch(batch, env)
          : batch.queue === 'deepsales-maintenance'
            ? handleMaintenanceBatch(batch, env)
            : handleWebhookBatch(batch, env),
  scheduled: (_controller: ScheduledController, env: Bindings) => handleScheduled(env),
}

export default worker
