import { drizzle } from 'drizzle-orm/node-postgres'
import type { Client, Pool } from 'pg'
import * as schema from './schema'

export function createDatabase(client: Client | Pool) {
  return drizzle(client, { schema })
}

export type Database = ReturnType<typeof createDatabase>
