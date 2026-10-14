import {
  type ExternalOutput,
  type ExternalRequestDefinition,
  type ExternalValue,
  validateExternalDefinition,
  validValue,
} from '../../../packages/db/src/ai-external-contracts'

export class ExternalToolError extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}
export function validateExternalOrigin(value: string, allowed: string[]) {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new ExternalToolError('EXTERNAL_ORIGIN_FORBIDDEN')
  }
  if (
    !/^https:\/\/[^\\\s]+$/.test(value) ||
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    url.pathname !== '/' ||
    url.port ||
    !url.hostname.includes('.') ||
    url.hostname.endsWith('.') ||
    /[:[\]]/.test(url.hostname) ||
    /^\d+(\.\d+)*$/.test(url.hostname) ||
    /(^|\.)(localhost|local|internal|invalid|onion|arpa)$/.test(url.hostname) ||
    !allowed.some((candidate) => candidate === url.origin)
  )
    throw new ExternalToolError('EXTERNAL_ORIGIN_FORBIDDEN')
  return url.origin
}
export function buildExternalRequest(
  definition: ExternalRequestDefinition,
  values: Record<string, unknown>,
  allowed: string[],
) {
  validateExternalDefinition(definition)
  const origin = validateExternalOrigin(definition.origin, allowed)
  if (Object.keys(values).some((name) => !definition.inputs.some((field) => field.name === name)))
    throw new ExternalToolError('EXTERNAL_ARGUMENTS_INVALID')
  let path = definition.path
  const query = new URLSearchParams()
  const body: Record<string, ExternalValue> = {}
  for (const field of [...definition.inputs, ...definition.fixed]) {
    const value = 'value' in field ? field.value : values[field.name]
    if (value === undefined && 'required' in field && !field.required) continue
    if (!validValue(value) || ('type' in field && typeof value !== field.type))
      throw new ExternalToolError('EXTERNAL_ARGUMENTS_INVALID')
    if (field.location === 'path') {
      const segment = String(value)
      if (
        !segment ||
        segment.length > 200 ||
        /[/%\\]/.test(segment) ||
        ['.', '..'].includes(segment)
      )
        throw new ExternalToolError('EXTERNAL_PATH_INVALID')
      path = path.replaceAll(`{${field.name}}`, encodeURIComponent(segment))
    } else if (field.location === 'query') query.set(field.name, String(value))
    else body[field.name] = value
  }
  if (/[{}]/.test(path)) throw new ExternalToolError('EXTERNAL_PATH_INVALID')
  const url = new URL(path, origin)
  url.search = query.toString()
  if (url.origin !== origin) throw new ExternalToolError('EXTERNAL_ORIGIN_FORBIDDEN')
  return {
    url: url.href,
    method: definition.method,
    body: Object.keys(body).length ? JSON.stringify(body) : undefined,
  }
}
export async function callExternalTool(
  request: ReturnType<typeof buildExternalRequest>,
  mapping: ExternalOutput[],
  credential: string | null,
  fetcher: typeof fetch = fetch,
) {
  const controller = new AbortController()
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let timeout: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort()
      void reader?.cancel().catch(() => {})
      reject(new ExternalToolError('EXTERNAL_TIMEOUT'))
    }, 10_000)
  })
  try {
    return await Promise.race([
      deadline,
      (async () => {
        const headers: Record<string, string> = { Accept: 'application/json' }
        if (request.body) headers['Content-Type'] = 'application/json'
        if (credential) headers.Authorization = `Bearer ${credential}`
        const response = await fetcher(request.url, {
          method: request.method,
          body: request.body,
          headers,
          redirect: 'manual',
          signal: controller.signal,
        })
        if (response.status >= 300 && response.status < 400) {
          await response.body?.cancel()
          throw new ExternalToolError('EXTERNAL_REDIRECT')
        }
        if (!response.ok) {
          await response.body?.cancel()
          throw new ExternalToolError('EXTERNAL_HTTP_ERROR')
        }
        if (
          !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '') ||
          !response.body
        ) {
          await response.body?.cancel()
          throw new ExternalToolError('EXTERNAL_RESPONSE_INVALID')
        }
        reader = response.body.getReader()
        const chunks: Uint8Array[] = []
        let size = 0
        for (;;) {
          const next = await reader.read()
          if (next.done) break
          size += next.value.byteLength
          if (size > 65536) {
            controller.abort()
            await reader.cancel()
            throw new ExternalToolError('EXTERNAL_RESPONSE_TOO_LARGE')
          }
          chunks.push(next.value)
        }
        const bytes = new Uint8Array(size)
        let offset = 0
        for (const chunk of chunks) {
          bytes.set(chunk, offset)
          offset += chunk.byteLength
        }
        const decoded: unknown = JSON.parse(
          new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes),
        )
        const result: Record<string, ExternalValue> = {}
        for (const field of mapping) {
          let value: unknown = decoded
          for (const key of field.path) {
            if (
              !value ||
              typeof value !== 'object' ||
              !Object.hasOwn(value, key) ||
              ['__proto__', 'constructor', 'prototype'].includes(key)
            )
              throw new ExternalToolError('EXTERNAL_RESPONSE_INVALID')
            value = (value as Record<string, unknown>)[key]
          }
          if (!validValue(value) || typeof value !== field.type)
            throw new ExternalToolError('EXTERNAL_RESPONSE_INVALID')
          result[field.name] = value
        }
        if (JSON.stringify(result).length > 8000)
          throw new ExternalToolError('EXTERNAL_RESPONSE_TOO_LARGE')
        return result
      })(),
    ])
  } catch (error) {
    if (error instanceof ExternalToolError) throw error
    throw new ExternalToolError('EXTERNAL_REQUEST_FAILED')
  } finally {
    clearTimeout(timeout)
    controller.abort()
    await reader?.cancel().catch(() => {})
    reader?.releaseLock()
  }
}
