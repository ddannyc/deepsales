import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Bindings } from './bindings'
import { MAX_FACEBOOK_WEBHOOK_EVENTS } from './facebook'
import { app } from './index'
import { MAX_FACEBOOK_WEBHOOK_BODY_BYTES } from './limits'

const bindings = {
  META_APP_ID: 'test-app-id',
  META_APP_SECRET: 'test-app-secret',
  META_VERIFY_TOKEN: 'test-verify-token',
  META_GRAPH_API_VERSION: 'v26.0',
  TOKEN_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
} as unknown as Bindings

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

describe('invitation-only signup', () => {
  it('rejects public signup without an invitation before opening the database', async () => {
    const response = await app.request(
      '/api/auth/sign-up/email',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Public User',
          email: 'public@example.com',
          password: 'correct-horse-battery-staple',
        }),
      },
      applicationBindings,
    )

    expect(response.status).toBe(403)
    const payload = (await response.json()) as { error: { code: string } }
    expect(payload.error.code).toBe('INVITATION_REQUIRED')
  })
})

describe('Facebook webhook', () => {
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

  it('rejects an invalid signature before parsing or sending', async () => {
    const send = vi.fn()
    vi.stubGlobal('fetch', send)
    const response = await deliver('{}', `sha256=${'0'.repeat(64)}`)
    expect(response.status).toBe(401)
    expect(send).not.toHaveBeenCalled()
  })

  it('rejects an oversized body before signature verification', async () => {
    const send = vi.fn()
    const body = JSON.stringify({ payload: 'x'.repeat(MAX_FACEBOOK_WEBHOOK_BODY_BYTES) })
    const response = await deliver(body, `sha256=${'0'.repeat(64)}`, {
      ...bindings,
      WEBHOOKS_QUEUE: { send } as unknown as Queue,
    })

    expect(response.status).toBe(413)
    expect(send).not.toHaveBeenCalled()
  })

  it('rejects an oversized event batch without partially publishing jobs', async () => {
    const body = JSON.stringify({
      object: 'page',
      entry: [
        {
          id: 'page-1',
          messaging: Array.from({ length: MAX_FACEBOOK_WEBHOOK_EVENTS + 1 }, (_, index) => ({
            sender: { id: `customer-${index}` },
            message: { mid: `mid-${index}`, text: 'hello' },
          })),
        },
      ],
    })
    const signature = await sign(body, bindings.META_APP_SECRET)
    const send = vi.fn()
    const response = await deliver(body, signature, {
      ...bindings,
      WEBHOOKS_QUEUE: { send } as unknown as Queue,
    })

    expect(response.status).toBe(413)
    expect(send).not.toHaveBeenCalled()
  })

  it('publishes one versioned durable job per normalized message before acknowledging', async () => {
    const body = JSON.stringify({
      object: 'page',
      entry: [
        {
          id: 'page-1',
          messaging: [
            {
              timestamp: 1_700_000_000_000,
              sender: { id: 'customer-1' },
              message: { mid: 'mid-queued', text: 'hello queue' },
            },
          ],
        },
      ],
    })
    const signature = await sign(body, bindings.META_APP_SECRET)
    const send = vi.fn().mockResolvedValue(undefined)

    const response = await deliver(body, signature, {
      ...bindings,
      APP_URL: 'http://localhost:8787',
      WEBHOOKS_QUEUE: { send } as unknown as Queue,
    })

    expect(response.status).toBe(200)
    expect(send).toHaveBeenCalledOnce()
    expect(send.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        v: 1,
        type: 'facebook.inbound',
        event: expect.objectContaining({
          pageId: 'page-1',
          externalUserId: 'customer-1',
          externalMessageId: 'mid-queued',
          text: 'hello queue',
        }),
      }),
    )
  })

  it('encrypts attachment source URLs before publishing the webhook job', async () => {
    const body = JSON.stringify({
      object: 'page',
      entry: [
        {
          id: 'page-1',
          messaging: [
            {
              sender: { id: 'customer-1' },
              message: {
                mid: 'mid-attachment-queued',
                attachments: [
                  {
                    type: 'image',
                    payload: { url: 'https://provider.example/image.jpg' },
                  },
                ],
              },
            },
          ],
        },
      ],
    })
    const signature = await sign(body, bindings.META_APP_SECRET)
    const send = vi.fn().mockResolvedValue(undefined)

    const response = await deliver(body, signature, {
      ...bindings,
      WEBHOOKS_QUEUE: { send } as unknown as Queue,
    })

    expect(response.status).toBe(200)
    expect(send).toHaveBeenCalledOnce()
    const job = send.mock.calls[0]?.[0] as {
      event: { attachments: Array<Record<string, unknown>> }
    }
    expect(JSON.stringify(job)).not.toContain('provider.example')
    expect(job.event.attachments[0]).toEqual(
      expect.objectContaining({ kind: 'IMAGE', tokenKeyVersion: 'v1' }),
    )
  })

  it('returns a retryable error when durable webhook publication fails', async () => {
    const body = JSON.stringify({
      object: 'page',
      entry: [
        {
          id: 'page-1',
          messaging: [
            { sender: { id: 'customer-1' }, message: { mid: 'mid-failed', text: 'hello' } },
          ],
        },
      ],
    })
    const signature = await sign(body, bindings.META_APP_SECRET)
    const response = await deliver(body, signature, {
      ...bindings,
      APP_URL: 'http://localhost:8787',
      WEBHOOKS_QUEUE: {
        send: vi.fn().mockRejectedValue(new Error('queue down')),
      } as unknown as Queue,
    })

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({
      error: { code: 'QUEUE_UNAVAILABLE', message: 'Webhook queue is unavailable' },
    })
  })
})

describe('application readiness', () => {
  it('reports process health without touching infrastructure', async () => {
    const response = await app.request('/health', undefined, bindings)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
  })

  it('adds baseline security headers and enables HSTS for HTTPS deployments', async () => {
    const response = await app.request('/health', undefined, {
      ...bindings,
      APP_URL: 'https://app.example.com',
    })

    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('x-frame-options')).toBe('DENY')
    expect(response.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin')
    expect(response.headers.get('permissions-policy')).toBe(
      'camera=(), microphone=(), geolocation=()',
    )
    expect(response.headers.get('strict-transport-security')).toBe(
      'max-age=31536000; includeSubDomains',
    )
  })

  it('rejects cross-origin cookie-authenticated mutations before opening the database', async () => {
    const response = await app.request(
      '/api/workspaces',
      {
        method: 'POST',
        headers: {
          Origin: 'https://attacker.example.com',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: 'attacker workspace' }),
      },
      applicationBindings,
    )

    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({
      error: { code: 'ORIGIN_NOT_ALLOWED', message: 'Request origin is not allowed' },
    })
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

  it('fails closed when the deployment URL is still a placeholder', async () => {
    const limit = vi.fn()
    const response = await app.request(
      '/api/auth/sign-in/email',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'owner@example.com', password: 'password' }),
      },
      {
        ...applicationBindings,
        APP_URL: 'https://replace-with-production-url.example.com',
        AUTH_RATE_LIMITER: { limit } as unknown as RateLimit,
      },
    )

    expect(response.status).toBe(503)
    expect(limit).not.toHaveBeenCalled()
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

  it('rejects email signup without a valid invitation', async () => {
    const response = await app.request(
      '/api/auth/sign-up/email',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Public User',
          email: 'public@example.com',
          password: 'correct-horse-battery-staple',
        }),
      },
      applicationBindings,
    )

    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({
      error: {
        code: 'INVITATION_REQUIRED',
        message: 'Registration is currently invitation only.',
      },
    })
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

async function deliver(body: string, signature: string, env = bindings): Promise<Response> {
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
    env,
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
