import { defineConfig } from 'drizzle-kit'
import { assertTestDatabaseUrl, loadAppEnv } from '../../config/env'

const appEnv = loadAppEnv()
const migrationUrl = appEnv.databaseUrlUnpooled ?? appEnv.databaseUrl ?? ''

if (!migrationUrl) {
  throw new Error(
    `Database URL is required for APP_ENV=${appEnv.name}. Set DATABASE_URL or DATABASE_URL_UNPOOLED in .env.${appEnv}.local or the process environment.`,
  )
}

if (appEnv.name === 'test') assertTestDatabaseUrl(migrationUrl)

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './drizzle',
  dbCredentials: { url: migrationUrl },
})
