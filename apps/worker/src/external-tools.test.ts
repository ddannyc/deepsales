import { describe, expect, it, vi } from 'vitest'
import { buildExternalRequest, callExternalTool, validateExternalOrigin } from './external-tools'
import { validateExternalObjectScope } from '../../../packages/db/src/ai-external-contracts'
import { encryptCredential, decryptCredential } from './credential-crypto'
import { instructionTools, validateAiToolCalls } from '@deepsales/db'

const origin = 'https://tools.example.com'
const definition = {
  origin,
  method: 'GET' as const,
  path: '/records/{record}',
  inputs: [{ name: 'record', type: 'string' as const, location: 'path' as const, required: true }],
  fixed: [],
  output: [{ name: 'status', path: ['data', 'status'], type: 'string' as const }],
  effect: 'READ' as const,
}
describe('external HTTPS tool boundary', () => {
  it.each([
    '9000000000000',
    '1000000000000000',
    '-1',
    '1.5',
    '1e4',
    'NaN',
    'Infinity',
    'not-a-date',
    'Fri, 32 Oct 2026 10:00:00 GMT',
  ])(
    'terminates an invalid retry deadline without admitting an earlier retry (%s)',
    async (header) => {
      await expect(
        callExternalTool(
          buildExternalRequest(definition, { record: 'abc' }, [origin]),
          definition.output,
          null,
          async () => new Response(null, { status: 429, headers: { 'Retry-After': header } }),
        ),
      ).rejects.toMatchObject({ code: 'EXTERNAL_RETRY_AFTER_INVALID', retryable: false })
    },
  )
  it('classifies only transient responses for safe read retry and preserves longer provider delay', async () => {
    const request = buildExternalRequest(definition, { record: 'abc' }, [origin])
    await expect(
      callExternalTool(
        request,
        definition.output,
        null,
        async () =>
          new Response(null, {
            status: 429,
            headers: { 'Retry-After': '180' },
          }),
      ),
    ).rejects.toMatchObject({ code: 'EXTERNAL_HTTP_ERROR', retryable: true, retryAfterMs: 180000 })
    await expect(
      callExternalTool(
        request,
        definition.output,
        null,
        async () =>
          new Response(null, {
            status: 401,
          }),
      ),
    ).rejects.toMatchObject({ code: 'EXTERNAL_HTTP_ERROR', retryable: false })
  })
  it.each([301, 302, 303, 307, 308])(
    'rejects HTTP %s redirects without a second request',
    async (status) => {
      const fetcher = vi.fn(
        async () => new Response(null, { status, headers: { Location: `${origin}/other` } }),
      )
      await expect(
        callExternalTool(
          buildExternalRequest(definition, { record: 'abc' }, [origin]),
          definition.output,
          'private',
          fetcher,
        ),
      ).rejects.toMatchObject({ code: 'EXTERNAL_REDIRECT' })
      expect(fetcher).toHaveBeenCalledOnce()
    },
  )
  it('rejects compressed and malformed mapped bodies without exposing credentials or raw fields', async () => {
    const request = buildExternalRequest(definition, { record: 'abc' }, [origin])
    for (const response of [
      new Response('compressed', {
        headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' },
      }),
      Response.json({ data: { status: 'private' } }),
      Response.json({ data: { status: 42 } }),
    ])
      await expect(
        callExternalTool(request, definition.output, 'private', async () => response),
      ).rejects.toMatchObject({ code: 'EXTERNAL_RESPONSE_INVALID' })
  })
  it('recognizes stable external references but never authorizes arbitrary or unreferenced IDs', () => {
    const id = '11111111-1111-4111-8111-111111111111'
    expect(instructionTools(`Use [[tool:external:${id}]]`)).toEqual([`external:${id}`])
    expect(() => instructionTools('[[tool:external:https://tools.example.com]]')).toThrow()
    expect(() =>
      validateAiToolCalls('', [{ tool: 'external', arguments: { definitionId: id, values: {} } }]),
    ).toThrow()
  })
  it('binds declared write targets to immutable configuration and cannot override them through model values', () => {
    const write = {
      ...definition,
      method: 'POST' as const,
      effect: 'WRITE' as const,
      path: '/records',
      inputs: [
        { name: 'note', type: 'string' as const, location: 'body' as const, required: true },
      ],
      fixed: [{ name: 'recordId', location: 'body' as const, value: 'configured-record' }],
    }
    const policy = JSON.stringify({
      policy: 'FIXED_CONFIG',
      description: 'Administrator-authorized support record.',
      targets: [{ name: 'recordId', location: 'body' }],
    })
    expect(() => validateExternalObjectScope(policy, write)).not.toThrow()
    expect(() => validateExternalObjectScope(policy, { ...write, fixed: [] })).toThrow()
    expect(() => validateExternalObjectScope('any object', write)).toThrow()
    expect(() =>
      buildExternalRequest(write, { note: 'hello', recordId: 'other-record' }, [origin]),
    ).toThrow()
    expect(
      JSON.parse(buildExternalRequest(write, { note: 'hello' }, [origin]).body ?? '{}'),
    ).toEqual({ note: 'hello', recordId: 'configured-record' })
  })
  it('binds credential ciphertext to its workspace/plugin while preserving token crypto compatibility', async () => {
    const key = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
    const secret = await encryptCredential('private', key, 'external:workspace:plugin-a')
    expect(await decryptCredential(secret, key, 'external:workspace:plugin-a')).toBe('private')
    await expect(decryptCredential(secret, key, 'external:workspace:plugin-b')).rejects.toThrow()
  })
  it('requires an exact deployment-approved public HTTPS origin and safe encoded segments', () => {
    expect(validateExternalOrigin(origin, [origin])).toBe(origin)
    for (const target of [
      'http://tools.example.com',
      'https://tools.example.com.',
      'https://localhost',
      'https://127.0.0.1',
      'https://2130706433',
      'https://[::1]',
      'https://user@tools.example.com',
      'https://tools.example.com:444',
      'https:\\tools.example.com',
    ])
      expect(() => validateExternalOrigin(target, [origin, target])).toThrow()
    expect(() => validateExternalOrigin(origin, [])).toThrow()
    expect(() => validateExternalOrigin('https://tools.example.com.evil.test', [origin])).toThrow()
    expect(buildExternalRequest(definition, { record: 'record 123' }, [origin]).url).toBe(
      `${origin}/records/record%20123`,
    )
    for (const record of ['..', '../secret', '/admin', '%2fadmin', '%252fadmin', 'a\\b'])
      expect(() => buildExternalRequest(definition, { record }, [origin])).toThrow()
  })
  it('maps only declared fields and rejects redirects without forwarding secrets', async () => {
    const request = buildExternalRequest(definition, { record: 'abc' }, [origin])
    const fetcher = vi.fn(async () =>
      Response.json({ data: { status: 'ready', secret: 'private' } }),
    )
    expect(await callExternalTool(request, definition.output, 'credential', fetcher)).toEqual({
      status: 'ready',
    })
    expect(fetcher.mock.calls).toHaveLength(1)
    const redirect = vi.fn(
      async () =>
        new Response(null, { status: 302, headers: { Location: 'https://other.example.com' } }),
    )
    await expect(
      callExternalTool(request, definition.output, 'credential', redirect),
    ).rejects.toMatchObject({ code: 'EXTERNAL_REDIRECT' })
    expect(redirect).toHaveBeenCalledOnce()
  })
  it('bounds streamed bytes before parsing and cancels an oversized response', async () => {
    const request = buildExternalRequest(definition, { record: 'abc' }, [origin])
    const body = (size: number) =>
      JSON.stringify({ data: { status: 'ready' }, padding: '' }).padEnd(size, ' ')
    expect(
      await callExternalTool(
        request,
        definition.output,
        null,
        async () => new Response(body(65536), { headers: { 'Content-Type': 'application/json' } }),
      ),
    ).toEqual({ status: 'ready' })
    const cancelled = vi.fn()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(65537))
      },
      cancel: cancelled,
    })
    await expect(
      callExternalTool(
        request,
        definition.output,
        null,
        async () =>
          new Response(stream, {
            headers: { 'Content-Type': 'application/json', 'Content-Length': '1' },
          }),
      ),
    ).rejects.toMatchObject({ code: 'EXTERNAL_RESPONSE_TOO_LARGE' })
    expect(cancelled).toHaveBeenCalledOnce()
  })
  it('keeps the ten-second deadline active after headers and cancels stalled bodies', async () => {
    vi.useFakeTimers()
    try {
      const cancelled = vi.fn(() => new Promise<void>(() => {}))
      let signal: AbortSignal | null | undefined
      const stream = new ReadableStream<Uint8Array>({ cancel: cancelled })
      const pending = callExternalTool(
        buildExternalRequest(definition, { record: 'abc' }, [origin]),
        definition.output,
        null,
        async (_url, init) => {
          signal = init?.signal
          return new Response(stream, { headers: { 'Content-Type': 'application/json' } })
        },
      )
      const assertion = expect(pending).rejects.toMatchObject({ code: 'EXTERNAL_TIMEOUT' })
      await vi.advanceTimersByTimeAsync(10_000)
      await assertion
      expect(signal?.aborted).toBe(true)
      expect(cancelled).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })
  it('does not wait for a non-cooperative injected reader cleanup', async () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ data: { status: 'ready' } }))
    const read = vi
      .fn()
      .mockResolvedValueOnce({ done: false, value: bytes })
      .mockResolvedValue({ done: true })
    const cancel = vi.fn(() => new Promise<void>(() => {}))
    const response = {
      ok: true,
      status: 200,
      headers: new Headers({ 'Content-Type': 'application/json' }),
      body: { getReader: () => ({ read, cancel, releaseLock: vi.fn() }) },
    } as unknown as Response
    expect(
      await callExternalTool(
        buildExternalRequest(definition, { record: 'abc' }, [origin]),
        definition.output,
        null,
        async () => response,
      ),
    ).toEqual({ status: 'ready' })
    expect(cancel).toHaveBeenCalled()
  }, 500)
})
