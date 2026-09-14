import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  createFacebookAdapter: vi.fn(),
  decryptFacebookToken: vi.fn(),
  getFacebookOAuthToken: vi.fn(),
}))

vi.mock('@deepsales/db', () => ({
  assertFacebookPagesAvailable: vi.fn(),
  completeFacebookOAuthSelection: vi.fn(),
  connectFacebookPages: vi.fn(),
  consumeFacebookOAuthState: vi.fn(),
  FacebookError: class FacebookError extends Error {},
  getFacebookChannelForManager: vi.fn(),
  getFacebookOAuthToken: mocks.getFacebookOAuthToken,
  markFacebookChannelHealth: vi.fn(),
  recordFacebookConnectionFailure: vi.fn(),
  startFacebookOAuth: vi.fn(),
  storeFacebookOAuthToken: vi.fn(),
}))

vi.mock('./facebook', async () => {
  const actual = await vi.importActual<typeof import('./facebook')>('./facebook')
  return {
    ...actual,
    createFacebookAdapter: mocks.createFacebookAdapter,
    decryptFacebookToken: mocks.decryptFacebookToken,
  }
})

import { listFacebookOAuthPages } from './facebook-service'

describe('Facebook service provider contract', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getFacebookOAuthToken.mockResolvedValue({
      encryptedUserAccessToken: 'ciphertext',
      userTokenIv: 'iv',
      userTokenKeyVersion: 'v1',
    })
    mocks.decryptFacebookToken.mockResolvedValue('user-token')
  })

  it('keeps Pages whose Meta task names grant messaging access', async () => {
    mocks.createFacebookAdapter.mockReturnValue({
      listPages: vi.fn().mockResolvedValue([
        {
          id: 'page-legacy',
          name: 'Legacy task names',
          accessToken: 'page-token-legacy',
          tasks: ['MODERATE', 'MESSAGING'],
        },
        {
          id: 'page-profile-plus',
          name: 'Profile Plus task names',
          accessToken: 'page-token-profile-plus',
          tasks: ['PROFILE_PLUS_MODERATE', 'PROFILE_PLUS_MESSAGING'],
        },
        {
          id: 'page-no-messaging',
          name: 'No messaging',
          accessToken: 'page-token-no-messaging',
          tasks: ['MODERATE'],
        },
      ]),
    })

    await expect(
      listFacebookOAuthPages(
        {} as Parameters<typeof listFacebookOAuthPages>[0],
        {
          appUrl: 'https://example.com',
          appId: 'app-1',
          appSecret: 'app-secret',
          graphApiVersion: 'v26.0',
          tokenEncryptionKey: 'encryption-key',
        },
        {
          stateId: 'state-1',
          workspaceId: 'workspace-1',
          userId: 'user-1',
        },
      ),
    ).resolves.toEqual([
      {
        id: 'page-legacy',
        name: 'Legacy task names',
        tasks: ['MODERATE', 'MESSAGING'],
      },
      {
        id: 'page-profile-plus',
        name: 'Profile Plus task names',
        tasks: ['PROFILE_PLUS_MODERATE', 'PROFILE_PLUS_MESSAGING'],
      },
    ])
  })
})
