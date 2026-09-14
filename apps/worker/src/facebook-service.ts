import {
  assertFacebookPagesAvailable,
  completeFacebookOAuthSelection,
  connectFacebookPages,
  consumeFacebookOAuthState,
  type Database,
  FacebookError,
  type FacebookPageConnection,
  getFacebookChannelForManager,
  getFacebookOAuthToken,
  markFacebookChannelHealth,
  recordFacebookConnectionFailure,
  startFacebookOAuth,
  storeFacebookOAuthToken,
} from '@deepsales/db'
import type { Bindings } from './bindings'
import {
  buildFacebookOAuthUrl,
  createFacebookAdapter,
  decryptFacebookToken,
  encryptFacebookToken,
  type FacebookPageSummary,
  redactedFacebookFailure,
} from './facebook'

export type FacebookServiceConfig = {
  appUrl: string
  appId: string
  appSecret: string
  graphApiVersion: string
  tokenEncryptionKey: string
}

export function facebookServiceConfig(env: Bindings): FacebookServiceConfig {
  return {
    appUrl: env.APP_URL,
    appId: env.META_APP_ID,
    appSecret: env.META_APP_SECRET,
    graphApiVersion: env.META_GRAPH_API_VERSION,
    tokenEncryptionKey: env.TOKEN_ENCRYPTION_KEY,
  }
}

export async function beginFacebookOAuth(
  db: Database,
  config: FacebookServiceConfig,
  input: { workspaceId: string; userId: string },
) {
  const created = await startFacebookOAuth(db, {
    workspaceId: input.workspaceId,
    initiatedByUserId: input.userId,
  })
  return {
    stateId: created.id,
    expiresAt: created.expiresAt,
    authorizationUrl: buildFacebookOAuthUrl({
      appId: config.appId,
      graphApiVersion: config.graphApiVersion,
      redirectUri: facebookRedirectUri(config.appUrl),
      state: created.state,
    }),
  }
}

export async function completeFacebookOAuth(
  db: Database,
  config: FacebookServiceConfig,
  input: { state: string; code: string; userId: string },
) {
  const consumed = await consumeFacebookOAuthState(db, {
    state: input.state,
    userId: input.userId,
  })
  const adapter = createFacebookAdapter(config)
  const userAccessToken = await adapter.exchangeCode(input.code, facebookRedirectUri(config.appUrl))
  const pages = await adapter.listPages(userAccessToken)
  const encrypted = await encryptFacebookToken(userAccessToken, config.tokenEncryptionKey)
  await storeFacebookOAuthToken(db, {
    stateId: consumed.id,
    userId: input.userId,
    encryptedUserAccessToken: encrypted.ciphertext,
    userTokenIv: encrypted.iv,
    userTokenKeyVersion: encrypted.keyVersion,
  })
  return {
    stateId: consumed.id,
    workspaceId: consumed.workspaceId,
    pages: selectablePages(pages).map(
      ({ id, name, tasks }): FacebookPageSummary => ({ id, name, tasks }),
    ),
  }
}

export async function listFacebookOAuthPages(
  db: Database,
  config: FacebookServiceConfig,
  input: { stateId: string; workspaceId: string; userId: string },
) {
  const stored = await getFacebookOAuthToken(db, input)
  const userAccessToken = await decryptFacebookToken(
    {
      ciphertext: stored.encryptedUserAccessToken as string,
      iv: stored.userTokenIv as string,
      keyVersion: stored.userTokenKeyVersion ?? '',
    },
    config.tokenEncryptionKey,
  )
  const pages = await createFacebookAdapter(config).listPages(userAccessToken)
  return selectablePages(pages).map(
    ({ id, name, tasks }): FacebookPageSummary => ({ id, name, tasks }),
  )
}

export async function selectFacebookPages(
  db: Database,
  config: FacebookServiceConfig,
  input: { stateId: string; workspaceId: string; userId: string; pageIds: string[] },
) {
  const stored = await getFacebookOAuthToken(db, {
    stateId: input.stateId,
    workspaceId: input.workspaceId,
    userId: input.userId,
  })
  const userAccessToken = await decryptFacebookToken(
    {
      ciphertext: stored.encryptedUserAccessToken as string,
      iv: stored.userTokenIv as string,
      keyVersion: stored.userTokenKeyVersion ?? '',
    },
    config.tokenEncryptionKey,
  )
  const adapter = createFacebookAdapter(config)
  const availablePages = await adapter.listPages(userAccessToken)
  const selectedIds = new Set(input.pageIds)
  const selectedPages = selectablePages(availablePages).filter((page) => selectedIds.has(page.id))
  if (selectedPages.length !== selectedIds.size) {
    throw new FacebookError('INVALID_REQUEST', 'Selected Facebook Page is unavailable')
  }

  await assertFacebookPagesAvailable(db, {
    workspaceId: input.workspaceId,
    actingUserId: input.userId,
    pageIds: selectedPages.map(({ id }) => id),
  })

  const pages: FacebookPageConnection[] = []
  for (const page of selectedPages) {
    try {
      await adapter.subscribePage(page.id, page.accessToken)
    } catch (error) {
      const failure = redactedFacebookFailure(error, [config.appSecret, page.accessToken])
      await recordFacebookConnectionFailure(db, {
        workspaceId: input.workspaceId,
        pageId: page.id,
        userId: input.userId,
        error: failure,
      })
      throw error
    }
    const encrypted = await encryptFacebookToken(page.accessToken, config.tokenEncryptionKey)
    pages.push({
      pageId: page.id,
      displayName: page.name,
      encryptedPageAccessToken: encrypted.ciphertext,
      tokenIv: encrypted.iv,
      tokenKeyVersion: encrypted.keyVersion,
    })
  }

  const connected = await connectFacebookPages(db, {
    workspaceId: input.workspaceId,
    actingUserId: input.userId,
    pages,
  })
  await completeFacebookOAuthSelection(db, stored.id)
  return connected
}

export async function recheckFacebookPage(
  db: Database,
  config: FacebookServiceConfig,
  input: { workspaceId: string; channelId: string; userId: string },
) {
  const channel = await getFacebookChannelForManager(db, input)
  if (channel.channelStatus === 'DISABLED') return

  let pageAccessToken = ''
  const adapter = createFacebookAdapter(config)
  try {
    pageAccessToken = await decryptFacebookToken(
      {
        ciphertext: channel.encryptedPageAccessToken,
        iv: channel.tokenIv,
        keyVersion: channel.tokenKeyVersion,
      },
      config.tokenEncryptionKey,
    )
    await adapter.checkPageSubscription(channel.pageId, pageAccessToken)
  } catch (error) {
    await markFacebookChannelHealth(db, {
      workspaceId: input.workspaceId,
      channelId: input.channelId,
      userId: input.userId,
      active: false,
      error: redactedFacebookFailure(error, [config.appSecret, pageAccessToken]),
    })
    return
  }

  await markFacebookChannelHealth(db, {
    workspaceId: input.workspaceId,
    channelId: input.channelId,
    userId: input.userId,
    active: true,
  })
}

function facebookRedirectUri(appUrl: string) {
  return `${appUrl.replace(/\/$/, '')}/api/facebook/oauth/callback`
}

function selectablePages<T extends { tasks: string[] }>(pages: T[]) {
  return pages.filter((page) =>
    page.tasks.some((task) => task === 'MESSAGING' || task.endsWith('_MESSAGING')),
  )
}
