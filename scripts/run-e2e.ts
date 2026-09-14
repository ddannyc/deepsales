import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { createServer as createHttpServer } from 'node:http'
import { createServer } from 'node:net'
import { dirname, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageManager = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const readyTimeoutMs = 30_000

function e2eDatabaseUrl() {
  const raw = process.env.E2E_DATABASE_URL?.trim()
  if (!raw) throw new Error('E2E_DATABASE_URL is required')

  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('E2E_DATABASE_URL must be a PostgreSQL connection URL')
  }

  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new Error('E2E_DATABASE_URL must use postgres:// or postgresql://')
  }

  const databaseName = decodeURIComponent(url.pathname.slice(1))
  if (!isE2EDatabaseName(databaseName)) {
    throw new Error('E2E_DATABASE_URL must point to a database whose name ends in _e2e or -e2e')
  }

  return raw
}

function isE2EDatabaseName(name: string) {
  return name === 'e2e' || /(?:^|[-_])e2e$/i.test(name)
}

async function resetE2EDatabase(connectionString: string) {
  const pool = new Pool({ connectionString, max: 1 })
  try {
    const result = await pool.query<{ name: string }>('select current_database() as name')
    const name = result.rows[0]?.name
    if (!name || !isE2EDatabaseName(name)) {
      throw new Error('E2E_DATABASE_URL resolved to a non-E2E database')
    }

    await pool.query('drop extension if exists vector cascade')
    await pool.query('drop schema if exists public cascade')
    await pool.query('drop schema if exists drizzle cascade')
    await pool.query('create schema public')
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

function workerBindings(baseUrl: string, facebookGraphBaseUrl: string) {
  return {
    APP_URL: baseUrl,
    BETTER_AUTH_SECRET: 'e2e-only-better-auth-secret-32-characters',
    META_APP_ID: 'e2e-meta-app-id',
    META_APP_SECRET: 'e2e-meta-app-secret',
    META_VERIFY_TOKEN: 'e2e-meta-verify-token',
    META_GRAPH_API_VERSION: 'v26.0',
    FACEBOOK_GRAPH_BASE_URL: facebookGraphBaseUrl,
    TOKEN_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  }
}

function startWorker(
  port: number,
  connectionString: string,
  baseUrl: string,
  facebookGraphBaseUrl: string,
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
  for (const [key, value] of Object.entries(workerBindings(baseUrl, facebookGraphBaseUrl))) {
    args.push('--var', `${key}:${value}`)
  }

  const env = { ...process.env }
  delete env.DATABASE_URL
  delete env.E2E_DATABASE_URL
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
  const server = createHttpServer(async (request, response) => {
    if (request.method !== 'POST' || !request.url?.endsWith('/messages')) {
      response.statusCode = 404
      response.end()
      return
    }

    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      message?: { text?: string }
    }
    response.setHeader('content-type', 'application/json')
    if (body.message?.text === 'force failure') {
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
  const connectionString = e2eDatabaseUrl()
  await run(['--filter', '@deepsales/web', 'build'])
  await resetE2EDatabase(connectionString)
  const migrationEnv: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: connectionString }
  delete migrationEnv.E2E_DATABASE_URL
  await run(['--filter', '@deepsales/db', 'db:migrate'], migrationEnv)

  const port = await freePort()
  const baseUrl = `http://127.0.0.1:${port}`
  const fakeFacebook = await startFakeFacebook()
  const worker = startWorker(port, connectionString, baseUrl, fakeFacebook.baseUrl)

  try {
    await waitForReady(baseUrl, worker)
    const testEnv: NodeJS.ProcessEnv = {
      ...process.env,
      E2E_BASE_URL: baseUrl,
      E2E_DATABASE_URL: connectionString,
    }
    delete testEnv.DATABASE_URL
    await run(['exec', 'playwright', 'test', ...process.argv.slice(2)], testEnv)
  } finally {
    await stopWorker(worker)
    await fakeFacebook.close()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
