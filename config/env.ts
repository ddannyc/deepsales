import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'

export type AppEnv = 'development' | 'test' | 'production'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const defaultTestDatabaseUrl = 'postgresql://user:password@127.0.0.1:5432/deepsales_test'
const localHosts = new Set(['localhost', '127.0.0.1', '::1', 'host.docker.internal'])

function environmentFiles(appEnv: AppEnv) {
  const files = ['.env', `.env.${appEnv}`]
  if (appEnv === 'development') files.push('.env.local', '.env.development.local')
  else files.push(`.env.${appEnv}.local`)
  return files.map((file) => resolve(projectRoot, file))
}

function readEnvironmentFiles(appEnv: AppEnv) {
  const values: Record<string, string> = {}
  for (const file of environmentFiles(appEnv)) {
    if (existsSync(file)) Object.assign(values, parseEnv(readFileSync(file, 'utf8')))
  }
  return values
}

export function loadAppEnv(expected?: AppEnv) {
  const requested = expected || process.env.APP_ENV?.trim() || 'development'
  if (!['development', 'test', 'production'].includes(requested)) {
    throw new Error(`APP_ENV must be development, test, or production; received '${requested}'.`)
  }

  const fileValues = readEnvironmentFiles(requested as AppEnv)
  const values = { ...fileValues, ...process.env }
  const databaseUrl =
    requested === 'test'
      ? fileValues.DATABASE_URL?.trim() || process.env.DATABASE_URL?.trim()
      : values.DATABASE_URL?.trim()
  const resolvedDatabaseUrl =
    databaseUrl || (requested === 'test' ? defaultTestDatabaseUrl : undefined)

  return {
    name: requested as AppEnv,
    databaseUrl: resolvedDatabaseUrl,
    databaseUrlUnpooled:
      requested === 'test'
        ? fileValues.DATABASE_URL_UNPOOLED?.trim() || resolvedDatabaseUrl
        : values.DATABASE_URL_UNPOOLED?.trim(),
  }
}

export function assertTestDatabaseUrl(connectionString: string, options?: { localOnly?: boolean }) {
  let parsedUrl: URL
  try {
    parsedUrl = new URL(connectionString)
  } catch {
    throw new Error('Test DATABASE_URL is not a valid URL.')
  }

  if (!['postgres:', 'postgresql:'].includes(parsedUrl.protocol)) {
    throw new Error('Test DATABASE_URL must use PostgreSQL.')
  }

  const databaseName = decodeURIComponent(parsedUrl.pathname.slice(1))
  if (!/^(test|e2e)$/i.test(databaseName) && !/(?:[-_])(test|e2e)$/i.test(databaseName)) {
    throw new Error(
      "Test DATABASE_URL must point to a database whose name ends in '_test' or '_e2e'.",
    )
  }

  if (options?.localOnly) {
    const host = parsedUrl.hostname.replace(/^\[|\]$/g, '').toLowerCase()
    if (!localHosts.has(host)) {
      throw new Error(`Refusing database tests: test database host '${host}' is not local.`)
    }
  }

  return parsedUrl
}
