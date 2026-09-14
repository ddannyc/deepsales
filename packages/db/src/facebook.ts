import { and, asc, eq, gt, inArray, or, sql } from 'drizzle-orm'
import type { Database } from './database'
import { listConversations, type ConversationView, type ConversationCursor } from './inbox'
import { createHumanReply, type HumanReplyInput } from './outbound'
import {
  channel,
  channelIdentity,
  conversation,
  facebookChannelConfig,
  facebookMessagingWindow,
  facebookOauthState,
  message,
  workspaceUserAccess,
} from './schema'

export const FACEBOOK_OAUTH_TTL_MS = 10 * 60 * 1_000

export type FacebookErrorCode =
  | 'FORBIDDEN'
  | 'INVALID_REQUEST'
  | 'NOT_FOUND'
  | 'FACEBOOK_OAUTH_STATE_INVALID'
  | 'FACEBOOK_OAUTH_STATE_EXPIRED'
  | 'FACEBOOK_OAUTH_STATE_USED'
  | 'FACEBOOK_OAUTH_STATE_MISMATCH'
  | 'FACEBOOK_PAGE_ALREADY_CONNECTED'

export class FacebookError extends Error {
  constructor(
    readonly code: FacebookErrorCode,
    message: string = code,
  ) {
    super(message)
  }
}

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0]
type QueryHandle = Database | Transaction

export function createFacebookHumanReply(db: Database, input: HumanReplyInput) {
  return createHumanReply(db, input, facebookReplyWindowOpen)
}

async function facebookReplyWindowOpen(tx: Transaction, channelIdentityId: string, now: Date) {
  const [window] = await tx
    .select({ eligibleUntil: facebookMessagingWindow.eligibleUntil })
    .from(facebookMessagingWindow)
    .where(eq(facebookMessagingWindow.channelIdentityId, channelIdentityId))
    .limit(1)
  return Boolean(window?.eligibleUntil && window.eligibleUntil.getTime() > now.getTime())
}

export async function getFacebookOutboundDelivery(db: Database, messageId: string) {
  const [delivery] = await db
    .select({
      externalUserId: channelIdentity.externalUserId,
      eligibleUntil: facebookMessagingWindow.eligibleUntil,
      pageId: facebookChannelConfig.pageId,
      encryptedPageAccessToken: facebookChannelConfig.encryptedPageAccessToken,
      tokenIv: facebookChannelConfig.tokenIv,
      tokenKeyVersion: facebookChannelConfig.tokenKeyVersion,
    })
    .from(message)
    .innerJoin(conversation, eq(conversation.id, message.conversationId))
    .innerJoin(channelIdentity, eq(channelIdentity.id, conversation.channelIdentityId))
    .innerJoin(channel, eq(channel.id, message.channelId))
    .innerJoin(facebookChannelConfig, eq(facebookChannelConfig.channelId, channel.id))
    .leftJoin(
      facebookMessagingWindow,
      eq(facebookMessagingWindow.channelIdentityId, channelIdentity.id),
    )
    .where(and(eq(message.id, messageId), eq(message.direction, 'OUTBOUND')))
    .limit(1)
  return delivery ?? null
}

export async function listFacebookConversations(
  db: Database,
  input: {
    workspaceId: string
    userId: string
    view: ConversationView
    after?: ConversationCursor
    limit?: number
    conversationId?: string
  },
) {
  const page = await listConversations(db, input)
  const ids = page.conversations.map(({ id }) => id)
  if (!ids.length) return page
  const now = new Date()

  const windows = await db
    .select({
      conversationId: conversation.id,
      eligibleUntil: facebookMessagingWindow.eligibleUntil,
    })
    .from(conversation)
    .innerJoin(channelIdentity, eq(channelIdentity.id, conversation.channelIdentityId))
    .leftJoin(
      facebookMessagingWindow,
      eq(facebookMessagingWindow.channelIdentityId, channelIdentity.id),
    )
    .where(and(eq(conversation.workspaceId, input.workspaceId), inArray(conversation.id, ids)))
  const byConversationId = new Map(windows.map((window) => [window.conversationId, window]))
  return {
    ...page,
    conversations: page.conversations.map((item) =>
      enrichConversation(item, byConversationId.get(item.id)?.eligibleUntil ?? null, now),
    ),
  }
}

function enrichConversation<T extends { id: string }>(
  conversation: T,
  eligibleUntil: Date | null,
  now: Date,
) {
  return {
    ...conversation,
    replyWindowOpen: Boolean(eligibleUntil && eligibleUntil.getTime() > now.getTime()),
    replyWindowEligibleUntil: eligibleUntil,
  }
}

export type StartFacebookOAuthInput = {
  workspaceId: string
  initiatedByUserId: string
  expiresAt?: Date
}

export async function startFacebookOAuth(db: Database, input: StartFacebookOAuthInput) {
  const state = createToken()
  const stateHash = await hashFacebookState(state)
  const expiresAt = input.expiresAt ?? new Date(Date.now() + FACEBOOK_OAUTH_TTL_MS)
  if (expiresAt.getTime() <= Date.now()) {
    throw new FacebookError('INVALID_REQUEST', 'OAuth state must expire in the future')
  }

  return db.transaction(async (tx) => {
    await assertFacebookManager(tx, input.workspaceId, input.initiatedByUserId)
    const [created] = await tx
      .insert(facebookOauthState)
      .values({
        workspaceId: input.workspaceId,
        initiatedByUserId: input.initiatedByUserId,
        stateHash,
        expiresAt,
      })
      .returning({ id: facebookOauthState.id, expiresAt: facebookOauthState.expiresAt })
    if (!created) throw new FacebookError('INVALID_REQUEST', 'OAuth state was not created')
    return { ...created, state }
  })
}

export async function hashFacebookState(state: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(state))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function consumeFacebookOAuthState(
  db: Database,
  input: { state: string; userId: string },
) {
  const stateHash = await hashFacebookState(input.state)
  return db.transaction(async (tx) => {
    const locked = await tx.execute(
      sql`select id from facebook_oauth_state where state_hash = ${stateHash} for update`,
    )
    if (!locked.rows.length) {
      throw new FacebookError('FACEBOOK_OAUTH_STATE_INVALID', 'OAuth state is invalid')
    }

    const [stored] = await tx
      .select()
      .from(facebookOauthState)
      .where(eq(facebookOauthState.stateHash, stateHash))
      .limit(1)
    if (!stored) throw new FacebookError('FACEBOOK_OAUTH_STATE_INVALID', 'OAuth state is invalid')
    if (stored.usedAt) throw new FacebookError('FACEBOOK_OAUTH_STATE_USED', 'OAuth state was used')
    if (stored.expiresAt.getTime() <= Date.now()) {
      throw new FacebookError('FACEBOOK_OAUTH_STATE_EXPIRED', 'OAuth state expired')
    }
    if (stored.initiatedByUserId !== input.userId) {
      throw new FacebookError('FACEBOOK_OAUTH_STATE_MISMATCH', 'OAuth state does not match')
    }
    await assertFacebookManager(tx, stored.workspaceId, input.userId)

    const [consumed] = await tx
      .update(facebookOauthState)
      .set({ usedAt: new Date(), updatedAt: new Date() })
      .where(eq(facebookOauthState.id, stored.id))
      .returning({
        id: facebookOauthState.id,
        workspaceId: facebookOauthState.workspaceId,
        initiatedByUserId: facebookOauthState.initiatedByUserId,
        expiresAt: facebookOauthState.expiresAt,
      })
    if (!consumed) throw new FacebookError('FACEBOOK_OAUTH_STATE_INVALID', 'OAuth state is invalid')
    return consumed
  })
}

export async function storeFacebookOAuthToken(
  db: Database,
  input: {
    stateId: string
    userId: string
    encryptedUserAccessToken: string
    userTokenIv: string
    userTokenKeyVersion: string
  },
) {
  return db.transaction(async (tx) => {
    const [state] = await tx
      .select({
        id: facebookOauthState.id,
        initiatedByUserId: facebookOauthState.initiatedByUserId,
        expiresAt: facebookOauthState.expiresAt,
        usedAt: facebookOauthState.usedAt,
      })
      .from(facebookOauthState)
      .where(eq(facebookOauthState.id, input.stateId))
      .limit(1)
    if (!state) throw new FacebookError('FACEBOOK_OAUTH_STATE_INVALID', 'OAuth state is invalid')
    if (state.initiatedByUserId !== input.userId) {
      throw new FacebookError('FACEBOOK_OAUTH_STATE_MISMATCH', 'OAuth state does not match')
    }
    if (!state.usedAt)
      throw new FacebookError('FACEBOOK_OAUTH_STATE_INVALID', 'OAuth state is invalid')
    if (state.expiresAt.getTime() <= Date.now()) {
      throw new FacebookError('FACEBOOK_OAUTH_STATE_EXPIRED', 'OAuth state expired')
    }

    const [stored] = await tx
      .update(facebookOauthState)
      .set({
        encryptedUserAccessToken: input.encryptedUserAccessToken,
        userTokenIv: input.userTokenIv,
        userTokenKeyVersion: input.userTokenKeyVersion,
        updatedAt: new Date(),
      })
      .where(eq(facebookOauthState.id, input.stateId))
      .returning({ id: facebookOauthState.id })
    if (!stored) throw new FacebookError('FACEBOOK_OAUTH_STATE_INVALID', 'OAuth state is invalid')
    return stored
  })
}

export async function getFacebookOAuthToken(
  db: Database,
  input: { stateId: string; workspaceId: string; userId: string },
) {
  return db.transaction(async (tx) => {
    await assertFacebookManager(tx, input.workspaceId, input.userId)
    const [state] = await tx
      .select({
        id: facebookOauthState.id,
        initiatedByUserId: facebookOauthState.initiatedByUserId,
        expiresAt: facebookOauthState.expiresAt,
        usedAt: facebookOauthState.usedAt,
        encryptedUserAccessToken: facebookOauthState.encryptedUserAccessToken,
        userTokenIv: facebookOauthState.userTokenIv,
        userTokenKeyVersion: facebookOauthState.userTokenKeyVersion,
      })
      .from(facebookOauthState)
      .where(
        and(
          eq(facebookOauthState.id, input.stateId),
          eq(facebookOauthState.workspaceId, input.workspaceId),
        ),
      )
      .limit(1)
    if (!state) throw new FacebookError('FACEBOOK_OAUTH_STATE_INVALID', 'OAuth state is invalid')
    if (state.initiatedByUserId !== input.userId) {
      throw new FacebookError('FACEBOOK_OAUTH_STATE_MISMATCH', 'OAuth state does not match')
    }
    if (!state.usedAt || !state.encryptedUserAccessToken || !state.userTokenIv) {
      throw new FacebookError('FACEBOOK_OAUTH_STATE_INVALID', 'OAuth state is invalid')
    }
    if (state.expiresAt.getTime() <= Date.now()) {
      throw new FacebookError('FACEBOOK_OAUTH_STATE_EXPIRED', 'OAuth state expired')
    }
    return state
  })
}

export async function completeFacebookOAuthSelection(db: Database, stateId: string) {
  await db
    .update(facebookOauthState)
    .set({
      encryptedUserAccessToken: null,
      userTokenIv: null,
      userTokenKeyVersion: null,
      updatedAt: new Date(),
    })
    .where(eq(facebookOauthState.id, stateId))
}

export type FacebookPageConnection = {
  pageId: string
  displayName: string
  encryptedPageAccessToken: string
  tokenIv: string
  tokenKeyVersion: string
  subscribedAt?: Date
}

export async function connectFacebookPages(
  db: Database,
  input: {
    workspaceId: string
    actingUserId: string
    pages: FacebookPageConnection[]
  },
) {
  const pages = [...new Map(input.pages.map((page) => [page.pageId, page])).values()].sort((a, b) =>
    a.pageId.localeCompare(b.pageId),
  )
  if (!pages.length) throw new FacebookError('INVALID_REQUEST', 'Select at least one Page')

  return db.transaction(async (tx) => {
    await assertFacebookManager(tx, input.workspaceId, input.actingUserId)
    const connected = []
    for (const page of pages) {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${page.pageId}, 0))`)
      const [existing] = await tx
        .select({
          channelId: facebookChannelConfig.channelId,
          workspaceId: channel.workspaceId,
        })
        .from(facebookChannelConfig)
        .innerJoin(channel, eq(channel.id, facebookChannelConfig.channelId))
        .where(eq(facebookChannelConfig.pageId, page.pageId))
        .limit(1)
      if (existing && existing.workspaceId !== input.workspaceId) {
        throw new FacebookError(
          'FACEBOOK_PAGE_ALREADY_CONNECTED',
          'This Facebook Page is already connected',
        )
      }

      const now = new Date()
      if (existing) {
        await tx
          .update(channel)
          .set({
            displayName: cleanPageName(page.displayName),
            status: 'ACTIVE',
            updatedAt: now,
          })
          .where(eq(channel.id, existing.channelId))
        await tx
          .update(facebookChannelConfig)
          .set({
            encryptedPageAccessToken: page.encryptedPageAccessToken,
            tokenIv: page.tokenIv,
            tokenKeyVersion: page.tokenKeyVersion,
            connectionStatus: 'ACTIVE',
            subscribedAt: page.subscribedAt ?? now,
            lastCheckedAt: now,
            lastErrorCode: null,
            lastErrorSubcode: null,
            lastErrorMessage: null,
            updatedAt: now,
          })
          .where(eq(facebookChannelConfig.channelId, existing.channelId))
        connected.push({
          id: existing.channelId,
          pageId: page.pageId,
          displayName: page.displayName,
        })
        continue
      }

      const [createdChannel] = await tx
        .insert(channel)
        .values({
          workspaceId: input.workspaceId,
          provider: 'FACEBOOK_MESSENGER',
          displayName: cleanPageName(page.displayName),
          status: 'ACTIVE',
        })
        .returning({ id: channel.id })
      if (!createdChannel) throw new FacebookError('INVALID_REQUEST', 'Channel was not created')
      await tx.insert(facebookChannelConfig).values({
        channelId: createdChannel.id,
        pageId: page.pageId,
        encryptedPageAccessToken: page.encryptedPageAccessToken,
        tokenIv: page.tokenIv,
        tokenKeyVersion: page.tokenKeyVersion,
        connectionStatus: 'ACTIVE',
        subscribedAt: page.subscribedAt ?? now,
        lastCheckedAt: now,
      })
      connected.push({ id: createdChannel.id, pageId: page.pageId, displayName: page.displayName })
    }
    return connected
  })
}

export async function assertFacebookPagesAvailable(
  db: Database,
  input: { workspaceId: string; actingUserId: string; pageIds: string[] },
) {
  const pageIds = [...new Set(input.pageIds)].sort()
  if (!pageIds.length) throw new FacebookError('INVALID_REQUEST', 'Select at least one Page')

  await db.transaction(async (tx) => {
    await assertFacebookManager(tx, input.workspaceId, input.actingUserId)
    for (const pageId of pageIds) {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${pageId}, 0))`)
      const [existing] = await tx
        .select({ workspaceId: channel.workspaceId })
        .from(facebookChannelConfig)
        .innerJoin(channel, eq(channel.id, facebookChannelConfig.channelId))
        .where(eq(facebookChannelConfig.pageId, pageId))
        .limit(1)
      if (existing && existing.workspaceId !== input.workspaceId) {
        throw new FacebookError(
          'FACEBOOK_PAGE_ALREADY_CONNECTED',
          'This Facebook Page is already connected',
        )
      }
    }
  })
}

export type FacebookChannelCursor = { displayName: string; id: string }

export async function listFacebookChannelsPage(
  db: Database,
  workspaceId: string,
  userId: string,
  input: { after?: FacebookChannelCursor; limit?: number } = {},
) {
  await assertFacebookManagerOrMember(db, workspaceId, userId)
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 100)
  const rows = await db
    .select({
      id: channel.id,
      pageId: facebookChannelConfig.pageId,
      displayName: channel.displayName,
      provider: channel.provider,
      status: channel.status,
      connectionStatus: facebookChannelConfig.connectionStatus,
      subscribedAt: facebookChannelConfig.subscribedAt,
      lastCheckedAt: facebookChannelConfig.lastCheckedAt,
      lastErrorCode: facebookChannelConfig.lastErrorCode,
      lastErrorSubcode: facebookChannelConfig.lastErrorSubcode,
      lastErrorMessage: facebookChannelConfig.lastErrorMessage,
    })
    .from(channel)
    .innerJoin(facebookChannelConfig, eq(facebookChannelConfig.channelId, channel.id))
    .where(
      input.after
        ? and(
            eq(channel.workspaceId, workspaceId),
            or(
              gt(channel.displayName, input.after.displayName),
              and(eq(channel.displayName, input.after.displayName), gt(channel.id, input.after.id)),
            ),
          )
        : eq(channel.workspaceId, workspaceId),
    )
    .orderBy(asc(channel.displayName), asc(channel.id))
    .limit(limit + 1)
  const hasNext = rows.length > limit
  const channels = rows.slice(0, limit)
  const last = channels.at(-1)
  return {
    channels,
    nextCursor: hasNext && last ? { displayName: last.displayName, id: last.id } : null,
  }
}

export async function listFacebookChannels(db: Database, workspaceId: string, userId: string) {
  await assertFacebookManagerOrMember(db, workspaceId, userId)
  return db
    .select({
      id: channel.id,
      pageId: facebookChannelConfig.pageId,
      displayName: channel.displayName,
      provider: channel.provider,
      status: channel.status,
      connectionStatus: facebookChannelConfig.connectionStatus,
      subscribedAt: facebookChannelConfig.subscribedAt,
      lastCheckedAt: facebookChannelConfig.lastCheckedAt,
      lastErrorCode: facebookChannelConfig.lastErrorCode,
      lastErrorSubcode: facebookChannelConfig.lastErrorSubcode,
      lastErrorMessage: facebookChannelConfig.lastErrorMessage,
    })
    .from(channel)
    .innerJoin(facebookChannelConfig, eq(facebookChannelConfig.channelId, channel.id))
    .where(eq(channel.workspaceId, workspaceId))
    .orderBy(asc(channel.displayName), asc(channel.id))
}

export async function getFacebookChannelForManager(
  db: Database,
  input: { workspaceId: string; channelId: string; userId: string },
) {
  await assertFacebookManagerOrMember(db, input.workspaceId, input.userId, true)
  const [found] = await db
    .select({
      id: channel.id,
      pageId: facebookChannelConfig.pageId,
      channelStatus: channel.status,
      connectionStatus: facebookChannelConfig.connectionStatus,
      encryptedPageAccessToken: facebookChannelConfig.encryptedPageAccessToken,
      tokenIv: facebookChannelConfig.tokenIv,
      tokenKeyVersion: facebookChannelConfig.tokenKeyVersion,
    })
    .from(channel)
    .innerJoin(facebookChannelConfig, eq(facebookChannelConfig.channelId, channel.id))
    .where(and(eq(channel.id, input.channelId), eq(channel.workspaceId, input.workspaceId)))
    .limit(1)
  if (!found) throw new FacebookError('NOT_FOUND', 'Facebook channel not found')
  return found
}

export async function markFacebookChannelHealth(
  db: Database,
  input: {
    workspaceId: string
    channelId: string
    userId: string
    active: boolean
    error?: { code: string; subcode?: number | null; message: string }
  },
) {
  return db.transaction(async (tx) => {
    await assertFacebookManager(tx, input.workspaceId, input.userId)
    const [channelInWorkspace] = await tx
      .select({ id: channel.id })
      .from(channel)
      .where(and(eq(channel.id, input.channelId), eq(channel.workspaceId, input.workspaceId)))
      .limit(1)
    if (!channelInWorkspace) throw new FacebookError('NOT_FOUND', 'Facebook channel not found')

    const [updated] = await tx
      .update(facebookChannelConfig)
      .set({
        connectionStatus: input.active ? 'ACTIVE' : 'ACTION_REQUIRED',
        lastCheckedAt: new Date(),
        lastErrorCode: input.active ? null : (input.error?.code ?? 'FACEBOOK_CHECK_FAILED'),
        lastErrorSubcode: input.active ? null : (input.error?.subcode ?? null),
        lastErrorMessage: input.active
          ? null
          : (input.error?.message ?? 'Facebook connection needs attention'),
        updatedAt: new Date(),
      })
      .where(eq(facebookChannelConfig.channelId, channelInWorkspace.id))
      .returning({ channelId: facebookChannelConfig.channelId })
    if (!updated) throw new FacebookError('NOT_FOUND', 'Facebook channel not found')
    return updated
  })
}

export async function disableFacebookChannel(
  db: Database,
  input: { workspaceId: string; channelId: string; userId: string },
) {
  return db.transaction(async (tx) => {
    await assertFacebookManager(tx, input.workspaceId, input.userId)
    const [found] = await tx
      .select({ id: channel.id })
      .from(channel)
      .innerJoin(facebookChannelConfig, eq(facebookChannelConfig.channelId, channel.id))
      .where(and(eq(channel.id, input.channelId), eq(channel.workspaceId, input.workspaceId)))
      .limit(1)
    if (!found) throw new FacebookError('NOT_FOUND', 'Facebook channel not found')
    const now = new Date()
    await tx
      .update(channel)
      .set({ status: 'DISABLED', updatedAt: now })
      .where(eq(channel.id, found.id))
    await tx
      .update(facebookChannelConfig)
      .set({ connectionStatus: 'DISABLED', updatedAt: now })
      .where(eq(facebookChannelConfig.channelId, found.id))
    return { id: found.id }
  })
}

export async function findActiveFacebookPage(db: Database, pageId: string) {
  const [found] = await db
    .select({ channelId: channel.id, workspaceId: channel.workspaceId })
    .from(facebookChannelConfig)
    .innerJoin(channel, eq(channel.id, facebookChannelConfig.channelId))
    .where(
      and(
        eq(facebookChannelConfig.pageId, pageId),
        eq(facebookChannelConfig.connectionStatus, 'ACTIVE'),
        eq(channel.status, 'ACTIVE'),
      ),
    )
    .limit(1)
  return found ?? null
}

export async function recordFacebookConnectionFailure(
  db: Database,
  input: {
    workspaceId: string
    pageId: string
    userId: string
    error: { code: string; subcode?: number | null; message: string }
  },
) {
  await assertFacebookManager(db, input.workspaceId, input.userId)
  const [found] = await db
    .select({ channelId: facebookChannelConfig.channelId })
    .from(facebookChannelConfig)
    .innerJoin(channel, eq(channel.id, facebookChannelConfig.channelId))
    .where(
      and(
        eq(channel.workspaceId, input.workspaceId),
        eq(facebookChannelConfig.pageId, input.pageId),
      ),
    )
    .limit(1)
  if (!found) return null
  return markFacebookChannelHealth(db, {
    workspaceId: input.workspaceId,
    channelId: found.channelId,
    userId: input.userId,
    active: false,
    error: input.error,
  })
}

async function assertFacebookManager(tx: QueryHandle, workspaceId: string, userId: string) {
  await tx.execute(
    sql`select id from workspace_user_access where workspace_id = ${workspaceId} and user_id = ${userId} for update`,
  )
  const [access] = await tx
    .select({ role: workspaceUserAccess.role })
    .from(workspaceUserAccess)
    .where(
      and(eq(workspaceUserAccess.workspaceId, workspaceId), eq(workspaceUserAccess.userId, userId)),
    )
    .limit(1)
  if (!access || access.role === 'AGENT')
    throw new FacebookError('FORBIDDEN', 'Manager access required')
  return access.role
}

async function assertFacebookManagerOrMember(
  db: Database,
  workspaceId: string,
  userId: string,
  managerOnly = false,
) {
  if (managerOnly) return assertFacebookManager(db, workspaceId, userId)
  const [access] = await db
    .select({ role: workspaceUserAccess.role })
    .from(workspaceUserAccess)
    .where(
      and(eq(workspaceUserAccess.workspaceId, workspaceId), eq(workspaceUserAccess.userId, userId)),
    )
    .limit(1)
  if (!access) throw new FacebookError('FORBIDDEN', 'Workspace access required')
  return access.role
}

function createToken() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')
}

function cleanPageName(value: string) {
  const name = value.trim()
  return name || 'Facebook Page'
}
