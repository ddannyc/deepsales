import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { betterAuth } from 'better-auth/minimal'
import type { Database } from '@deepsales/db'
import type { Bindings } from './bindings'

export function createAuth(db: Database, env: Bindings) {
  return betterAuth({
    baseURL: env.APP_URL,
    secret: env.BETTER_AUTH_SECRET,
    database: drizzleAdapter(db, { provider: 'pg' }),
    emailAndPassword: { enabled: true },
    trustedOrigins: [env.APP_URL],
    advanced: {
      database: { generateId: 'uuid' },
      defaultCookieAttributes: {
        httpOnly: true,
        sameSite: 'lax',
        secure: env.APP_URL.startsWith('https://'),
      },
    },
  })
}
