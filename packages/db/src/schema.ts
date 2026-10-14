import { sql } from 'drizzle-orm'
import {
  bigint,
  bigserial,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  vector,
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

export const session = pgTable(
  'sessions',
  {
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
  },
  (table) => [index('sessions_user_id_idx').on(table.userId)],
)

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
  (table) => [
    index('accounts_user_id_idx').on(table.userId),
    unique().on(table.providerId, table.accountId),
  ],
)

export const verification = pgTable(
  'verifications',
  {
    id: uuid().defaultRandom().primaryKey(),
    identifier: text().notNull(),
    value: text().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index('verifications_identifier_idx').on(table.identifier)],
)

export const workspaceRole = pgEnum('workspace_role', ['OWNER', 'ADMIN', 'AGENT'])
export const memberType = pgEnum('member_type', ['HUMAN', 'AI'])
export const memberStatus = pgEnum('member_status', ['ACTIVE', 'DISABLED'])
export const channelProvider = pgEnum('channel_provider', ['FACEBOOK_MESSENGER'])
export const channelStatus = pgEnum('channel_status', ['ACTIVE', 'DISABLED'])
export const facebookConnectionStatus = pgEnum('facebook_connection_status', [
  'ACTIVE',
  'ACTION_REQUIRED',
  'DISABLED',
])
export const conversationStatus = pgEnum('conversation_status', ['OPEN', 'CLOSED'])
export const queueReason = pgEnum('queue_reason', [
  'NEW_CONVERSATION',
  'AI_HANDOFF',
  'MANUAL_UNASSIGN',
  'MEMBER_DISABLED',
])
export const routingConstraint = pgEnum('routing_constraint', ['ANY_MEMBER', 'HUMAN_ONLY'])
export const assignmentReason = pgEnum('assignment_reason', [
  'AUTO_ROUTE',
  'TAKEOVER',
  'MANUAL_TRANSFER',
  'MANUAL_UNASSIGN',
  'AI_HANDOFF',
  'MEMBER_DISABLED',
  'CLOSE',
])
export const messageDirection = pgEnum('message_direction', ['INBOUND', 'OUTBOUND'])
export const messageSenderType = pgEnum('message_sender_type', ['CUSTOMER', 'MEMBER', 'EXTERNAL'])
export const messageType = pgEnum('message_type', ['TEXT', 'ATTACHMENT'])
export const messageDeliveryState = pgEnum('message_delivery_state', ['PENDING', 'SENT', 'FAILED'])
export const messageAttachmentKind = pgEnum('message_attachment_kind', [
  'IMAGE',
  'FILE',
  'AUDIO',
  'VIDEO',
])
export const attachmentStorageState = pgEnum('attachment_storage_state', [
  'PENDING',
  'READY',
  'FAILED',
])
export const knowledgeDocumentSourceType = pgEnum('knowledge_document_source_type', [
  'TEXT',
  'PDF',
  'DOCX',
  'TXT',
  'MARKDOWN',
])
export const knowledgeDocumentStatus = pgEnum('knowledge_document_status', [
  'UPLOADED',
  'PROCESSING',
  'READY',
  'FAILED',
])
export const aiRuntimeStatus = pgEnum('ai_runtime_status', ['UNPUBLISHED', 'USABLE', 'UNHEALTHY'])
export const aiResponseRunState = pgEnum('ai_response_run_state', [
  'QUEUED',
  'GENERATING',
  'COMPLETED',
  'HANDOFF',
  'SKIPPED',
  'CANCELLED',
  'FAILED',
])
export const aiResponseCancellationReason = pgEnum('ai_response_cancellation_reason', [
  'OWNERSHIP_CHANGED',
  'NEW_CUSTOMER_MESSAGE',
  'CUSTOMER_MEMORY_CHANGED',
  'PROPERTY_COLLECTION_CHANGED',
])

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

export const workspaceInvitation = pgTable(
  'workspace_invitation',
  {
    id: uuid().defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    email: text().notNull(),
    role: workspaceRole().notNull(),
    displayName: text('display_name'),
    available: boolean().default(true).notNull(),
    autoAssignmentEnabled: boolean('auto_assignment_enabled').default(true).notNull(),
    maxActiveConversations: integer('max_active_conversations').default(10).notNull(),
    channelIds: uuid('channel_ids').array().default(sql`ARRAY[]::uuid[]`).notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdByUserId: uuid('created_by_user_id')
      .notNull()
      .references(() => user.id),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('workspace_invitation_workspace_id_idx').on(table.workspaceId),
    check('workspace_invitation_role', sql`${table.role} <> 'OWNER'`),
    check('workspace_invitation_capacity', sql`${table.maxActiveConversations} >= 0`),
  ],
)

export const registrationInvitation = pgTable('registration_invitation', {
  id: uuid().defaultRandom().primaryKey(),
  email: text().notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  acceptedByUserId: uuid('accepted_by_user_id')
    .unique()
    .references(() => user.id, {
      onDelete: 'cascade',
    }),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }),
  workspaceCreatedAt: timestamp('workspace_created_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})

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
    displayName: text('display_name'),
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

export const channel = pgTable(
  'channel',
  {
    id: uuid().defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    provider: channelProvider().notNull(),
    displayName: text('display_name').notNull(),
    status: channelStatus().default('ACTIVE').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index('channel_workspace_id_idx').on(table.workspaceId)],
)

export const memberChannelAccess = pgTable(
  'member_channel_access',
  {
    memberId: uuid('member_id')
      .notNull()
      .references(() => member.id, { onDelete: 'cascade' }),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channel.id, { onDelete: 'cascade' }),
  },
  (table) => [primaryKey({ columns: [table.memberId, table.channelId] })],
)

export const facebookChannelConfig = pgTable('facebook_channel_config', {
  channelId: uuid('channel_id')
    .primaryKey()
    .references(() => channel.id, { onDelete: 'cascade' }),
  pageId: text('page_id').notNull().unique(),
  encryptedPageAccessToken: text('encrypted_page_access_token').notNull(),
  tokenIv: text('token_iv').notNull(),
  tokenKeyVersion: text('token_key_version').default('v1').notNull(),
  connectionStatus: facebookConnectionStatus('connection_status').default('ACTIVE').notNull(),
  subscribedAt: timestamp('subscribed_at', { withTimezone: true }),
  lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
  lastErrorCode: text('last_error_code'),
  lastErrorSubcode: integer('last_error_subcode'),
  lastErrorMessage: text('last_error_message'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})

export const facebookOauthState = pgTable(
  'facebook_oauth_state',
  {
    id: uuid().defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    initiatedByUserId: uuid('initiated_by_user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    stateHash: text('state_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    encryptedUserAccessToken: text('encrypted_user_access_token'),
    userTokenIv: text('user_token_iv'),
    userTokenKeyVersion: text('user_token_key_version'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index('facebook_oauth_state_workspace_id_idx').on(table.workspaceId)],
)

export const customer = pgTable(
  'customer',
  {
    id: uuid().defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    displayName: text('display_name'),
    avatarUrl: text('avatar_url'),
    email: text(),
    phone: text(),
    preferredLanguage: text('preferred_language'),
    notes: text(),
    ownerMemberId: uuid('owner_member_id').references(() => member.id, { onDelete: 'set null' }),
    tagRevision: integer('tag_revision').default(0).notNull(),
    profileRevision: integer('profile_revision').default(0).notNull(),
    profileSourceChannelIds: jsonb('profile_source_channel_ids')
      .$type<string[]>()
      .default([])
      .notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index('customer_workspace_id_idx').on(table.workspaceId)],
)

export const channelIdentity = pgTable(
  'channel_identity',
  {
    id: uuid().defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customer.id, { onDelete: 'cascade' }),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channel.id, { onDelete: 'cascade' }),
    externalUserId: text('external_user_id').notNull(),
    memoryBoundarySequence: bigint('memory_boundary_sequence', { mode: 'number' })
      .default(0)
      .notNull(),
    memoryBoundaryAt: timestamp('memory_boundary_at', { withTimezone: true })
      .default(sql`'1970-01-01'::timestamptz`)
      .notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique().on(table.channelId, table.externalUserId),
    index('channel_identity_workspace_id_idx').on(table.workspaceId),
  ],
)

export const facebookMessagingWindow = pgTable('facebook_messaging_window', {
  channelIdentityId: uuid('channel_identity_id')
    .primaryKey()
    .references(() => channelIdentity.id, { onDelete: 'cascade' }),
  lastCustomerMessageAt: timestamp('last_customer_message_at', { withTimezone: true }).notNull(),
  eligibleUntil: timestamp('eligible_until', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})

export type CampaignContent = { id: string; text?: string; assetId?: string }[]
export type CampaignCalendar = {
  localTime: string
  timeZone: string
  repeat: 'NONE' | 'DAILY' | 'WEEKLY'
  until?: string
  maxRuns?: number
}

export const campaign = pgTable(
  'campaign',
  {
    id: uuid().primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channel.id),
    creatorMemberId: uuid('creator_member_id')
      .notNull()
      .references(() => member.id),
    name: text().notNull(),
    status: text().notNull().default('DRAFT'),
    identityIds: uuid('identity_ids').array().notNull(),
    content: jsonb().$type<CampaignContent>().notNull(),
    selectionMode: text('selection_mode').notNull().default('ALL'),
    targetLanguage: text('target_language'),
    calendar: jsonb().$type<CampaignCalendar>(),
    intervalSeconds: integer('interval_seconds').notNull().default(1),
    nextRunAt: timestamp('next_run_at', { withTimezone: true }),
    version: integer().notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('campaign_due_idx').on(t.status, t.nextRunAt),
    check(
      'campaign_status_check',
      sql`${t.status} in ('DRAFT','ACTIVE','PAUSED','CANCELLED','COMPLETED')`,
    ),
    check('campaign_interval_check', sql`${t.intervalSeconds} between 1 and 86400`),
    check('campaign_selection_check', sql`${t.selectionMode} in ('ALL','RANDOM')`),
  ],
)

export const campaignRun = pgTable(
  'campaign_run',
  {
    id: uuid().primaryKey(),
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => campaign.id, { onDelete: 'cascade' }),
    version: integer().notNull(),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }).notNull(),
    content: jsonb().$type<CampaignContent>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('campaign_run_occurrence_idx').on(t.campaignId, t.scheduledAt)],
)

export const campaignRecipient = pgTable(
  'campaign_recipient',
  {
    id: uuid().primaryKey(),
    runId: uuid('run_id')
      .notNull()
      .references(() => campaignRun.id, { onDelete: 'cascade' }),
    channelIdentityId: uuid('channel_identity_id')
      .notNull()
      .references(() => channelIdentity.id),
    ordinal: integer().notNull(),
    state: text().notNull().default('WAITING'),
    reason: text(),
    content: jsonb().$type<CampaignContent>().notNull(),
    translatedContent: jsonb('translated_content').$type<CampaignContent>(),
    translationOperationId: uuid('translation_operation_id').notNull(),
    messageIds: uuid('message_ids').array().notNull().default(sql`ARRAY[]::uuid[]`),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('campaign_recipient_identity_idx').on(t.runId, t.channelIdentityId),
    index('campaign_recipient_pending_idx').on(t.state, t.runId),
    check(
      'campaign_recipient_state_check',
      sql`${t.state} in ('WAITING','SUCCESS','FAILED','SKIPPED','UNKNOWN')`,
    ),
  ],
)

export const conversation = pgTable(
  'conversation',
  {
    id: uuid().defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    channelIdentityId: uuid('channel_identity_id')
      .notNull()
      .references(() => channelIdentity.id, { onDelete: 'cascade' }),
    status: conversationStatus().default('OPEN').notNull(),
    tagRevision: integer('tag_revision').default(0).notNull(),
    aiReplyLanguage: text('ai_reply_language'),
    aiStopState: jsonb('ai_stop_state').$type<{
      reason: 'CONDITION' | 'SCHEDULE'
      stoppedAt: string
    }>(),
    assigneeMemberId: uuid('assignee_member_id').references(() => member.id, {
      onDelete: 'set null',
    }),
    queueReason: queueReason('queue_reason'),
    routingConstraint: routingConstraint('routing_constraint').default('ANY_MEMBER').notNull(),
    routingQueuedAt: timestamp('routing_queued_at', { withTimezone: true }),
    latestMessageAt: timestamp('latest_message_at', { withTimezone: true }),
    lastCustomerMessageAt: timestamp('last_customer_message_at', { withTimezone: true }),
    lastOutboundMessageAt: timestamp('last_outbound_message_at', { withTimezone: true }),
    lastCustomerMessageId: uuid('last_customer_message_id'),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    closedByMemberId: uuid('closed_by_member_id').references(() => member.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('conversation_workspace_updated_idx').on(table.workspaceId, table.updatedAt, table.id),
    index('conversation_identity_status_idx').on(table.channelIdentityId, table.status),
    index('conversation_routing_recovery_idx').on(
      table.status,
      table.assigneeMemberId,
      table.routingQueuedAt,
      table.id,
    ),
    check(
      'conversation_lifecycle_fields',
      sql`(
        (${table.status} = 'OPEN' and ${table.closedAt} is null and ${table.closedByMemberId} is null and
          ((${table.assigneeMemberId} is not null and ${table.queueReason} is null and ${table.routingQueuedAt} is null) or
           (${table.assigneeMemberId} is null and ${table.queueReason} is not null and ${table.routingQueuedAt} is not null)))
        or
        (${table.status} = 'CLOSED' and ${table.assigneeMemberId} is null and ${table.queueReason} is null and
          ${table.routingQueuedAt} is null and ${table.routingConstraint} = 'ANY_MEMBER' and
          ${table.closedAt} is not null and ${table.closedByMemberId} is not null)
      )`,
    ),
    uniqueIndex('conversation_one_open_identity_idx')
      .on(table.channelIdentityId)
      .where(sql`${table.status} = 'OPEN'`),
  ],
)

export const customerFactLevel = pgEnum('customer_fact_level', ['CUSTOMER', 'CONVERSATION'])
export const conversationMemberMute = pgTable(
  'conversation_member_mute',
  {
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversation.id, { onDelete: 'cascade' }),
    memberId: uuid('member_id')
      .notNull()
      .references(() => member.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.memberId, t.conversationId] })],
)
export const conversationInternalNote = pgTable(
  'conversation_internal_note',
  {
    id: uuid().defaultRandom().primaryKey(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversation.id, { onDelete: 'cascade' }),
    authorMemberId: uuid('author_member_id').references(() => member.id, { onDelete: 'set null' }),
    authorName: text('author_name').notNull(),
    clientKey: uuid('client_key').notNull(),
    text: text().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('conversation_internal_note_retry_idx').on(
      t.conversationId,
      t.authorMemberId,
      t.clientKey,
    ),
    index('conversation_internal_note_history_idx').on(t.conversationId, t.createdAt, t.id),
    check('conversation_internal_note_text', sql`length(btrim(${t.text})) between 1 and 2000`),
  ],
)
export const inboxSavedView = pgTable(
  'inbox_saved_view',
  {
    id: uuid().defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    ownerMemberId: uuid('owner_member_id')
      .notNull()
      .references(() => member.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    scope: text().$type<'PERSONAL' | 'PUBLIC'>().notNull(),
    filters: jsonb().$type<import('./inbox').InboxFilters>().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    check('inbox_saved_view_scope', sql`${t.scope} in ('PERSONAL', 'PUBLIC')`),
    check('inbox_saved_view_name', sql`length(btrim(${t.name})) between 1 and 100`),
    index('inbox_saved_view_workspace_idx').on(t.workspaceId, t.ownerMemberId),
  ],
)
export const customerPropertyType = pgEnum('customer_property_type', ['TEXT', 'NUMBER', 'OPTION'])

export const customerPropertyDefinition = pgTable(
  'customer_property_definition',
  {
    id: uuid().defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    level: customerFactLevel().notNull(),
    type: customerPropertyType().notNull(),
    options: jsonb().$type<string[]>().default([]).notNull(),
    maxLength: integer('max_length').default(2000).notNull(),
    revision: integer().default(0).notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('customer_property_definition_name_idx')
      .on(t.workspaceId, t.level, sql`lower(${t.name})`)
      .where(sql`${t.deletedAt} is null`),
    check('customer_property_definition_length', sql`${t.maxLength} between 1 and 2000`),
  ],
)

export const customerPropertyValue = pgTable(
  'customer_property_value',
  {
    id: uuid().defaultRandom().primaryKey(),
    definitionId: uuid('definition_id')
      .notNull()
      .references(() => customerPropertyDefinition.id),
    customerId: uuid('customer_id').references(() => customer.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id').references(() => conversation.id, {
      onDelete: 'cascade',
    }),
    value: jsonb().$type<string | number | null>(),
    revision: integer().default(1).notNull(),
    allowAutomaticUpdate: boolean('allow_automatic_update').default(false).notNull(),
    sourceMemberId: uuid('source_member_id').references(() => member.id, { onDelete: 'set null' }),
    sourceChannelId: uuid('source_channel_id')
      .notNull()
      .references(() => channel.id),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    check(
      'customer_property_value_target',
      sql`(${t.customerId} is not null) <> (${t.conversationId} is not null)`,
    ),
    uniqueIndex('customer_property_value_customer_idx')
      .on(t.definitionId, t.customerId)
      .where(sql`${t.customerId} is not null`),
    uniqueIndex('customer_property_value_conversation_idx')
      .on(t.definitionId, t.conversationId)
      .where(sql`${t.conversationId} is not null`),
  ],
)

export const customerPropertyHistory = pgTable(
  'customer_property_history',
  {
    id: uuid().defaultRandom().primaryKey(),
    valueId: uuid('value_id')
      .notNull()
      .references(() => customerPropertyValue.id, { onDelete: 'cascade' }),
    definitionName: text('definition_name').notNull(),
    value: jsonb().$type<string | number | null>(),
    revision: integer().notNull(),
    allowAutomaticUpdate: boolean('allow_automatic_update').notNull(),
    sourceMemberId: uuid('source_member_id').references(() => member.id, { onDelete: 'set null' }),
    sourceName: text('source_name').default('Former member').notNull(),
    sourceChannelId: uuid('source_channel_id')
      .notNull()
      .references(() => channel.id),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('customer_property_history_value_idx').on(t.valueId, t.createdAt)],
)

export type AiPropertyCollection = {
  customerId: string
  rules: {
    id: string
    revision: number
    definitionId: string
    definitionRevision: number
    name: string
    level: 'CUSTOMER' | 'CONVERSATION'
    type: 'TEXT' | 'NUMBER' | 'OPTION'
    options: string[]
    maxLength: number
    instructions: string
    valueRevision: number
  }[]
}
export const aiPropertyRule = pgTable(
  'ai_property_rule',
  {
    id: uuid().primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    memberId: uuid('member_id')
      .notNull()
      .references(() => member.id, { onDelete: 'cascade' }),
    definitionId: uuid('definition_id')
      .notNull()
      .references(() => customerPropertyDefinition.id),
    instructions: text().notNull(),
    enabled: boolean().default(true).notNull(),
    revision: integer().default(1).notNull(),
  },
  (t) => [uniqueIndex('ai_property_rule_member_definition_idx').on(t.memberId, t.definitionId)],
)

export type AiTagCollection = {
  customerId: string
  customerRevision: number
  conversationRevision: number
  rules: {
    id: string
    definitionId: string
    revision: number
    name: string
    level: 'CUSTOMER' | 'CONVERSATION'
    instructions: string
  }[]
}
export const aiTagRule = pgTable(
  'ai_tag_rule',
  {
    id: uuid().primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    memberId: uuid('member_id')
      .notNull()
      .references(() => member.id, { onDelete: 'cascade' }),
    definitionId: uuid('definition_id')
      .notNull()
      .references(() => customerTagDefinition.id, { onDelete: 'cascade' }),
    instructions: text().notNull(),
    enabled: boolean().default(true).notNull(),
    revision: integer().default(1).notNull(),
  },
  (t) => [uniqueIndex('ai_tag_rule_member_definition_idx').on(t.memberId, t.definitionId)],
)

export const customerTagDefinition = pgTable(
  'customer_tag_definition',
  {
    id: uuid().defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    level: customerFactLevel().notNull(),
  },
  (t) => [
    uniqueIndex('customer_tag_definition_name_idx').on(
      t.workspaceId,
      t.level,
      sql`lower(${t.name})`,
    ),
  ],
)

export const customerTag = pgTable(
  'customer_tag',
  {
    id: uuid().defaultRandom().primaryKey(),
    tagId: uuid('tag_id')
      .notNull()
      .references(() => customerTagDefinition.id, { onDelete: 'cascade' }),
    customerId: uuid('customer_id').references(() => customer.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id').references(() => conversation.id, {
      onDelete: 'cascade',
    }),
    sourceMemberId: uuid('source_member_id').references(() => member.id, { onDelete: 'set null' }),
    sourceChannelId: uuid('source_channel_id')
      .notNull()
      .references(() => channel.id),
  },
  (t) => [
    check(
      'customer_tag_target',
      sql`(${t.customerId} is not null) <> (${t.conversationId} is not null)`,
    ),
    uniqueIndex('customer_tag_customer_idx')
      .on(t.tagId, t.customerId)
      .where(sql`${t.customerId} is not null`),
    uniqueIndex('customer_tag_conversation_idx')
      .on(t.tagId, t.conversationId)
      .where(sql`${t.conversationId} is not null`),
  ],
)

export const conversationAssignment = pgTable(
  'conversation_assignment',
  {
    id: uuid().defaultRandom().primaryKey(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversation.id, { onDelete: 'cascade' }),
    fromMemberId: uuid('from_member_id').references(() => member.id, { onDelete: 'set null' }),
    toMemberId: uuid('to_member_id').references(() => member.id, { onDelete: 'set null' }),
    reason: assignmentReason().notNull(),
    actingMemberId: uuid('acting_member_id').references(() => member.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index('conversation_assignment_conversation_idx').on(table.conversationId)],
)

export const message = pgTable(
  'message',
  {
    id: uuid().defaultRandom().primaryKey(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversation.id, { onDelete: 'cascade' }),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channel.id, { onDelete: 'cascade' }),
    direction: messageDirection().notNull(),
    senderType: messageSenderType('sender_type').notNull(),
    senderMemberId: uuid('sender_member_id').references(() => member.id, { onDelete: 'set null' }),
    messageType: messageType('message_type').default('TEXT').notNull(),
    replyGroupId: uuid('reply_group_id'),
    replySegmentIndex: integer('reply_segment_index'),
    replySegmentCount: integer('reply_segment_count'),
    replyAfterMessageId: uuid('reply_after_message_id'),
    clientKey: uuid('client_key'),
    text: text(),
    externalMessageId: text('external_message_id'),
    providerSentAt: timestamp('provider_sent_at', { withTimezone: true }),
    deliveryState: messageDeliveryState('delivery_state'),
    deliveryStartedAt: timestamp('delivery_started_at', { withTimezone: true }),
    deliveryCompletedAt: timestamp('delivery_completed_at', { withTimezone: true }),
    failureCode: text('failure_code'),
    failureMessage: text('failure_message'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check(
      'message_reply_segments',
      sql`(${table.replyGroupId} is null and ${table.replySegmentIndex} is null and ${table.replySegmentCount} is null and ${table.replyAfterMessageId} is null) or (${table.replyGroupId} is not null and ${table.direction} = 'OUTBOUND' and ((${table.replySegmentIndex} between 1 and ${table.replySegmentCount} and ${table.replySegmentIndex} is not null and ${table.replySegmentCount} is not null and ${table.replySegmentCount} between 1 and 3 and ${table.messageType} = 'TEXT' and ${table.replyAfterMessageId} is null) or (${table.replySegmentIndex} is null and ${table.replySegmentCount} is null and ${table.replyAfterMessageId} is not null and ${table.messageType} = 'ATTACHMENT')))`,
    ),
    uniqueIndex('message_reply_segment_idx').on(table.replyGroupId, table.replySegmentIndex),
    foreignKey({ columns: [table.replyAfterMessageId], foreignColumns: [table.id] }),
    uniqueIndex('message_reply_asset_idx')
      .on(table.replyGroupId)
      .where(sql`${table.messageType} = 'ATTACHMENT' and ${table.replyGroupId} is not null`),
    index('message_conversation_created_idx').on(table.conversationId, table.createdAt, table.id),
    uniqueIndex('message_human_retry_idx').on(
      table.conversationId,
      table.senderMemberId,
      table.clientKey,
    ),
    index('message_delivery_recovery_idx').on(
      table.direction,
      table.deliveryState,
      table.deliveryStartedAt,
      table.createdAt,
      table.id,
    ),
    check(
      'message_sender_member_consistency',
      sql`(${table.senderType} = 'MEMBER') = (${table.senderMemberId} is not null)`,
    ),
    check(
      'message_delivery_consistency',
      sql`(${table.direction} = 'OUTBOUND') = (${table.deliveryState} is not null)`,
    ),
    check(
      'message_text_required',
      sql`${table.messageType} <> 'TEXT' or ${table.text} is not null`,
    ),
    uniqueIndex('message_channel_external_id_idx')
      .on(table.channelId, table.externalMessageId)
      .where(sql`${table.externalMessageId} is not null`),
  ],
)

export const messageMemberRead = pgTable(
  'message_member_read',
  {
    messageId: uuid('message_id')
      .notNull()
      .references(() => message.id, { onDelete: 'cascade' }),
    memberId: uuid('member_id')
      .notNull()
      .references(() => member.id, { onDelete: 'cascade' }),
    readAt: timestamp('read_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [primaryKey({ columns: [table.memberId, table.messageId] })],
)

export const conversationMemberRead = pgTable(
  'conversation_member_read',
  {
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversation.id, { onDelete: 'cascade' }),
    memberId: uuid('member_id')
      .notNull()
      .references(() => member.id, { onDelete: 'cascade' }),
    lastReadMessageId: uuid('last_read_message_id')
      .notNull()
      .references(() => message.id, { onDelete: 'cascade' }),
  },
  (table) => [primaryKey({ columns: [table.memberId, table.conversationId] })],
)

export const facebookReceiptWatermark = pgTable('facebook_receipt_watermark', {
  channelIdentityId: uuid('channel_identity_id')
    .primaryKey()
    .references(() => channelIdentity.id, { onDelete: 'cascade' }),
  deliveredThrough: timestamp('delivered_through', { withTimezone: true }),
  readThrough: timestamp('read_through', { withTimezone: true }),
})

export const facebookMessageReceipt = pgTable(
  'facebook_message_receipt',
  {
    channelIdentityId: uuid('channel_identity_id')
      .notNull()
      .references(() => channelIdentity.id, { onDelete: 'cascade' }),
    externalMessageId: text('external_message_id').notNull(),
    providerSentAt: timestamp('provider_sent_at', { withTimezone: true }),
    delivered: boolean().default(false).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [primaryKey({ columns: [table.channelIdentityId, table.externalMessageId] })],
)

export const aiResponseRun = pgTable(
  'ai_response_run',
  {
    id: uuid().defaultRandom().primaryKey(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversation.id, { onDelete: 'cascade' }),
    memberId: uuid('member_id')
      .notNull()
      .references(() => member.id, { onDelete: 'cascade' }),
    configVersionId: uuid('config_version_id').references(() => aiConfigVersion.id, {
      onDelete: 'set null',
    }),
    configSnapshot: jsonb('config_snapshot').$type<AiMemberRuntimeSnapshot>(),
    customerMemoryInput: jsonb('customer_memory_input').$type<{
      customerId: string
      revision: number
      summary: string
      sourceChannelIds: string[]
    }>(),
    unparsedFallbackText: text('unparsed_fallback_text'),
    propertyCollection: jsonb('property_collection').$type<AiPropertyCollection>(),
    tagCollection: jsonb('tag_collection').$type<AiTagCollection>(),
    variableInput: jsonb('variable_input').$type<import('./ai-variables').AiVariableInput>(),
    advertisingContext: jsonb('advertising_context').$type<AdvertisingContext>(),
    contextMessageIds: uuid('context_message_ids').array(),
    outputMessageId: uuid('output_message_id').references(() => message.id, {
      onDelete: 'set null',
    }),
    state: aiResponseRunState().default('QUEUED').notNull(),
    inputFirstMessageId: uuid('input_first_message_id')
      .notNull()
      .references(() => message.id, { onDelete: 'cascade' }),
    inputLastMessageId: uuid('input_last_message_id')
      .notNull()
      .references(() => message.id, { onDelete: 'cascade' }),
    scheduledFor: timestamp('scheduled_for', { withTimezone: true }).notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    retrievedChunkIds: uuid('retrieved_chunk_ids').array().default(sql`ARRAY[]::uuid[]`).notNull(),
    cancellationReason: aiResponseCancellationReason('cancellation_reason'),
    failureCode: text('failure_code'),
    failureMessage: text('failure_message'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('ai_response_run_conversation_idx').on(table.conversationId),
    index('ai_response_run_schedule_idx').on(table.state, table.scheduledFor, table.updatedAt),
    index('ai_response_run_generation_idx').on(table.state, table.startedAt, table.id),
    uniqueIndex('ai_response_run_one_active_conversation_idx')
      .on(table.conversationId)
      .where(sql`${table.state} in ('QUEUED', 'GENERATING')`),
  ],
)

export const messageAttachment = pgTable(
  'message_attachment',
  {
    id: uuid().defaultRandom().primaryKey(),
    messageId: uuid('message_id')
      .notNull()
      .references(() => message.id, { onDelete: 'cascade' }),
    assetId: uuid('asset_id').references(() => mediaAsset.id, { onDelete: 'set null' }),
    kind: messageAttachmentKind().notNull(),
    filename: text(),
    mimeType: text('mime_type'),
    byteSize: integer('byte_size'),
    storageKey: text('storage_key'),
    storageState: attachmentStorageState('storage_state').default('PENDING').notNull(),
    processingStartedAt: timestamp('processing_started_at', { withTimezone: true }),
    failureCode: text('failure_code'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('message_attachment_message_idx').on(table.messageId),
    index('message_attachment_processing_idx').on(
      table.storageState,
      table.processingStartedAt,
      table.updatedAt,
    ),
    check('message_attachment_byte_size', sql`${table.byteSize} is null or ${table.byteSize} >= 0`),
  ],
)

export const mediaAsset = pgTable(
  'media_asset',
  {
    id: uuid().primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    title: text().notNull(),
    filename: text().notNull(),
    kind: messageAttachmentKind().notNull(),
    mimeType: text('mime_type').notNull(),
    byteSize: integer('byte_size').notNull(),
    sha256: text().notNull(),
    storageKey: text('storage_key').notNull(),
    inLibrary: boolean('in_library').default(false).notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('media_asset_workspace_idx').on(t.workspaceId, t.inLibrary, t.deletedAt)],
)

export const facebookMediaUpload = pgTable('facebook_media_upload', {
  attachmentId: uuid('attachment_id')
    .primaryKey()
    .references(() => messageAttachment.id, { onDelete: 'cascade' }),
  providerAttachmentId: text('provider_attachment_id').notNull(),
})

export const replyTemplate = pgTable(
  'reply_template',
  {
    id: uuid().defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    title: text().notNull(),
    text: text().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('reply_template_workspace_idx').on(t.workspaceId)],
)

export const facebookAttachmentSource = pgTable(
  'facebook_attachment_source',
  {
    attachmentId: uuid('attachment_id')
      .primaryKey()
      .references(() => messageAttachment.id, { onDelete: 'cascade' }),
    encryptedSourceUrl: text('encrypted_source_url').notNull(),
    urlIv: text('url_iv').notNull(),
    tokenKeyVersion: text('token_key_version').default('v1').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index('facebook_attachment_source_expires_idx').on(table.expiresAt)],
)

export const deliveryAttempt = pgTable(
  'facebook_delivery_attempt',
  {
    id: uuid().defaultRandom().primaryKey(),
    messageId: uuid('message_id')
      .notNull()
      .references(() => message.id, { onDelete: 'cascade' }),
    attemptNumber: integer('attempt_number').notNull(),
    httpStatus: integer('http_status'),
    retryNotBefore: timestamp('retry_not_before', { withTimezone: true }),
    code: integer(),
    subcode: integer(),
    type: text(),
    message: text(),
    startedAt: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [
    unique().on(table.messageId, table.attemptNumber),
    index('facebook_delivery_attempt_message_idx').on(table.messageId),
    check('facebook_delivery_attempt_number', sql`${table.attemptNumber} > 0`),
  ],
)

export const facebookReferral = pgTable(
  'facebook_referral',
  {
    id: uuid().defaultRandom().primaryKey(),
    channelIdentityId: uuid('channel_identity_id')
      .notNull()
      .references(() => channelIdentity.id, { onDelete: 'cascade' }),
    eventKey: text('event_key').notNull(),
    externalMessageId: text('external_message_id'),
    source: text().notNull(),
    type: text().notNull(),
    ref: text(),
    adId: text('ad_id'),
    refererUri: text('referer_uri'),
    adTitle: text('ad_title'),
    imageUrl: text('image_url'),
    providerSentAt: timestamp('provider_sent_at', { withTimezone: true }),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
    eventAt: timestamp('event_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex('facebook_referral_identity_event_key').on(table.channelIdentityId, table.eventKey),
    index('facebook_referral_timeline_idx').on(table.channelIdentityId, table.eventAt, table.id),
  ],
)

export const facebookWebhookReceipt = pgTable(
  'facebook_webhook_receipt',
  {
    id: uuid().defaultRandom().primaryKey(),
    ingressId: text('ingress_id').notNull(),
    pageId: text('page_id').notNull(),
    externalMessageId: text('external_message_id'),
    eventFragment: jsonb('event_fragment').$type<Record<string, unknown>>().notNull(),
    payloadSha256: text('payload_sha256').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
  },
  (table) => [
    unique().on(table.ingressId),
    index('facebook_webhook_receipt_received_idx').on(table.receivedAt),
  ],
)

export const knowledgeBase = pgTable(
  'knowledge_base',
  {
    id: uuid().defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    embeddingProvider: text('embedding_provider'),
    embeddingModel: text('embedding_model'),
    embeddingDimensions: integer('embedding_dimensions'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index('knowledge_base_workspace_idx').on(table.workspaceId)],
)

export type AiMemberRuntimeSnapshot = {
  stopRules?: AiStopRules
  unparsedFallbackEnabled?: boolean
  unparsedFallbackTexts?: string[]
  splitRepliesEnabled?: boolean
  automaticLanguageEnabled?: boolean
  timeZone?: string
  naturalToneEnabled?: boolean
  memoryEnabled?: boolean
  tagsEnabled?: boolean
  replyWaitEnabled?: boolean
  instructions: string
  responseLanguage: string
  knowledgeBaseId: string
  handoffOnCustomerRequest: boolean
  handoffOnNoKnowledge: boolean
  handoffOnNegativeSentiment: boolean
  handoffOnUnableToAnswer: boolean
  handoffKeywords: string[]
  adLearningEnabled?: boolean
  adMappings?: AdMapping[]
}

export type AiStopCondition =
  | { kind: 'PROPERTY'; definitionId: string; value: string | number }
  | { kind: 'TAG'; tagId: string }
  | { kind: 'REPLIES'; minimum: number }
export type AiStopRules = {
  groups: AiStopCondition[][]
  periods: { day: number; start: string; end: string }[]
  endingText: string
  endingMediaAssetId: string | null
}

export type AiHandoffCondition =
  | Exclude<AiStopCondition, { kind: 'REPLIES' }>
  | { kind: 'SEMANTIC'; text: string }

export const aiHandoffRule = pgTable(
  'ai_handoff_rule',
  {
    id: uuid().defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    memberId: uuid('member_id')
      .notNull()
      .references(() => member.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    enabled: boolean().default(true).notNull(),
    revision: integer().default(1).notNull(),
    condition: jsonb().$type<AiHandoffCondition>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('ai_handoff_rule_member_idx').on(t.workspaceId, t.memberId),
    check('ai_handoff_rule_revision_valid', sql`${t.revision} > 0`),
  ],
)

export type AdMapping = { adId: string; content: string }
export type AdvertisingContext = {
  status: 'DISABLED' | 'NO_SOURCE' | 'UNAVAILABLE' | 'UNMAPPED' | 'MAPPED'
  referralId?: string
  adId?: string
  content?: string
}

export const aiMemberConfig = pgTable('ai_member_config', {
  stopRules: jsonb('stop_rules')
    .$type<AiStopRules>()
    .default({ groups: [], periods: [], endingText: '', endingMediaAssetId: null })
    .notNull(),
  unparsedFallbackEnabled: boolean('unparsed_fallback_enabled').default(false).notNull(),
  unparsedFallbackTexts: jsonb('unparsed_fallback_texts').$type<string[]>().default([]).notNull(),
  splitRepliesEnabled: boolean('split_replies_enabled').default(false).notNull(),
  automaticLanguageEnabled: boolean('automatic_language_enabled').default(false).notNull(),
  timeZone: text('time_zone').default('UTC').notNull(),
  naturalToneEnabled: boolean('natural_tone_enabled').default(false).notNull(),
  memoryEnabled: boolean('memory_enabled').default(false).notNull(),
  tagsEnabled: boolean('tags_enabled').default(false).notNull(),
  replyWaitEnabled: boolean('reply_wait_enabled').default(true).notNull(),
  memberId: uuid('member_id')
    .primaryKey()
    .references(() => member.id, { onDelete: 'cascade' }),
  instructions: text().default('').notNull(),
  responseLanguage: text('response_language').default('').notNull(),
  knowledgeBaseId: uuid('knowledge_base_id').references(() => knowledgeBase.id, {
    onDelete: 'set null',
  }),
  handoffOnCustomerRequest: boolean('handoff_on_customer_request').default(true).notNull(),
  handoffOnNoKnowledge: boolean('handoff_on_no_knowledge').default(true).notNull(),
  handoffOnNegativeSentiment: boolean('handoff_on_negative_sentiment').default(true).notNull(),
  handoffOnUnableToAnswer: boolean('handoff_on_unable_to_answer').default(true).notNull(),
  handoffKeywords: text('handoff_keywords').array().default(sql`ARRAY[]::text[]`).notNull(),
  adLearningEnabled: boolean('ad_learning_enabled').default(false).notNull(),
  adMappings: jsonb('ad_mappings').$type<AdMapping[]>().default([]).notNull(),
  publishedSnapshot: jsonb('published_snapshot').$type<AiMemberRuntimeSnapshot | null>(),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  publishedVersionId: uuid('published_version_id').references(() => aiConfigVersion.id, {
    onDelete: 'set null',
  }),
  runtimeStatus: aiRuntimeStatus('runtime_status').default('UNPUBLISHED').notNull(),
  runtimeError: text('runtime_error'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})

export const aiConfigVersion = pgTable('ai_config_version', {
  id: uuid().defaultRandom().primaryKey(),
  memberId: uuid('member_id')
    .notNull()
    .references(() => member.id, { onDelete: 'cascade' }),
  snapshot: jsonb().$type<AiMemberRuntimeSnapshot>().notNull(),
  publishedAt: timestamp('published_at', { withTimezone: true }).defaultNow().notNull(),
})

export const customerMemory = pgTable(
  'customer_memory',
  {
    customerId: uuid('customer_id')
      .primaryKey()
      .references(() => customer.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    summary: text().default('').notNull(),
    revision: integer().default(0).notNull(),
    cursor: bigint({ mode: 'number' }).default(0).notNull(),
    clearedAt: timestamp('cleared_at', { withTimezone: true })
      .default(sql`'1970-01-01'::timestamptz`)
      .notNull(),
    latestActivityAt: timestamp('latest_activity_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    sourceChannelIds: uuid('source_channel_ids').array().default(sql`ARRAY[]::uuid[]`).notNull(),
    pendingOperationId: uuid('pending_operation_id'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('customer_memory_due_idx').on(t.latestActivityAt),
    check('customer_memory_summary_size', sql`char_length(${t.summary}) <= 1000`),
    check('customer_memory_revision_valid', sql`${t.revision} >= 0 and ${t.cursor} >= 0`),
  ],
)

export const customerMemoryCommunication = pgTable(
  'customer_memory_communication',
  {
    sequence: bigserial({ mode: 'number' }).primaryKey(),
    messageId: uuid('message_id')
      .notNull()
      .unique()
      .references(() => message.id, { onDelete: 'cascade' }),
    identityId: uuid('identity_id')
      .notNull()
      .references(() => channelIdentity.id, { onDelete: 'cascade' }),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('customer_memory_communication_identity_idx').on(t.identityId, t.sequence)],
)

export const aiBudget = pgTable(
  'ai_budget',
  {
    workspaceId: uuid('workspace_id')
      .primaryKey()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    monthlyLimit: integer('monthly_limit'),
  },
  (table) => [check('ai_budget_limit_nonnegative', sql`${table.monthlyLimit} >= 0`)],
)

export type AiTestCustomer = {
  properties: { definitionId: string; value: string | number }[]
  tags: string[]
  source: string
  language: string
  memory: string
}

export const aiTestSession = pgTable(
  'ai_test_session',
  {
    id: uuid().primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    memberId: uuid('member_id')
      .notNull()
      .references(() => member.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    source: text().notNull(),
    snapshot: jsonb().$type<AiMemberRuntimeSnapshot>().notNull(),
    configVersionId: uuid('config_version_id').references(() => aiConfigVersion.id, {
      onDelete: 'set null',
    }),
    generation: integer().default(1).notNull(),
    customer: jsonb().$type<AiTestCustomer>().notNull(),
    operationIds: uuid('operation_ids').array().default(sql`ARRAY[]::uuid[]`).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('ai_test_session_workspace_idx').on(t.workspaceId, t.memberId),
    check('ai_test_session_source_valid', sql`${t.source} in ('DRAFT', 'PUBLISHED', 'VERSION')`),
    check('ai_test_session_generation_valid', sql`${t.generation} > 0`),
  ],
)

export const aiQuestionSet = pgTable(
  'ai_question_set',
  {
    id: uuid().primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    memberId: uuid('member_id')
      .notNull()
      .references(() => member.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    questions: jsonb().$type<string[]>().notNull(),
    revision: integer().default(1).notNull(),
  },
  (t) => [
    index('ai_question_set_workspace_idx').on(t.workspaceId, t.memberId),
    check('ai_question_set_size_valid', sql`jsonb_array_length(${t.questions}) between 1 and 100`),
    check('ai_question_set_revision_valid', sql`${t.revision} > 0`),
  ],
)

export const aiTestBatch = pgTable(
  'ai_test_batch',
  {
    id: uuid().primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    memberId: uuid('member_id')
      .notNull()
      .references(() => member.id, { onDelete: 'cascade' }),
    questionSetId: uuid('question_set_id').references(() => aiQuestionSet.id, {
      onDelete: 'set null',
    }),
    name: text().notNull(),
    source: text().notNull(),
    snapshot: jsonb().$type<AiMemberRuntimeSnapshot>().notNull(),
    configVersionId: uuid('config_version_id').references(() => aiConfigVersion.id, {
      onDelete: 'set null',
    }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('ai_test_batch_workspace_idx').on(t.workspaceId, t.memberId),
    check('ai_test_batch_source_valid', sql`${t.source} in ('DRAFT', 'PUBLISHED', 'VERSION')`),
  ],
)

export const aiTestBatchItem = pgTable(
  'ai_test_batch_item',
  {
    id: uuid().primaryKey(),
    batchId: uuid('batch_id')
      .notNull()
      .references(() => aiTestBatch.id, { onDelete: 'cascade' }),
    position: integer().notNull(),
    text: text().notNull(),
    state: text().default('QUEUED').notNull(),
    attempt: integer().default(0).notNull(),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    retryAt: timestamp('retry_at', { withTimezone: true }),
    failureCode: text('failure_code'),
  },
  (t) => [
    uniqueIndex('ai_test_batch_item_position_unique').on(t.batchId, t.position),
    uniqueIndex('ai_test_batch_item_running_unique')
      .on(t.batchId)
      .where(sql`${t.state} = 'RUNNING'`),
    check('ai_test_batch_item_position_valid', sql`${t.position} between 0 and 99`),
    check('ai_test_batch_item_attempt_valid', sql`${t.attempt} between 0 and 3`),
    check(
      'ai_test_batch_item_state_valid',
      sql`${t.state} in ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'UNKNOWN', 'CANCELLED')`,
    ),
  ],
)

export const aiOperation = pgTable(
  'ai_operation',
  {
    id: uuid().primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    memberId: uuid('member_id').references(() => member.id, { onDelete: 'set null' }),
    configVersionId: uuid('config_version_id').references(() => aiConfigVersion.id, {
      onDelete: 'set null',
    }),
    kind: text().notNull(),
    state: text().default('RESERVED').notNull(),
    period: text().notNull(),
    charged: boolean().default(false).notNull(),
    failureCode: text('failure_code'),
    input: text(),
    output: jsonb(),
    snapshot: jsonb().$type<AiMemberRuntimeSnapshot>(),
    chunkIds: uuid('chunk_ids').array().default(sql`ARRAY[]::uuid[]`).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('ai_operation_workspace_period_idx').on(table.workspaceId, table.period),
    check(
      'ai_operation_kind_valid',
      sql`${table.kind} in ('LIVE_REPLY', 'TEST', 'KNOWLEDGE_INDEX', 'TRANSLATION', 'SUGGESTION', 'PERSONA', 'CUSTOMER_MEMORY', 'FOLLOW_UP')`,
    ),
    check(
      'ai_operation_state_valid',
      sql`${table.state} in ('RESERVED', 'STARTED', 'COMPLETED', 'FAILED', 'UNKNOWN', 'CANCELLED')`,
    ),
  ],
)

export const messageTranslation = pgTable(
  'message_translation',
  {
    id: uuid().primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversation.id, { onDelete: 'cascade' }),
    requesterMemberId: uuid('requester_member_id')
      .notNull()
      .references(() => member.id, { onDelete: 'cascade' }),
    sourceMessageId: uuid('source_message_id').references(() => message.id, {
      onDelete: 'cascade',
    }),
    sourceVersion: uuid('source_version').notNull(),
    sourceText: text('source_text').notNull(),
    targetLanguage: text('target_language').notNull(),
    translatedText: text('translated_text'),
    sentMessageId: uuid('sent_message_id').references(() => message.id),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('message_translation_source_language_idx').on(
      table.requesterMemberId,
      table.sourceMessageId,
      table.targetLanguage,
    ),
    index('message_translation_conversation_idx').on(table.conversationId),
  ],
)

export const replySuggestion = pgTable(
  'reply_suggestion',
  {
    id: uuid().primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversation.id, { onDelete: 'cascade' }),
    requesterMemberId: uuid('requester_member_id')
      .notNull()
      .references(() => member.id, { onDelete: 'cascade' }),
    aiMemberId: uuid('ai_member_id')
      .notNull()
      .references(() => member.id, { onDelete: 'cascade' }),
    inputMessageId: uuid('input_message_id')
      .notNull()
      .references(() => message.id, { onDelete: 'cascade' }),
    contextMessageIds: uuid('context_message_ids').array().notNull(),
    snapshot: jsonb().$type<AiMemberRuntimeSnapshot>().notNull(),
    configVersionId: uuid('config_version_id').references(() => aiConfigVersion.id, {
      onDelete: 'set null',
    }),
    suggestedText: text('suggested_text'),
    chunkIds: uuid('chunk_ids').array().default(sql`ARRAY[]::uuid[]`).notNull(),
    sentMessageId: uuid('sent_message_id').references(() => message.id),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index('reply_suggestion_conversation_idx').on(table.conversationId)],
)

export const aiProviderAttempt = pgTable(
  'ai_provider_attempt',
  {
    id: uuid().defaultRandom().primaryKey(),
    operationId: uuid('operation_id')
      .notNull()
      .references(() => aiOperation.id, { onDelete: 'cascade' }),
    stage: text().notNull(),
    state: text().default('STARTED').notNull(),
    httpStatus: integer('http_status'),
    response: jsonb(),
    retryAt: timestamp('retry_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [
    index('ai_provider_attempt_operation_idx').on(table.operationId),
    check(
      'ai_provider_attempt_state_valid',
      sql`${table.state} in ('STARTED', 'SUCCESS', 'FAILED', 'UNKNOWN')`,
    ),
  ],
)

export const aiFeedback = pgTable(
  'ai_feedback',
  {
    id: uuid().defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    runId: uuid('run_id').references(() => aiResponseRun.id, { onDelete: 'cascade' }),
    operationId: uuid('operation_id').references(() => aiOperation.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    category: text().notNull(),
    note: text().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check('ai_feedback_one_source', sql`num_nonnulls(${table.runId}, ${table.operationId}) = 1`),
    check('ai_feedback_category_valid', sql`${table.category} in ('KNOWLEDGE', 'MODEL', 'OTHER')`),
  ],
)

export const knowledgeDocument = pgTable(
  'knowledge_document',
  {
    id: uuid().defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    knowledgeBaseId: uuid('knowledge_base_id')
      .notNull()
      .references(() => knowledgeBase.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    sourceType: knowledgeDocumentSourceType('source_type').notNull(),
    sourceText: text('source_text'),
    mediaAssetId: uuid('media_asset_id').references(() => mediaAsset.id),
    question: text(),
    answer: text(),
    questionKey: text('question_key'),
    revision: integer().default(1).notNull(),
    indexOperationId: uuid('index_operation_id').defaultRandom().notNull(),
    storageKey: text('storage_key'),
    status: knowledgeDocumentStatus().default('UPLOADED').notNull(),
    processingStartedAt: timestamp('processing_started_at', { withTimezone: true }),
    contentSha256: text('content_sha256'),
    failureCode: text('failure_code'),
    failureMessage: text('failure_message'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('knowledge_document_base_created_idx').on(
      table.knowledgeBaseId,
      table.createdAt,
      table.id,
    ),
    index('knowledge_document_processing_idx').on(
      table.status,
      table.processingStartedAt,
      table.updatedAt,
    ),
    uniqueIndex('knowledge_question_base_key').on(table.knowledgeBaseId, table.questionKey),
    check(
      'knowledge_question_consistency',
      sql`(${table.question} is null and ${table.answer} is null and ${table.questionKey} is null) or (${table.question} is not null and ${table.answer} is not null and ${table.questionKey} is not null and ${table.sourceType} = 'TEXT')`,
    ),
    check('knowledge_revision_positive', sql`${table.revision} > 0`),
  ],
)

export const knowledgeChunk = pgTable(
  'knowledge_chunk',
  {
    id: uuid().defaultRandom().primaryKey(),
    knowledgeDocumentId: uuid('knowledge_document_id')
      .notNull()
      .references(() => knowledgeDocument.id, { onDelete: 'cascade' }),
    knowledgeBaseId: uuid('knowledge_base_id')
      .notNull()
      .references(() => knowledgeBase.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    ordinal: integer().notNull(),
    text: text().notNull(),
    embedding: vector('embedding', { dimensions: 1536 }).notNull(),
  },
  (table) => [
    unique().on(table.knowledgeDocumentId, table.ordinal),
    index('knowledge_chunk_scope_idx').on(table.workspaceId, table.knowledgeBaseId),
    index('knowledge_chunk_embedding_hnsw_idx').using(
      'hnsw',
      table.embedding.op('vector_cosine_ops'),
    ),
  ],
)

export const aiFollowUpRule = pgTable(
  'ai_follow_up_rule',
  {
    id: uuid().primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    memberId: uuid('member_id')
      .notNull()
      .references(() => member.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    enabled: boolean().default(false).notNull(),
    revision: integer().default(1).notNull(),
    timer: text().$type<'LAST_AI_REPLY' | 'AI_ASSIGNMENT'>().notNull(),
    delaySeconds: integer('delay_seconds').notNull(),
    instructions: text().default('').notNull(),
    groups: jsonb().$type<AiStopCondition[][]>().default([]).notNull(),
    effectiveAt: timestamp('effective_at', { withTimezone: true }).defaultNow().notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('ai_follow_up_rule_member_idx').on(t.memberId, t.enabled),
    check(
      'ai_follow_up_rule_valid',
      sql`${t.revision} > 0 and ${t.delaySeconds} between 1 and 2592000 and ${t.timer} in ('LAST_AI_REPLY','AI_ASSIGNMENT')`,
    ),
  ],
)

export const aiFollowUpEvent = pgTable(
  'ai_follow_up_event',
  {
    id: uuid()
      .primaryKey()
      .references(() => aiResponseRun.id, { onDelete: 'cascade' }),
    ruleId: uuid('rule_id')
      .notNull()
      .references(() => aiFollowUpRule.id),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversation.id, { onDelete: 'cascade' }),
    ruleRevision: integer('rule_revision').notNull(),
    anchorId: uuid('anchor_id').notNull(),
    anchorAt: timestamp('anchor_at', { withTimezone: true }).notNull(),
    dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
    triggeredAt: timestamp('triggered_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('ai_follow_up_event_once_idx').on(t.ruleId, t.conversationId)],
)
