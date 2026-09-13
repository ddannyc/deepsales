import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core'

export const user = pgTable('users', {
  id: uuid().defaultRandom().primaryKey(),
  name: text().notNull(),
  email: text().notNull().unique(),
  emailVerified: boolean('email_verified').default(false).notNull(),
  image: text(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})

export const session = pgTable('sessions', {
  id: uuid().defaultRandom().primaryKey(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  token: text().notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  userId: uuid('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
})

export const account = pgTable(
  'accounts',
  {
    id: uuid().defaultRandom().primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
    scope: text(),
    password: text(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [unique().on(table.providerId, table.accountId)],
)

export const verification = pgTable('verifications', {
  id: uuid().defaultRandom().primaryKey(),
  identifier: text().notNull(),
  value: text().notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})

export const workspaceRole = pgEnum('workspace_role', ['OWNER', 'ADMIN', 'AGENT'])
export const memberType = pgEnum('member_type', ['HUMAN', 'AI'])
export const memberStatus = pgEnum('member_status', ['ACTIVE', 'DISABLED'])

export const workspace = pgTable('workspace', {
  id: uuid().defaultRandom().primaryKey(),
  name: text().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})

export const workspaceUserAccess = pgTable(
  'workspace_user_access',
  {
    id: uuid().defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    role: workspaceRole().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [unique().on(table.workspaceId, table.userId)],
)

export const member = pgTable(
  'member',
  {
    id: uuid().defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    type: memberType().notNull(),
    workspaceUserAccessId: uuid('workspace_user_access_id')
      .unique()
      .references(() => workspaceUserAccess.id, { onDelete: 'cascade' }),
    displayName: text('display_name').notNull(),
    avatarUrl: text('avatar_url'),
    status: memberStatus().default('ACTIVE').notNull(),
    autoAssignmentEnabled: boolean('auto_assignment_enabled').default(true).notNull(),
    maxActiveConversations: integer('max_active_conversations').default(10).notNull(),
    lastAutoAssignedAt: timestamp('last_auto_assigned_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check(
      'member_identity',
      sql`(${table.type} = 'HUMAN') = (${table.workspaceUserAccessId} is not null)`,
    ),
    check('member_capacity', sql`${table.maxActiveConversations} >= 0`),
  ],
)

export const humanMemberAvailability = pgTable('human_member_availability', {
  memberId: uuid('member_id')
    .primaryKey()
    .references(() => member.id, { onDelete: 'cascade' }),
  available: boolean().default(true).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})
