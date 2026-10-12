import { type ChildProcess, type SpawnOptions, spawn } from 'node:child_process'
import { createServer as createHttpServer } from 'node:http'
import { createServer } from 'node:net'
import { dirname, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { eq } from 'drizzle-orm'
import { Pool } from 'pg'
import { createAuth } from '../apps/worker/src/auth'
import type { Bindings } from '../apps/worker/src/bindings'
import { assertTestDatabaseUrl, loadAppEnv } from '../config/env'
import {
  acceptRegistrationInvitation,
  createDatabase,
  createRegistrationInvitation,
  user,
} from '../packages/db/src'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageManager = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const readyTimeoutMs = 30_000
const e2ePassword = 'correct-horse-battery-staple'
const e2eOwnerKeys = [
  'ai-member',
  'ai-response',
  'ai-handoff',
  'ai-bench',
  'ai-persona',
  'lifecycle',
  'facebook',
  'inbox',
  'customer-facts',
  'inbox-reading',
  'inbox-search',
  'inbox-search-team',
  'inbox-search-agent',
  'inbox-collaboration',
  'inbox-collaboration-agent',
  'media',
  'media-other',
  'knowledge',
  'questions',
  'reply',
  'routing',
  'team',
  'workspace',
  'invitation',
  'invitation-existing',
]

function testDatabaseUrl() {
  const { databaseUrl } = loadAppEnv('test')
  if (!databaseUrl) throw new Error('Test DATABASE_URL is required')
  assertTestDatabaseUrl(databaseUrl)
  return databaseUrl
}

function isTestDatabaseName(name: string) {
  return /^(test|e2e)$/i.test(name) || /(?:[-_])(test|e2e)$/i.test(name)
}

async function resetTestDatabase(connectionString: string) {
  const pool = new Pool({ connectionString, max: 1 })
  try {
    const result = await pool.query<{ name: string }>('select current_database() as name')
    const name = result.rows[0]?.name
    if (!name || !isTestDatabaseName(name)) {
      throw new Error('DATABASE_URL resolved to a non-test database')
    }

    await pool.query('drop extension if exists vector cascade')
    await pool.query('drop schema if exists public cascade')
    await pool.query('drop schema if exists drizzle cascade')
    await pool.query('create schema public')
  } finally {
    await pool.end()
  }
}

async function seedE2eUsers(connectionString: string, baseUrl: string) {
  const pool = new Pool({ connectionString, max: 1 })
  const db = createDatabase(pool)
  const auth = createAuth(db, {
    APP_URL: baseUrl,
    BETTER_AUTH_SECRET: 'e2e-only-better-auth-secret-32-characters',
  } as Bindings)

  try {
    for (const key of e2eOwnerKeys) {
      await auth.api.signUpEmail({
        body: {
          name: 'Ada Lovelace',
          email: `e2e-owner-${key}@example.com`,
          password: e2ePassword,
        },
      })
      const email = `e2e-owner-${key}@example.com`
      const [createdUser] = await db
        .select({ id: user.id })
        .from(user)
        .where(eq(user.email, email))
        .limit(1)
      if (!createdUser) throw new Error('E2E user was not created')
      const invitation = await createRegistrationInvitation(db, { email })
      await acceptRegistrationInvitation(db, {
        token: invitation.token,
        userId: createdUser.id,
        userEmail: email,
      })
    }
    const creatorInvitation = await createRegistrationInvitation(db, {
      email: 'e2e-registration@example.com',
    })
    return creatorInvitation.token
  } finally {
    await pool.end()
  }
}

function quoteWindowsArg(value: string) {
  return `"${value.replace(/"/g, '""')}"`
}

function spawnPackageManager(args: string[], options: SpawnOptions) {
  if (process.platform !== 'win32') return spawn(packageManager, args, options)

  const command = ['call pnpm.cmd', ...args.map(quoteWindowsArg)].join(' ')
  return spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', command], {
    ...options,
    windowsVerbatimArguments: true,
  })
}

function run(args: string[], env = process.env) {
  return new Promise<void>((resolve, reject) => {
    const child = spawnPackageManager(args, {
      cwd: root,
      env,
      stdio: 'inherit',
      windowsHide: true,
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`pnpm exited with ${signal ?? `code ${code}`}`))
    })
  })
}

async function freePort() {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Could not allocate a local port')
  const port = address.port
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
  return port
}

function workerBindings(baseUrl: string, facebookGraphBaseUrl: string, aiBaseUrl: string) {
  return {
    APP_URL: baseUrl,
    BETTER_AUTH_SECRET: 'e2e-only-better-auth-secret-32-characters',
    META_APP_ID: 'e2e-meta-app-id',
    META_APP_SECRET: 'e2e-meta-app-secret',
    META_VERIFY_TOKEN: 'e2e-meta-verify-token',
    META_GRAPH_API_VERSION: 'v26.0',
    FACEBOOK_GRAPH_BASE_URL: facebookGraphBaseUrl,
    TOKEN_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    AI_API_KEY: 'e2e-ai-api-key',
    AI_BASE_URL: aiBaseUrl,
    EMBEDDING_PROVIDER: 'alibaba',
    EMBEDDING_MODEL: 'qwen3.7-text-embedding',
    EMBEDDING_DIMENSIONS: '1536',
    LLM_PROVIDER: 'alibaba',
    LLM_MODEL: 'qwen3.8-flash',
  }
}

function startWorker(
  port: number,
  connectionString: string,
  baseUrl: string,
  facebookGraphBaseUrl: string,
  aiBaseUrl: string,
) {
  const args = [
    'exec',
    'wrangler',
    'dev',
    '--config',
    'apps/worker/wrangler.jsonc',
    '--local',
    '--ip',
    '127.0.0.1',
    '--port',
    String(port),
    '--show-interactive-dev-session=false',
  ]
  for (const [key, value] of Object.entries(
    workerBindings(baseUrl, facebookGraphBaseUrl, aiBaseUrl),
  )) {
    args.push('--var', `${key}:${value}`)
  }

  const env = { ...process.env }
  delete env.DATABASE_URL
  delete env.DATABASE_URL_UNPOOLED
  env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE = connectionString

  return spawnPackageManager(args, {
    cwd: root,
    env,
    stdio: 'inherit',
    windowsHide: true,
  })
}

async function startFakeFacebook() {
  let messageNumber = 0
  const sends = new Map<string, number>()
  const uploads = new Map<string, { filename: string; rejected: boolean }>()
  const server = createHttpServer(async (request, response) => {
    const pathname = request.url ? new URL(request.url, 'http://fake-facebook').pathname : ''
    if (request.method === 'GET' && pathname === '/__sent') {
      const recipient = new URL(request.url ?? '/', 'http://fake-facebook').searchParams.get(
        'recipient',
      )
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ count: sends.get(recipient ?? '') ?? 0 }))
      return
    }
    if (request.method === 'GET' && pathname.startsWith('/attachments/')) {
      const file = pathname.split('/').at(-1)
      const attachment =
        file === 'image'
          ? { type: 'image/png', body: Buffer.from('fake-image') }
          : file === 'file'
            ? { type: 'application/pdf', body: Buffer.from('fake-pdf') }
            : file === 'audio'
              ? { type: 'audio/mpeg', body: Buffer.from('fake-audio') }
              : { type: 'video/mp4', body: Buffer.from('fake-video') }
      response.statusCode = 200
      response.setHeader('content-type', attachment.type)
      response.setHeader('content-length', attachment.body.length)
      response.end(attachment.body)
      return
    }
    if (request.method === 'POST' && pathname.endsWith('/message_attachments')) {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const form = await new Request('http://fake-facebook/upload', {
        method: 'POST',
        headers: { 'Content-Type': request.headers['content-type'] ?? '' },
        body: Buffer.concat(chunks),
      }).formData()
      const file = form.get('filedata')
      if (!(file instanceof File) || !file.size) {
        response.statusCode = 400
        response.end('{}')
        return
      }
      const id = crypto.randomUUID()
      uploads.set(id, { filename: file.name, rejected: false })
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ attachment_id: id }))
      return
    }
    if (request.method !== 'POST' || !pathname.endsWith('/messages')) {
      response.statusCode = 404
      response.end()
      return
    }

    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      message?: { text?: string; attachment?: { payload?: { attachment_id?: string } } }
      recipient?: { id?: string }
    }
    if (body.recipient?.id) sends.set(body.recipient.id, (sends.get(body.recipient.id) ?? 0) + 1)
    response.setHeader('content-type', 'application/json')
    const uploaded = uploads.get(body.message?.attachment?.payload?.attachment_id ?? '')
    const rejectMedia = uploaded?.filename === 'reject-once.pdf' && !uploaded.rejected
    if (rejectMedia && uploaded) uploaded.rejected = true
    if (
      body.message?.text === 'force failure' ||
      body.message?.text?.startsWith('Split reject.') ||
      rejectMedia
    ) {
      response.statusCode = 400
      response.end(
        JSON.stringify({
          error: {
            code: 100,
            error_subcode: 10,
            type: 'OAuthException',
            message: 'Fake Facebook rejection',
          },
        }),
      )
      return
    }

    if (body.message?.text?.startsWith('Split first.'))
      await new Promise((resolve) => setTimeout(resolve, 3000))
    response.end(JSON.stringify({ message_id: `fake-message-${++messageNumber}` }))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Could not start fake Facebook')
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

async function startFakeAI() {
  const server = createHttpServer(async (request, response) => {
    const pathname = request.url ? new URL(request.url, 'http://fake-ai').pathname : ''
    if (
      request.method !== 'POST' ||
      (pathname !== '/v1/embeddings' && pathname !== '/v1/chat/completions')
    ) {
      response.statusCode = 404
      response.end()
      return
    }

    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      input?: unknown
      model?: unknown
      dimensions?: unknown
      messages?: Array<{ content?: string }>
    }
    response.setHeader('content-type', 'application/json')
    if (body.messages?.[0]?.content?.includes('AI member configuration draft')) {
      response.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  decision: 'ANSWER',
                  response: 'Be a concise support assistant. Ask clarifying questions when needed.',
                  handoffReason: null,
                  containsBusinessFacts: false,
                  usedChunkIds: [],
                }),
              },
            },
          ],
        }),
      )
      return
    }
    if (pathname === '/v1/embeddings') {
      const input = Array.isArray(body.input) ? body.input : []
      if (body.model !== 'qwen3.7-text-embedding' || body.dimensions !== 1_536) {
        response.statusCode = 400
        response.end()
        return
      }
      await sleep(2_500)
      response.end(
        JSON.stringify({
          data: input.map((_, index) => ({
            index,
            embedding: Array.from({ length: 1_536 }, (_value, position) =>
              position === 0 ? 1 : 0,
            ),
          })),
        }),
      )
      return
    }

    if (body.model !== 'qwen3.8-flash') {
      response.statusCode = 400
      response.end()
      return
    }
    const content = body.messages?.[1]?.content ?? ''
    if (body.messages?.[0]?.content.startsWith('Translate')) {
      const text = (JSON.parse(content) as { text: string }).text
      response.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  decision: 'ANSWER',
                  response:
                    text === '你好'
                      ? 'Hello'
                      : text === '再见'
                        ? 'Goodbye'
                        : '来自 Messenger 的问候',
                  handoffReason: null,
                  containsBusinessFacts: false,
                  usedChunkIds: [],
                }),
              },
            },
          ],
        }),
      )
      return
    }
    const current = /<customer_messages>([\s\S]*?)<\/customer_messages>/.exec(content)?.[1] ?? ''
    const history =
      /<conversation_history>([\s\S]*?)<\/conversation_history>/.exec(content)?.[1] ?? ''
    const options = current.includes('Compare Torch options')
    const secondOption = current.includes('Does the second option come in blue?')
    const humanContinuation = current.includes('Yes, the compact one.')
    const hasReferent = secondOption
      ? history.includes('Option two is Torch Two.')
      : history.includes('origin="HUMAN"') &&
        history.includes('Do you prefer the compact Torch Two?')
    const chunkId =
      options || secondOption || humanContinuation
        ? /<knowledge_chunk id="([^"]+)">Torch One comes in red\. Torch Two comes in blue\./.exec(
            content,
          )?.[1]
        : /<knowledge_chunk id="([^"]+)">/.exec(content)?.[1]
    const mediaMatch = current.includes('Send setup guide')
      ? /<knowledge_chunk id="([^"]+)" media_asset_id="([^"]+)"/.exec(content)
      : null
    const answer = current.includes('Explain split delivery')
      ? `${'Split first.'.padEnd(500, '.')}${'Split reject.'.padEnd(500, '.')}Split tail.`
      : mediaMatch
        ? 'Here is the setup guide.'
        : options
          ? 'Option one is Torch One. Option two is Torch Two.'
          : secondOption || humanContinuation
            ? hasReferent && chunkId
              ? 'Torch Two comes in blue.'
              : 'Please clarify which option.'
            : 'Shipping is free.'
    response.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                decision: 'ANSWER',
                response: answer,
                handoffReason: null,
                containsBusinessFacts:
                  !mediaMatch && !current.includes('Explain split delivery') && Boolean(chunkId),
                usedChunkIds: mediaMatch
                  ? [mediaMatch[1]]
                  : !current.includes('Explain split delivery') && chunkId
                    ? [chunkId]
                    : [],
                mediaAssetId: mediaMatch?.[2] ?? null,
                ...(body.messages?.[0]?.content.includes('Automatic language mode.')
                  ? { languageSelection: null }
                  : {}),
              }),
            },
          },
        ],
      }),
    )
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Could not start fake AI')
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

async function waitForReady(baseUrl: string, worker: ChildProcess) {
  const deadline = Date.now() + readyTimeoutMs
  let lastStatus = 'unreachable'

  while (Date.now() < deadline) {
    if (worker.exitCode !== null)
      throw new Error(`Worker exited before /ready (${worker.exitCode})`)

    try {
      const response = await fetch(`${baseUrl}/ready`, { signal: AbortSignal.timeout(1_000) })
      lastStatus = String(response.status)
      if (response.status === 200) return
    } catch {
      lastStatus = 'unreachable'
    }

    await sleep(250)
  }

  throw new Error(
    `Worker did not become ready within ${readyTimeoutMs}ms (last status: ${lastStatus})`,
  )
}

async function stopWorker(worker: ChildProcess) {
  if (worker.exitCode !== null || worker.pid === undefined) return

  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      const killer = spawn('taskkill.exe', ['/pid', String(worker.pid), '/t', '/f'], {
        stdio: 'ignore',
        windowsHide: true,
      })
      killer.once('exit', () => resolve())
      killer.once('error', () => resolve())
    })
    return
  }

  worker.kill('SIGTERM')
  await Promise.race([
    new Promise<void>((resolve) => worker.once('exit', () => resolve())),
    sleep(2_000),
  ])
  if (worker.exitCode === null) worker.kill('SIGKILL')
}

async function main() {
  const connectionString = testDatabaseUrl()
  await run(['--filter', '@deepsales/web', 'build'])
  await resetTestDatabase(connectionString)
  const migrationEnv: NodeJS.ProcessEnv = {
    ...process.env,
    APP_ENV: 'test',
    DATABASE_URL: connectionString,
    DATABASE_URL_UNPOOLED: connectionString,
  }
  await run(['--filter', '@deepsales/db', 'db:migrate'], migrationEnv)

  const port = await freePort()
  const baseUrl = `http://127.0.0.1:${port}`
  const creatorInvitationToken = await seedE2eUsers(connectionString, baseUrl)
  const fakeFacebook = await startFakeFacebook()
  const fakeAI = await startFakeAI()
  const worker = startWorker(port, connectionString, baseUrl, fakeFacebook.baseUrl, fakeAI.baseUrl)

  try {
    await waitForReady(baseUrl, worker)
    const testEnv: NodeJS.ProcessEnv = {
      ...process.env,
      APP_ENV: 'test',
      E2E_BASE_URL: baseUrl,
      DATABASE_URL: connectionString,
      E2E_FAKE_FACEBOOK_URL: fakeFacebook.baseUrl,
      E2E_CREATOR_INVITATION_TOKEN: creatorInvitationToken,
    }
    await run(['exec', 'playwright', 'test', ...process.argv.slice(2)], testEnv)
  } finally {
    await stopWorker(worker)
    await fakeFacebook.close()
    await fakeAI.close()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
