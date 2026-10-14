import { z } from 'zod'

export const FACEBOOK_PERMISSIONS = [
  'pages_messaging',
  'pages_manage_metadata',
  'pages_show_list',
] as const
export const TOKEN_KEY_VERSION = 'v1'
export const FACEBOOK_ATTACHMENT_SOURCE_TTL_MS = 60 * 60 * 1_000
export const MAX_FACEBOOK_WEBHOOK_EVENTS = 100
const FACEBOOK_PROVIDER_TIMEOUT_MS = 15_000

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
type TokenKeyUsage = 'encrypt' | 'decrypt'

export type FacebookPage = {
  id: string
  name: string
  accessToken: string
  tasks: string[]
}

export type FacebookPageSummary = Omit<FacebookPage, 'accessToken'>

export type FacebookAttachmentKind = 'IMAGE' | 'FILE' | 'AUDIO' | 'VIDEO'

export type FacebookInboundAttachment = {
  kind: FacebookAttachmentKind
  sourceUrl: string
  filename: string | null
  mimeType: string | null
}

export class FacebookProviderError extends Error {
  constructor(
    readonly status: number,
    readonly providerCode: number | null,
    readonly providerSubcode: number | null,
    readonly providerType: string | null,
    readonly providerMessage: string,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super('Facebook provider request failed')
  }
}

export class FacebookWebhookPayloadError extends Error {
  constructor(readonly code: 'TOO_MANY_EVENTS') {
    super(code)
  }
}

export function createFacebookAdapter(
  config: {
    appId: string
    appSecret: string
    graphApiVersion: string
    graphBaseUrl?: string
  },
  fetcher: Fetcher = globalThis.fetch,
) {
  const graphBase =
    config.graphBaseUrl?.replace(/\/$/, '') ??
    `https://graph.facebook.com/${config.graphApiVersion}`

  return {
    async exchangeCode(code: string, redirectUri: string) {
      const url = new URL(`${graphBase}/oauth/access_token`)
      url.searchParams.set('client_id', config.appId)
      url.searchParams.set('client_secret', config.appSecret)
      url.searchParams.set('redirect_uri', redirectUri)
      url.searchParams.set('code', code)
      const result = await graphRequest(fetcher, url, { method: 'GET' })
      const accessToken = z.object({ access_token: z.string().min(1) }).safeParse(result)
      if (!accessToken.success) throw invalidProviderResponse()
      return accessToken.data.access_token
    },

    async listPages(userAccessToken: string): Promise<FacebookPage[]> {
      const url = new URL(`${graphBase}/me/accounts`)
      url.searchParams.set('fields', 'id,name,access_token,tasks')
      const result = await graphRequest(fetcher, url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${userAccessToken}` },
      })
      const pages = z
        .object({
          data: z.array(
            z.object({
              id: z.string().min(1),
              name: z.string().min(1),
              access_token: z.string().min(1),
              tasks: z.array(z.string()).optional().default([]),
            }),
          ),
        })
        .safeParse(result)
      if (!pages.success) throw invalidProviderResponse()
      return pages.data.data.map(({ id, name, access_token, tasks }) => ({
        id,
        name,
        accessToken: access_token,
        tasks,
      }))
    },

    async subscribePage(pageId: string, pageAccessToken: string) {
      const url = new URL(`${graphBase}/${encodeURIComponent(pageId)}/subscribed_apps`)
      const result = await graphRequest(fetcher, url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${pageAccessToken}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          subscribed_fields:
            'messages,message_deliveries,message_reads,message_echoes,messaging_referrals',
        }),
      })
      if (
        typeof result === 'object' &&
        result !== null &&
        'success' in result &&
        result.success === false
      ) {
        throw invalidProviderResponse()
      }
    },

    async checkPageSubscription(pageId: string, pageAccessToken: string) {
      const url = new URL(`${graphBase}/${encodeURIComponent(pageId)}/subscribed_apps`)
      const result = await graphRequest(fetcher, url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${pageAccessToken}` },
      })
      const subscriptions = z
        .object({ data: z.array(z.object({ id: z.string().min(1) })) })
        .safeParse(result)
      if (
        !subscriptions.success ||
        !subscriptions.data.data.some(({ id }) => id === config.appId)
      ) {
        throw invalidProviderResponse()
      }
    },

    async uploadAttachment(
      pageId: string,
      kind: FacebookAttachmentKind,
      file: File,
      pageAccessToken: string,
    ) {
      const form = new FormData()
      form.set(
        'message',
        JSON.stringify({
          attachment: { type: kind.toLowerCase(), payload: { is_reusable: true } },
        }),
      )
      form.set('filedata', file)
      const result = await graphRequest(
        fetcher,
        new URL(`${graphBase}/${encodeURIComponent(pageId)}/message_attachments`),
        { method: 'POST', headers: { Authorization: `Bearer ${pageAccessToken}` }, body: form },
      )
      const uploaded = z.object({ attachment_id: z.string().min(1) }).safeParse(result)
      if (!uploaded.success) throw invalidProviderResponse()
      return uploaded.data.attachment_id
    },

    async sendAttachment(
      pageId: string,
      externalUserId: string,
      kind: FacebookAttachmentKind,
      attachmentId: string,
      pageAccessToken: string,
      purpose: 'RESPONSE' | 'UPDATE' = 'RESPONSE',
    ) {
      const result = await graphRequest(
        fetcher,
        new URL(`${graphBase}/${encodeURIComponent(pageId)}/messages`),
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${pageAccessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            recipient: { id: externalUserId },
            messaging_type: purpose,
            message: {
              attachment: { type: kind.toLowerCase(), payload: { attachment_id: attachmentId } },
            },
          }),
        },
      )
      const sent = z.object({ message_id: z.string().min(1) }).safeParse(result)
      if (!sent.success) throw invalidProviderResponse()
      return { externalMessageId: sent.data.message_id }
    },

    async sendText(
      pageId: string,
      externalUserId: string,
      text: string,
      pageAccessToken: string,
      purpose: 'RESPONSE' | 'UPDATE' = 'RESPONSE',
    ): Promise<{ externalMessageId: string }> {
      const url = new URL(`${graphBase}/${encodeURIComponent(pageId)}/messages`)
      const result = await graphRequest(fetcher, url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${pageAccessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          recipient: { id: externalUserId },
          messaging_type: purpose,
          message: { text },
        }),
      })
      const sent = z.object({ message_id: z.string().min(1) }).safeParse(result)
      if (!sent.success) throw invalidProviderResponse()
      return { externalMessageId: sent.data.message_id }
    },
  }
}

export function buildFacebookOAuthUrl(input: {
  appId: string
  graphApiVersion: string
  redirectUri: string
  state: string
}) {
  const url = new URL(`https://www.facebook.com/${input.graphApiVersion}/dialog/oauth`)
  url.searchParams.set('client_id', input.appId)
  url.searchParams.set('redirect_uri', input.redirectUri)
  url.searchParams.set('state', input.state)
  url.searchParams.set('scope', FACEBOOK_PERMISSIONS.join(','))
  url.searchParams.set('response_type', 'code')
  return url.toString()
}

export type EncryptedFacebookToken = {
  ciphertext: string
  iv: string
  keyVersion: string
}

export async function encryptFacebookToken(
  token: string,
  keyMaterial: string,
): Promise<EncryptedFacebookToken> {
  const key = await importTokenKey(keyMaterial, ['encrypt'])
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(token),
  )
  return {
    ciphertext: encodeBase64(new Uint8Array(ciphertext)),
    iv: encodeBase64(iv),
    keyVersion: TOKEN_KEY_VERSION,
  }
}

export async function decryptFacebookToken(
  encrypted: EncryptedFacebookToken,
  keyMaterial: string,
): Promise<string> {
  if (encrypted.keyVersion !== TOKEN_KEY_VERSION) throw new Error('Unsupported token key version')
  const key = await importTokenKey(keyMaterial, ['decrypt'])
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: decodeBase64(encrypted.iv) },
    key,
    decodeBase64(encrypted.ciphertext),
  )
  return new TextDecoder().decode(plaintext)
}

export function isValidTokenEncryptionKey(value: string | undefined) {
  if (!value?.trim()) return false
  try {
    decodeKeyMaterial(value)
    return true
  } catch {
    return false
  }
}

export function redactedFacebookFailure(
  error: unknown,
  secrets: string[] = [],
): { code: string; subcode: number | null; message: string } {
  if (!(error instanceof FacebookProviderError)) {
    return { code: 'FACEBOOK_PROVIDER_ERROR', subcode: null, message: 'Facebook request failed' }
  }
  const code =
    error.providerCode === null ? 'FACEBOOK_PROVIDER_ERROR' : `META_${error.providerCode}`
  return {
    code,
    subcode: error.providerSubcode,
    message: redactFacebookMessage(error.providerMessage, secrets),
  }
}

export function isRetryableFacebookFailure(error: unknown) {
  if (!(error instanceof FacebookProviderError)) return false
  return error.status === 408 || error.status === 425 || error.status === 429 || error.status >= 500
}

export function isFacebookReplyWindowOpen(eligibleUntil: Date | null, now = new Date()) {
  return Boolean(eligibleUntil && eligibleUntil.getTime() > now.getTime())
}

export type FacebookInboundEvent = {
  pageId: string
  externalUserId: string
  externalMessageId: string
  text: string | null
  attachments: FacebookInboundAttachment[]
  providerSentAt: Date | null
  eventFragment: Record<string, unknown>
}

const facebookAttachmentKindSchema = z.enum(['IMAGE', 'FILE', 'AUDIO', 'VIDEO'])
const facebookQueuedAttachmentSchema = z
  .object({
    kind: facebookAttachmentKindSchema,
    filename: z.string().max(500).nullable(),
    mimeType: z.string().max(200).nullable(),
    encryptedSourceUrl: z.string().min(1).max(10_000),
    urlIv: z.string().min(1).max(200),
    tokenKeyVersion: z.string().min(1).max(50),
    expiresAt: z.string().datetime(),
  })
  .strict()
const facebookInboundEventSchema = z
  .object({
    pageId: z.string().min(1).max(200),
    externalUserId: z.string().min(1).max(500),
    externalMessageId: z.string().min(1).max(500),
    text: z.string().max(100_000).nullable().default(null),
    attachments: z.array(facebookQueuedAttachmentSchema).max(10).default([]),
    providerSentAt: z.string().datetime().nullable(),
    eventFragment: z.record(z.string(), z.unknown()),
  })
  .strict()
  .refine(({ text, attachments }) => Boolean(text?.trim()) || attachments.length > 0, {
    message: 'Message text or attachment is required',
  })

export const facebookWebhookJobSchema = z
  .object({
    v: z.literal(1),
    type: z.literal('facebook.inbound'),
    ingressId: z.string().min(1).max(200),
    payloadSha256: z.string().regex(/^[0-9a-f]{64}$/i),
    receivedAt: z.string().datetime(),
    event: facebookInboundEventSchema,
  })
  .strict()

export type FacebookWebhookJob = z.infer<typeof facebookWebhookJobSchema>

export const facebookReceiptEventSchema = z
  .object({
    pageId: z.string().min(1).max(200),
    externalUserId: z.string().min(1).max(200),
    kind: z.enum(['delivery', 'read', 'echo']),
    mids: z.array(z.string().min(1).max(500)).max(100),
    watermark: z.string().datetime().nullable(),
    providerSentAt: z.string().datetime().nullable(),
  })
  .strict()
  .refine((e) =>
    e.kind === 'echo'
      ? e.mids.length === 1 && e.providerSentAt !== null
      : e.kind === 'read'
        ? e.watermark !== null
        : e.mids.length > 0 || e.watermark !== null,
  )

export const facebookReceiptJobSchema = z
  .object({
    v: z.literal(1),
    type: z.literal('facebook.receipt'),
    event: facebookReceiptEventSchema,
  })
  .strict()

export function normalizeFacebookReceipts(payload: unknown) {
  const events: z.infer<typeof facebookReceiptEventSchema>[] = []
  if (!isRecord(payload) || payload.object !== 'page' || !Array.isArray(payload.entry))
    return events
  for (const entry of payload.entry) {
    if (!isRecord(entry) || typeof entry.id !== 'string' || !Array.isArray(entry.messaging))
      continue
    for (const event of entry.messaging) {
      if (!isRecord(event) || !isRecord(event.sender) || !isRecord(event.recipient)) continue
      const echo = isRecord(event.message) && event.message.is_echo === true
      const kind = echo
        ? 'echo'
        : isRecord(event.delivery)
          ? 'delivery'
          : isRecord(event.read)
            ? 'read'
            : null
      if (!kind || (echo ? event.sender.id : event.recipient.id) !== entry.id) continue
      const detail =
        kind === 'delivery' ? event.delivery : kind === 'read' ? event.read : event.message
      if (!isRecord(detail)) continue
      const parsed = facebookReceiptEventSchema.safeParse({
        pageId: entry.id,
        externalUserId: echo ? event.recipient.id : event.sender.id,
        kind,
        mids: echo ? [detail.mid] : kind === 'delivery' ? (detail.mids ?? []) : [],
        watermark: providerTimestamp(detail.watermark)?.toISOString() ?? null,
        providerSentAt: echo ? (providerTimestamp(event.timestamp)?.toISOString() ?? null) : null,
      })
      if (!parsed.success) continue
      if (events.length >= MAX_FACEBOOK_WEBHOOK_EVENTS)
        throw new FacebookWebhookPayloadError('TOO_MANY_EVENTS')
      events.push(parsed.data)
    }
  }
  return events
}

export const facebookAttachmentJobSchema = z
  .object({
    v: z.literal(1),
    type: z.literal('facebook.attachment'),
    attachmentId: z.string().uuid(),
  })
  .strict()

export type FacebookAttachmentJob = z.infer<typeof facebookAttachmentJobSchema>

export const facebookOutboundJobSchema = z
  .object({
    v: z.literal(1),
    type: z.literal('facebook.outbound'),
    messageId: z.string().uuid(),
  })
  .strict()

export type FacebookOutboundJob = z.infer<typeof facebookOutboundJobSchema>

export function normalizeFacebookWebhook(payload: unknown, expectedPageId?: string) {
  if (!isRecord(payload) || payload.object !== 'page' || !Array.isArray(payload.entry)) return []

  const events: FacebookInboundEvent[] = []
  for (const rawEntry of payload.entry) {
    if (!isRecord(rawEntry) || typeof rawEntry.id !== 'string') continue
    if (expectedPageId && rawEntry.id !== expectedPageId) continue
    if (!Array.isArray(rawEntry.messaging)) continue

    for (const rawEvent of rawEntry.messaging) {
      if (!isRecord(rawEvent) || !isRecord(rawEvent.sender) || !isRecord(rawEvent.message)) {
        continue
      }
      const senderId = rawEvent.sender.id
      const messageId = rawEvent.message.mid
      const text = rawEvent.message.text
      if (typeof senderId !== 'string' || typeof messageId !== 'string') continue
      if (rawEvent.message.is_echo === true) {
        continue
      }

      const attachments = normalizeFacebookAttachments(rawEvent.message.attachments)
      const messageText = typeof text === 'string' && text.length ? text : null
      if (!messageText && !attachments.length) continue

      if (events.length >= MAX_FACEBOOK_WEBHOOK_EVENTS) {
        throw new FacebookWebhookPayloadError('TOO_MANY_EVENTS')
      }

      const providerSentAt = providerTimestamp(rawEvent.timestamp)
      events.push({
        pageId: rawEntry.id,
        externalUserId: senderId,
        externalMessageId: messageId,
        text: messageText,
        attachments,
        providerSentAt,
        eventFragment: {
          entryId: rawEntry.id,
          senderId,
          messageId,
          providerTimestamp: providerSentAt?.toISOString() ?? null,
          attachmentKinds: attachments.map(({ kind }) => kind),
        },
      })
    }
  }
  return events
}

export async function encryptFacebookAttachmentSources(
  event: FacebookInboundEvent,
  keyMaterial: string,
  receivedAt = new Date(),
) {
  const expiresAt = new Date(receivedAt.getTime() + FACEBOOK_ATTACHMENT_SOURCE_TTL_MS)
  const attachments = await Promise.all(
    event.attachments.map(async (attachment) => {
      const encrypted = await encryptFacebookToken(attachment.sourceUrl, keyMaterial)
      return {
        kind: attachment.kind,
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        encryptedSourceUrl: encrypted.ciphertext,
        urlIv: encrypted.iv,
        tokenKeyVersion: encrypted.keyVersion,
        expiresAt: expiresAt.toISOString(),
      }
    }),
  )
  return { ...event, attachments }
}

async function graphRequest(fetcher: Fetcher, url: URL, init: RequestInit): Promise<unknown> {
  let response: Response
  try {
    response = await fetcher(url, {
      ...init,
      signal: AbortSignal.timeout(FACEBOOK_PROVIDER_TIMEOUT_MS),
    })
  } catch {
    throw new FacebookProviderError(0, null, null, null, 'Network request failed')
  }
  const result = await response.json().catch(() => null)
  if (!response.ok || isGraphError(result)) {
    const error = isGraphError(result) ? result.error : {}
    throw new FacebookProviderError(
      response.status,
      numberOrNull(error.code),
      numberOrNull(error.error_subcode),
      stringOrNull(error.type),
      stringOrNull(error.message) ?? 'Facebook request failed',
      parseRetryAfter(response.headers.get('Retry-After')),
    )
  }
  return result
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null
  const seconds = /^\d+$/.test(value.trim())
    ? Number(value)
    : Math.ceil((Date.parse(value) - Date.now()) / 1000)
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds, 2_147_483_647) : null
}

function isGraphError(value: unknown): value is { error: Record<string, unknown> } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'error' in value &&
    typeof value.error === 'object' &&
    value.error !== null
  )
}

function invalidProviderResponse() {
  return new FacebookProviderError(502, null, null, null, 'Invalid Facebook response')
}

function redactFacebookMessage(message: string, secrets: string[]) {
  let redacted = message
  for (const secret of secrets.filter(Boolean)) redacted = redacted.replaceAll(secret, '[redacted]')
  return redacted
    .replace(
      /(["']?(?:access_token|client_secret|code|state)["']?\s*[:=]\s*["']?)[^"'&,\s}]+/gi,
      '$1[redacted]',
    )
    .replace(/Bearer\s+[^"'\s,}]+/gi, 'Bearer [redacted]')
    .replace(/(access_token|client_secret|code|state)=[^&\s]+/gi, '$1=[redacted]')
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[redacted-url]')
    .replace(/\b\d{8,}\b/g, '[redacted-id]')
    .slice(0, 500)
}

async function importTokenKey(keyMaterial: string, usages: TokenKeyUsage[]) {
  const bytes = decodeKeyMaterial(keyMaterial)
  return crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, usages)
}

function decodeKeyMaterial(value: string) {
  const material = value.trim()
  if (/^[0-9a-f]{64}$/i.test(material)) {
    const bytes = material.match(/.{2}/g)
    if (bytes) return Uint8Array.from(bytes, (byte) => Number.parseInt(byte, 16))
  }
  const bytes = decodeBase64(material)
  if (bytes.length !== 32) throw new Error('TOKEN_ENCRYPTION_KEY must contain 32 bytes')
  return bytes
}

function encodeBase64(bytes: Uint8Array) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function decodeBase64(value: string) {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/')
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
  const binary = atob(padded)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

function numberOrNull(value: unknown) {
  return typeof value === 'number' && Number.isInteger(value) ? value : null
}

function stringOrNull(value: unknown) {
  return typeof value === 'string' ? value : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function providerTimestamp(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

function normalizeFacebookAttachments(value: unknown): FacebookInboundAttachment[] {
  if (!Array.isArray(value)) return []
  const attachments: FacebookInboundAttachment[] = []
  for (const rawAttachment of value) {
    if (!isRecord(rawAttachment) || typeof rawAttachment.type !== 'string') continue
    const kind = {
      image: 'IMAGE',
      file: 'FILE',
      audio: 'AUDIO',
      video: 'VIDEO',
    }[rawAttachment.type.toLowerCase()] as FacebookAttachmentKind | undefined
    if (!kind) continue

    const payload = isRecord(rawAttachment.payload) ? rawAttachment.payload : rawAttachment
    const sourceUrl = stringValue(payload.url)
    if (!sourceUrl || !isHttpUrl(sourceUrl)) continue
    attachments.push({
      kind,
      sourceUrl,
      filename:
        stringValue(payload.filename) ??
        stringValue(payload.name) ??
        stringValue(payload.title) ??
        null,
      mimeType: stringValue(payload.mime_type) ?? stringValue(payload.mimeType) ?? null,
    })
  }
  return attachments
}

function stringValue(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 500) : null
}

export function isHttpUrl(value: string) {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
}
