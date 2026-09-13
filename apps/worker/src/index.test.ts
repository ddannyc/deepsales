import { afterEach, describe, expect, it, vi } from 'vitest'
import { app, hasValidSignature } from './index'

const bindings = {
  META_APP_SECRET: 'test-app-secret',
  META_VERIFY_TOKEN: 'test-verify-token',
  META_PAGE_ID: 'page-1',
  META_PAGE_ACCESS_TOKEN: 'test-page-token',
  META_GRAPH_API_VERSION: 'v26.0',
  M0_FIXED_REPLY: 'fixed reply',
}

const applicationBindings = {
  ...bindings,
  APP_URL: 'http://localhost:8787',
  BETTER_AUTH_SECRET: 'test-only-secret-that-is-at-least-32-characters',
  HYPERDRIVE: { connectionString: 'postgresql://test:test@127.0.0.1:1/test' } as Hyperdrive,
  AUTH_RATE_LIMITER: {
    limit: vi.fn().mockResolvedValue({ success: true }),
  } as unknown as RateLimit,
}

afterEach(() => vi.unstubAllGlobals())

describe('M0 Facebook webhook', () => {
  it('answers Meta verification only for the configured token', async () => {
    const response = await app.request(
      '/webhooks/facebook?hub.mode=subscribe&hub.verify_token=test-verify-token&hub.challenge=12345',
      undefined,
      bindings,
    )
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('12345')

    const rejected = await app.request(
      '/webhooks/facebook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=12345',
      undefined,
      bindings,
    )
    expect(rejected.status).toBe(403)

    const missingConfiguration = await app.request(
      '/webhooks/facebook?hub.mode=subscribe&hub.challenge=12345',
      undefined,
      { ...bindings, META_VERIFY_TOKEN: '' },
    )
    expect(missingConfiguration.status).toBe(403)
  })

  it('validates signatures, parses one inbound text, and replies once', async () => {
    const body = JSON.stringify({
      object: 'page',
      entry: [
        {
          id: 'page-1',
          messaging: [
            {
              sender: { id: 'psid-1' },
              recipient: { id: 'page-1' },
              message: { mid: 'mid-once', text: 'hello' },
            },
          ],
        },
      ],
    })
    const signature = await sign(body, bindings.META_APP_SECRET)
    expect(
      await hasValidSignature(
        new TextEncoder().encode(body).buffer as ArrayBuffer,
        signature,
        bindings.META_APP_SECRET,
      ),
    ).toBe(true)

    const send = vi
      .fn()
      .mockResolvedValue(Response.json({ recipient_id: 'psid-1', message_id: 'outbound-1' }))
    vi.stubGlobal('fetch', send)

    await deliver(body, signature)
    await deliver(body, signature)

    expect(send).toHaveBeenCalledOnce()
    expect(send).toHaveBeenCalledWith(
      'https://graph.facebook.com/v26.0/page-1/messages',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer test-page-token' }),
      }),
    )
    expect(JSON.parse(send.mock.calls[0][1].body)).toEqual({
      recipient: { id: 'psid-1' },
      messaging_type: 'RESPONSE',
      message: { text: 'fixed reply' },
    })
  })

  it('rejects an invalid signature before parsing or sending', async () => {
    const send = vi.fn()
    vi.stubGlobal('fetch', send)
    const response = await deliver('{}', `sha256=${'0'.repeat(64)}`)
    expect(response.status).toBe(401)
    expect(send).not.toHaveBeenCalled()
  })
})

describe('application readiness', () => {
  it('reports process health without touching infrastructure', async () => {
    const response = await app.request('/health', undefined, bindings)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
  })

  it('reports a missing database binding without exposing configuration', async () => {
    const response = await app.request('/ready', undefined, bindings)

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({
      ok: false,
      error: { code: 'NOT_READY', message: 'Database is unavailable' },
    })
  })

  it('reports a database failure and incomplete webhook configuration', async () => {
    const failedDatabase = await app.request('/ready', undefined, applicationBindings)
    const missingWebhookSecret = await app.request('/ready', undefined, {
      ...applicationBindings,
      META_APP_SECRET: '',
    })

    expect(failedDatabase.status).toBe(503)
    expect(missingWebhookSecret.status).toBe(503)
  })

  it('rate limits credential attempts before opening a database connection', async () => {
    const limit = vi.fn().mockResolvedValue({ success: false })
    const response = await app.request(
      '/api/auth/sign-in/email',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'owner@example.com', password: 'password' }),
      },
      { ...applicationBindings, AUTH_RATE_LIMITER: { limit } as unknown as RateLimit },
    )

    expect(response.status).toBe(429)
    expect(await response.json()).toEqual({
      error: { code: 'RATE_LIMITED', message: 'Try again later' },
    })
    expect(limit).toHaveBeenCalledOnce()
  })

  it('wraps authentication validation errors in the API error envelope', async () => {
    const response = await app.request(
      '/api/auth/sign-in/email',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      },
      applicationBindings,
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: { code: 'VALIDATION_ERROR', message: expect.any(String) },
    })
  })

  it('wraps unexpected API failures without exposing internals', async () => {
    const response = await app.request(
      '/api/auth/sign-in/email',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'owner@example.com', password: 'password' }),
      },
      {
        ...applicationBindings,
        AUTH_RATE_LIMITER: {
          limit: vi.fn().mockRejectedValue(new Error('secret infrastructure detail')),
        } as unknown as RateLimit,
      },
    )

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'Request failed' },
    })
  })
})

async function deliver(body: string, signature: string): Promise<Response> {
  const pending: Promise<unknown>[] = []
  const executionContext = {
    waitUntil(promise: Promise<unknown>) {
      pending.push(promise)
    },
    passThroughOnException() {},
  } as ExecutionContext
  const response = await app.fetch(
    new Request('https://example.com/webhooks/facebook', {
      method: 'POST',
      headers: { 'x-hub-signature-256': signature },
      body,
    }),
    bindings,
    executionContext,
  )
  await Promise.all(pending)
  return response
}

async function sign(body: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body))
  return `sha256=${Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, '0')).join('')}`
}
