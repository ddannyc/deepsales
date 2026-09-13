import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Pool } from 'pg'
import {
  bootstrapWorkspace,
  createDatabase,
  member,
  user,
  workspace,
  workspaceUserAccess,
} from '../src'

const connectionString = process.env.DATABASE_URL

describe.skipIf(!connectionString)('workspace bootstrap', () => {
  const pool = new Pool({ connectionString })
  const db = createDatabase(pool)

  beforeAll(async () => {
    await migrate(db, { migrationsFolder: 'drizzle' })
  })

  afterAll(() => pool.end())

  it('migrates pgvector and creates one owner and human member under concurrent retries', async () => {
    const id = randomUUID()
    const email = `${id}@example.com`
    await db.insert(user).values({ id, name: 'Ada Lovelace', email })

    const [first, retry] = await Promise.all([
      bootstrapWorkspace(db, { userId: id, userName: 'Ada Lovelace', name: 'Analytical Engines' }),
      bootstrapWorkspace(db, { userId: id, userName: 'Ada Lovelace', name: 'Analytical Engines' }),
    ])

    expect(retry).toEqual(first)
    expect(await db.select().from(workspace)).toContainEqual(
      expect.objectContaining({ id: first.id }),
    )
    expect(await db.select().from(workspaceUserAccess)).toContainEqual(
      expect.objectContaining({ workspaceId: first.id, userId: id, role: 'OWNER' }),
    )
    expect(await db.select().from(member)).toContainEqual(
      expect.objectContaining({
        workspaceId: first.id,
        displayName: 'Ada Lovelace',
        type: 'HUMAN',
      }),
    )
    const counts = await pool.query<{ access: string; members: string; availability: string }>(
      `select
        (select count(*) from workspace_user_access where user_id = $1) access,
        (select count(*) from member where workspace_id = $2) members,
        (select count(*) from human_member_availability h join member m on m.id = h.member_id where m.workspace_id = $2) availability`,
      [id, first.id],
    )
    expect(counts.rows[0]).toEqual({ access: '1', members: '1', availability: '1' })
    expect(
      (
        await pool.query<{ installed: boolean }>(
          "select exists(select 1 from pg_extension where extname = 'vector') installed",
        )
      ).rows[0]?.installed,
    ).toBe(true)
  })
})
