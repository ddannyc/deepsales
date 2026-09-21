import { Pool } from 'pg'
import { loadAppEnv } from '../config/env'
import { createDatabase, createRegistrationInvitation } from '../packages/db/src'

async function main() {
  const email = process.argv[2]
  if (!email || process.argv.length > 3) {
    throw new Error('Usage: pnpm create-registration-invite <email>')
  }

  const { appUrl, databaseUrl, databaseUrlUnpooled } = loadAppEnv()
  if (!appUrl) throw new Error('Set APP_URL to the DeepSales application URL')
  const connectionString = databaseUrlUnpooled ?? databaseUrl
  if (!connectionString) throw new Error('Set DATABASE_URL_UNPOOLED or DATABASE_URL')

  const pool = new Pool({ connectionString, max: 1 })
  try {
    const invitation = await createRegistrationInvitation(createDatabase(pool), { email })
    const url = new URL('/signup', appUrl)
    url.searchParams.set('invite', invitation.token)
    console.log(url.toString())
  } finally {
    await pool.end()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
