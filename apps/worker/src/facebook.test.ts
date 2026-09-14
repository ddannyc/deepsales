import { describe, expect, it, vi } from 'vitest'
import {
  buildFacebookOAuthUrl,
  createFacebookAdapter,
  decryptFacebookToken,
  encryptFacebookToken,
  FacebookProviderError,
  facebookWebhookJobSchema,
  facebookOutboundJobSchema,
  isFacebookReplyWindowOpen,
  normalizeFacebookWebhook,
  redactedFacebookFailure,
} from './facebook'

const encryptionKey = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)))

describe('Facebook adapter', () => {
  it('normalizes text events without local dedupe or echo data', () => {
    const events = normalizeFacebookWebhook({
      object: 'page',
      entry: [
        {
          id: 'page-1',
          messaging: [
            {
              timestamp: 1_700_000_000_000,
              sender: { id: 'customer-1' },
              message: { mid: 'mid-1', text: 'hello' },
            },
            {
              sender: { id: 'page-1' },
              message: { mid: 'echo-1', text: 'reply', is_echo: true },
            },
          ],
        },
      ],
    })

    expect(events).toHaveLength(1)
    expect(events[0]).toEqual(
      expect.objectContaining({
        pageId: 'page-1',
        externalUserId: 'customer-1',
        externalMessageId: 'mid-1',
        text: 'hello',
        providerSentAt: new Date(1_700_000_000_000),
      }),
    )
    expect(normalizeFacebookWebhook({ object: 'page', entry: [] })).toEqual([])
  })

  it('validates the versioned webhook queue contract', () => {
    expect(
      facebookWebhookJobSchema.parse({
        v: 1,
        type: 'facebook.inbound',
        ingressId: 'ingress-1',
        payloadSha256: 'a'.repeat(64),
        receivedAt: '2026-09-14T00:00:00.000Z',
        event: {
          pageId: 'page-1',
          externalUserId: 'customer-1',
          externalMessageId: 'mid-1',
          text: 'hello',
          providerSentAt: null,
          eventFragment: { messageId: 'mid-1' },
        },
      }),
    ).toEqual(expect.objectContaining({ v: 1, type: 'facebook.inbound' }))
  })

  it('validates the versioned outbound queue contract', () => {
    expect(
      facebookOutboundJobSchema.parse({
        v: 1,
        type: 'facebook.outbound',
        messageId: '00000000-0000-4000-8000-000000000001',
      }),
    ).toEqual({
      v: 1,
      type: 'facebook.outbound',
      messageId: '00000000-0000-4000-8000-000000000001',
    })
  })

  it('builds OAuth with only the approved permissions', () => {
    const url = new URL(
      buildFacebookOAuthUrl({
        appId: 'app-1',
        graphApiVersion: 'v26.0',
        redirectUri: 'https://example.com/api/facebook/oauth/callback',
        state: 'one-time-state',
      }),
    )

    expect(url.searchParams.get('scope')).toBe(
      'pages_messaging,pages_manage_metadata,pages_show_list',
    )
    expect(url.searchParams.get('state')).toBe('one-time-state')
    expect(url.searchParams.get('client_secret')).toBeNull()
  })

  it('encrypts and decrypts tokens with a fresh AES-GCM IV', async () => {
    const first = await encryptFacebookToken('page-secret', encryptionKey)
    const second = await encryptFacebookToken('page-secret', encryptionKey)

    expect(first.ciphertext).not.toContain('page-secret')
    expect(first.iv).not.toBe(second.iv)
    await expect(decryptFacebookToken(first, encryptionKey)).resolves.toBe('page-secret')
  })

  it('keeps provider tokens in authorization headers and exposes page summaries only', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ access_token: 'user-token' }))
      .mockResolvedValueOnce(
        Response.json({
          data: [
            {
              id: 'page-1',
              name: 'Support',
              access_token: 'page-token',
              tasks: ['MODERATE', 'MESSAGING'],
            },
          ],
        }),
      )
      .mockResolvedValueOnce(Response.json({ success: true }))
      .mockResolvedValueOnce(Response.json({ data: [{ id: 'app-1' }] }))
    const adapter = createFacebookAdapter(
      { appId: 'app-1', appSecret: 'app-secret', graphApiVersion: 'v26.0' },
      fetcher,
    )

    await expect(adapter.exchangeCode('oauth-code', 'https://example.com/callback')).resolves.toBe(
      'user-token',
    )
    const pages = await adapter.listPages('user-token')
    expect(pages).toEqual([
      {
        id: 'page-1',
        name: 'Support',
        accessToken: 'page-token',
        tasks: ['MODERATE', 'MESSAGING'],
      },
    ])
    await adapter.subscribePage('page-1', 'page-token')
    await expect(adapter.checkPageSubscription('page-1', 'page-token')).resolves.toBeUndefined()

    expect(fetcher.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({ headers: { Authorization: 'Bearer user-token' } }),
    )
    expect(fetcher.mock.calls[2]?.[1]).toEqual(
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer page-token' }),
      }),
    )
  })

  it('redacts secrets from provider failures', () => {
    const failure = redactedFacebookFailure(
      new FacebookProviderError(400, 190, 463, 'OAuthException', 'access_token=page-secret'),
      ['page-secret'],
    )
    expect(failure).toEqual({
      code: 'META_190',
      subcode: 463,
      message: 'access_token=[redacted]',
    })
    expect(
      redactedFacebookFailure(
        new FacebookProviderError(
          400,
          190,
          null,
          'OAuthException',
          '{"access_token":"page-secret","authorization":"Bearer page-secret"}',
        ),
        ['page-secret'],
      ).message,
    ).toBe('{"access_token":"[redacted]","authorization":"Bearer [redacted]"}')
  })

  it('turns subscription failures into a classified provider error', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        Response.json(
          { error: { code: 190, error_subcode: 463, type: 'OAuthException', message: 'Expired' } },
          { status: 403 },
        ),
      )
    const adapter = createFacebookAdapter(
      { appId: 'app-1', appSecret: 'app-secret', graphApiVersion: 'v26.0' },
      fetcher,
    )

    await expect(adapter.subscribePage('page-1', 'page-token')).rejects.toMatchObject({
      status: 403,
      providerCode: 190,
      providerSubcode: 463,
    })
  })

  it('sends a response text to the recipient with Messenger response semantics', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ message_id: 'outbound-1' }))
    const adapter = createFacebookAdapter(
      { appId: 'app-1', appSecret: 'app-secret', graphApiVersion: 'v26.0' },
      fetcher,
    )

    await expect(adapter.sendText('page-1', 'customer-1', 'hello', 'page-token')).resolves.toEqual({
      externalMessageId: 'outbound-1',
    })

    expect(fetcher).toHaveBeenCalledOnce()
    const [url, init] = fetcher.mock.calls[0] ?? []
    expect(url).toEqual(new URL('https://graph.facebook.com/v26.0/page-1/messages'))
    expect(init).toEqual(
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer page-token' }),
        body: JSON.stringify({
          recipient: { id: 'customer-1' },
          messaging_type: 'RESPONSE',
          message: { text: 'hello' },
        }),
      }),
    )
  })

  it('only permits a response while the stored Messenger window is open', () => {
    const now = new Date('2026-09-14T00:00:00.000Z')
    expect(isFacebookReplyWindowOpen(new Date('2026-09-14T00:00:01.000Z'), now)).toBe(true)
    expect(isFacebookReplyWindowOpen(new Date('2026-09-14T00:00:00.000Z'), now)).toBe(false)
    expect(isFacebookReplyWindowOpen(null, now)).toBe(false)
  })
})
