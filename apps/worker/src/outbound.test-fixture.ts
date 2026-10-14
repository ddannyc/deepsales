import type { Pool } from 'pg'
import { assertTestDatabaseUrl } from '../../../config/env'

// Scheduled recovery scans globally. Other tests deliberately retain unsent messages,
// so retire their fixtures before creating the message this test must recover.
export async function isolateOutboundRecoveryTest(pool: Pool) {
  const url = pool.options.connectionString
  if (!url) throw new Error('Test DATABASE_URL is required.')
  assertTestDatabaseUrl(url, { localOnly: true })
  const { rows } = await pool.query<{ name: string }>('select current_database() as name')
  if (!rows[0]?.name.endsWith('_test'))
    throw new Error('Recovery fixtures require a _test database.')
  await pool.query(`
    update message
    set delivery_state = 'FAILED', failure_code = 'TEST_FIXTURE_CLEANUP'
    where direction = 'OUTBOUND' and delivery_state = 'PENDING'
  `)
}
