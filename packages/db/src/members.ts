import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { requeueMemberConversation } from './assignments'
import type { Database } from './database'
import {
  aiMemberConfig,
  channel,
  conversation,
  humanMemberAvailability,
  member,
  memberChannelAccess,
  registrationInvitation,
  user,
  workspace,
  workspaceInvitation,
  workspaceUserAccess,
} from './schema'

export const INVITATION_TTL_MS = 24 * 60 * 60 * 1_000

export type MemberErrorCode =
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'INVALID_REQUEST'
  | 'ALREADY_MEMBER'
  | 'INVITATION_INVALID'
  | 'INVITATION_EXPIRED'
  | 'INVITATION_USED'
  | 'INVITATION_EMAIL_MISMATCH'
  | 'WORKSPACE_SETUP_REQUIRED'
  | 'WORKSPACE_ALREADY_EXISTS'

export class MemberError extends Error {
  constructor(
    readonly code: MemberErrorCode,
    message: string = code,
  ) {
    super(message)
  }
}

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0]

export type CreateInvitationInput = {
  workspaceId: string
  createdByUserId: string
  email: string
  role: 'ADMIN' | 'AGENT'
  displayName?: string | null
  available?: boolean
  autoAssignmentEnabled?: boolean
  maxActiveConversations?: number
  channelIds?: string[]
  expiresAt?: Date
}

export async function createInvitation(db: Database, input: CreateInvitationInput) {
  const email = normalizeEmail(input.email)
  if (!isEmail(email) || !['ADMIN', 'AGENT'].includes(input.role)) {
    throw new MemberError('INVALID_REQUEST', 'Invalid invitation')
  }

  const expiresAt = input.expiresAt ?? new Date(Date.now() + INVITATION_TTL_MS)
  if (expiresAt.getTime() <= Date.now()) {
    throw new MemberError('INVALID_REQUEST', 'Invitation must expire in the future')
  }

  const token = createToken()
  const tokenHash = await hashInvitationToken(token)
  const displayName = cleanDisplayName(input.displayName)
  if (
    input.maxActiveConversations !== undefined &&
    (!Number.isInteger(input.maxActiveConversations) || input.maxActiveConversations < 0)
  ) {
    throw new MemberError('INVALID_REQUEST', 'Capacity must be a non-negative integer')
  }

  return db.transaction(async (tx) => {
    await assertManager(tx, input.workspaceId, input.createdByUserId)
    const channelIds = unique(input.channelIds ?? [])
    await assertChannelsBelongToWorkspace(tx, input.workspaceId, channelIds)

    const [existing] = await tx
      .select({ id: workspaceUserAccess.id })
      .from(workspaceUserAccess)
      .innerJoin(user, eq(user.id, workspaceUserAccess.userId))
      .where(
        and(
          eq(workspaceUserAccess.workspaceId, input.workspaceId),
          sql`lower(${user.email}) = ${email}`,
        ),
      )
      .limit(1)
    if (existing) throw new MemberError('ALREADY_MEMBER', 'User is already a member')

    const [created] = await tx
      .insert(workspaceInvitation)
      .values({
        workspaceId: input.workspaceId,
        email,
        role: input.role,
        displayName,
        available: input.available ?? true,
        autoAssignmentEnabled: input.autoAssignmentEnabled ?? true,
        maxActiveConversations: input.maxActiveConversations ?? 10,
        channelIds,
        tokenHash,
        expiresAt,
        createdByUserId: input.createdByUserId,
      })
      .returning({
        id: workspaceInvitation.id,
        workspaceId: workspaceInvitation.workspaceId,
        email: workspaceInvitation.email,
        role: workspaceInvitation.role,
        displayName: workspaceInvitation.displayName,
        expiresAt: workspaceInvitation.expiresAt,
      })

    return { ...created, token }
  })
}

export async function createRegistrationInvitation(
  db: Database,
  input: { email: string; expiresAt?: Date },
) {
  const email = normalizeEmail(input.email)
  if (!isEmail(email)) throw new MemberError('INVALID_REQUEST', 'Invalid invitation')

  const expiresAt = input.expiresAt ?? new Date(Date.now() + INVITATION_TTL_MS)
  if (expiresAt.getTime() <= Date.now()) {
    throw new MemberError('INVALID_REQUEST', 'Invitation must expire in the future')
  }

  const token = createToken()
  const tokenHash = await hashInvitationToken(token)
  const [created] = await db
    .insert(registrationInvitation)
    .values({ email, tokenHash, expiresAt })
    .returning({
      id: registrationInvitation.id,
      email: registrationInvitation.email,
      expiresAt: registrationInvitation.expiresAt,
    })
  if (!created) throw new MemberError('INVITATION_INVALID', 'Invitation could not be created')
  return { ...created, token }
}

export type AcceptInvitationInput = {
  token: string
  userId: string
  userEmail: string
  userName: string
}

export type ValidateInvitationInput = {
  token: string
  userEmail?: string
}

export async function validateInvitation(db: Database, input: ValidateInvitationInput) {
  const email = input.userEmail ? normalizeEmail(input.userEmail) : undefined
  if (!input.token || (email !== undefined && !isEmail(email))) {
    throw new MemberError('INVITATION_INVALID', 'Invitation is invalid')
  }

  const tokenHash = await hashInvitationToken(input.token)
  return db.transaction(async (tx) => {
    const invitation = await lockInvitation(tx, tokenHash)
    assertInvitationUsable(invitation, email)
    const [targetWorkspace] = await tx
      .select({ name: workspace.name })
      .from(workspace)
      .where(eq(workspace.id, invitation.workspaceId))
      .limit(1)
    if (!targetWorkspace) throw new MemberError('INVITATION_INVALID', 'Invitation is invalid')
    return {
      id: invitation.id,
      workspaceId: invitation.workspaceId,
      workspaceName: targetWorkspace.name,
      email: invitation.email,
      expiresAt: invitation.expiresAt,
    }
  })
}

export async function validateRegistrationInvitation(db: Database, input: ValidateInvitationInput) {
  const email = input.userEmail ? normalizeEmail(input.userEmail) : undefined
  if (!input.token || (email !== undefined && !isEmail(email))) {
    throw new MemberError('INVITATION_INVALID', 'Invitation is invalid')
  }

  const tokenHash = await hashInvitationToken(input.token)
  return db.transaction(async (tx) => {
    const invitation = await lockRegistrationInvitation(tx, tokenHash)
    assertRegistrationInvitationUsable(invitation, email)
    return { id: invitation.id, email: invitation.email, expiresAt: invitation.expiresAt }
  })
}

export async function acceptInvitation(db: Database, input: AcceptInvitationInput) {
  const email = normalizeEmail(input.userEmail)
  if (!input.token || !isEmail(email)) {
    throw new MemberError('INVITATION_INVALID', 'Invitation is invalid')
  }

  const tokenHash = await hashInvitationToken(input.token)
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`${input.userId}:${tokenHash}`}, 0))`,
    )

    const invitation = await lockInvitation(tx, tokenHash)
    assertInvitationUsable(invitation, email)
    await assertChannelsBelongToWorkspace(tx, invitation.workspaceId, invitation.channelIds)

    const [existing] = await tx
      .select({ id: workspaceUserAccess.id })
      .from(workspaceUserAccess)
      .where(
        and(
          eq(workspaceUserAccess.workspaceId, invitation.workspaceId),
          eq(workspaceUserAccess.userId, input.userId),
        ),
      )
      .limit(1)
    if (existing) throw new MemberError('ALREADY_MEMBER', 'User is already a member')

    const [access] = await tx
      .insert(workspaceUserAccess)
      .values({
        workspaceId: invitation.workspaceId,
        userId: input.userId,
        role: invitation.role,
      })
      .returning({ id: workspaceUserAccess.id })
    const [human] = await tx
      .insert(member)
      .values({
        workspaceId: invitation.workspaceId,
        type: 'HUMAN',
        workspaceUserAccessId: access.id,
        displayName: cleanDisplayName(invitation.displayName) ?? cleanDisplayName(input.userName),
        autoAssignmentEnabled: invitation.autoAssignmentEnabled,
        maxActiveConversations: invitation.maxActiveConversations,
      })
      .returning({ id: member.id })
    await tx
      .insert(humanMemberAvailability)
      .values({ memberId: human.id, available: invitation.available })
    await replaceChannelAccess(tx, human.id, invitation.channelIds)
    await tx
      .update(workspaceInvitation)
      .set({ acceptedAt: new Date(), updatedAt: new Date() })
      .where(eq(workspaceInvitation.id, invitation.id))

    return {
      workspaceId: invitation.workspaceId,
      accessId: access.id,
      memberId: human.id,
    }
  })
}

export async function acceptRegistrationInvitation(
  db: Database,
  input: Pick<AcceptInvitationInput, 'token' | 'userId' | 'userEmail'>,
) {
  const email = normalizeEmail(input.userEmail)
  if (!input.token || !isEmail(email)) {
    throw new MemberError('INVITATION_INVALID', 'Invitation is invalid')
  }

  const tokenHash = await hashInvitationToken(input.token)
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${input.userId}, 0))`)
    const invitation = await lockRegistrationInvitation(tx, tokenHash)
    if (invitation.email !== email) {
      throw new MemberError('INVITATION_EMAIL_MISMATCH', 'Invitation email does not match')
    }
    if (invitation.workspaceCreatedAt) {
      throw new MemberError('INVITATION_USED', 'Invitation was used')
    }
    if (invitation.acceptedByUserId && invitation.acceptedByUserId !== input.userId) {
      throw new MemberError('INVITATION_USED', 'Invitation was used')
    }

    const [acceptedInvite] = await tx
      .select({ id: registrationInvitation.id })
      .from(registrationInvitation)
      .where(eq(registrationInvitation.acceptedByUserId, input.userId))
      .limit(1)
    if (acceptedInvite && acceptedInvite.id !== invitation.id) {
      throw new MemberError('INVITATION_USED', 'A registration invitation was already accepted')
    }

    const [existingAccess] = await tx
      .select({ id: workspaceUserAccess.id })
      .from(workspaceUserAccess)
      .where(eq(workspaceUserAccess.userId, input.userId))
      .limit(1)
    if (existingAccess) {
      throw new MemberError('WORKSPACE_ALREADY_EXISTS', 'User already belongs to a workspace')
    }

    if (!invitation.acceptedByUserId) {
      assertRegistrationInvitationUsable(invitation, email)
      const acceptedAt = new Date()
      await tx
        .update(registrationInvitation)
        .set({ acceptedByUserId: input.userId, acceptedAt, updatedAt: acceptedAt })
        .where(eq(registrationInvitation.id, invitation.id))
    }

    return { invitationId: invitation.id }
  })
}

export async function validateAnyInvitation(db: Database, input: ValidateInvitationInput) {
  try {
    const invitation = await validateInvitation(db, input)
    return {
      type: 'WORKSPACE_MEMBER' as const,
      workspaceName: invitation.workspaceName,
      expiresAt: invitation.expiresAt,
    }
  } catch (error) {
    if (!(error instanceof MemberError) || error.code !== 'INVITATION_INVALID') throw error
  }

  const invitation = await validateRegistrationInvitation(db, input)
  return { type: 'WORKSPACE_CREATOR' as const, expiresAt: invitation.expiresAt }
}

export async function acceptAnyInvitation(db: Database, input: AcceptInvitationInput) {
  try {
    return {
      type: 'WORKSPACE_MEMBER' as const,
      ...(await acceptInvitation(db, input)),
    }
  } catch (error) {
    if (!(error instanceof MemberError) || error.code !== 'INVITATION_INVALID') throw error
  }

  return {
    type: 'WORKSPACE_CREATOR' as const,
    ...(await acceptRegistrationInvitation(db, input)),
  }
}

export async function listTeam(db: Database, workspaceId: string) {
  const [members, channels, accesses] = await Promise.all([
    db
      .select({
        id: member.id,
        type: member.type,
        displayName: member.displayName,
        avatarUrl: member.avatarUrl,
        status: member.status,
        autoAssignmentEnabled: member.autoAssignmentEnabled,
        maxActiveConversations: member.maxActiveConversations,
        lastAutoAssignedAt: member.lastAutoAssignedAt,
        availability: humanMemberAvailability.available,
        role: workspaceUserAccess.role,
        userId: workspaceUserAccess.userId,
        email: user.email,
        runtimeStatus: aiMemberConfig.runtimeStatus,
      })
      .from(member)
      .leftJoin(humanMemberAvailability, eq(humanMemberAvailability.memberId, member.id))
      .leftJoin(workspaceUserAccess, eq(workspaceUserAccess.id, member.workspaceUserAccessId))
      .leftJoin(user, eq(user.id, workspaceUserAccess.userId))
      .leftJoin(aiMemberConfig, eq(aiMemberConfig.memberId, member.id))
      .where(eq(member.workspaceId, workspaceId))
      .orderBy(asc(member.createdAt), asc(member.id)),
    db
      .select({
        id: channel.id,
        displayName: channel.displayName,
        provider: channel.provider,
        status: channel.status,
      })
      .from(channel)
      .where(eq(channel.workspaceId, workspaceId))
      .orderBy(asc(channel.displayName), asc(channel.id)),
    db
      .select({ memberId: memberChannelAccess.memberId, channelId: memberChannelAccess.channelId })
      .from(memberChannelAccess)
      .innerJoin(channel, eq(channel.id, memberChannelAccess.channelId))
      .where(eq(channel.workspaceId, workspaceId)),
  ])

  const channelIdsByMember = new Map<string, string[]>()
  for (const access of accesses) {
    channelIdsByMember.set(access.memberId, [
      ...(channelIdsByMember.get(access.memberId) ?? []),
      access.channelId,
    ])
  }

  return {
    channels,
    members: members.map((item) => ({
      ...item,
      availability: item.type === 'HUMAN' ? item.availability : null,
      configurationStatus: item.type === 'AI' ? (item.runtimeStatus ?? 'UNPUBLISHED') : null,
      channelIds: channelIdsByMember.get(item.id) ?? [],
    })),
  }
}

export type CreateAiMemberInput = {
  workspaceId: string
  createdByUserId: string
  displayName: string
  avatarUrl?: string | null
  autoAssignmentEnabled?: boolean
  maxActiveConversations?: number
  channelIds?: string[]
}

export async function createAiMember(db: Database, input: CreateAiMemberInput) {
  const displayName = cleanDisplayName(input.displayName)
  if (!displayName) throw new MemberError('INVALID_REQUEST', 'Display name is required')
  if (
    input.maxActiveConversations !== undefined &&
    (!Number.isInteger(input.maxActiveConversations) || input.maxActiveConversations < 0)
  ) {
    throw new MemberError('INVALID_REQUEST', 'Capacity must be a non-negative integer')
  }

  return db.transaction(async (tx) => {
    await assertManager(tx, input.workspaceId, input.createdByUserId)
    const channelIds = unique(input.channelIds ?? [])
    await assertChannelsBelongToWorkspace(tx, input.workspaceId, channelIds)
    const [created] = await tx
      .insert(member)
      .values({
        workspaceId: input.workspaceId,
        type: 'AI',
        displayName,
        avatarUrl: input.avatarUrl ?? null,
        autoAssignmentEnabled: input.autoAssignmentEnabled ?? true,
        maxActiveConversations: input.maxActiveConversations ?? 10,
      })
      .returning({ id: member.id })
    await replaceChannelAccess(tx, created.id, channelIds)
    return { id: created.id }
  })
}

export type UpdateMemberInput = {
  workspaceId: string
  memberId: string
  actingUserId: string
  displayName?: string | null
  avatarUrl?: string | null
  status?: 'ACTIVE' | 'DISABLED'
  autoAssignmentEnabled?: boolean
  maxActiveConversations?: number
  available?: boolean
  role?: 'ADMIN' | 'AGENT'
  channelIds?: string[]
}

export async function updateMember(db: Database, input: UpdateMemberInput) {
  if (
    input.maxActiveConversations !== undefined &&
    (!Number.isInteger(input.maxActiveConversations) || input.maxActiveConversations < 0)
  ) {
    throw new MemberError('INVALID_REQUEST', 'Capacity must be a non-negative integer')
  }

  return db.transaction(async (tx) => {
    await assertManager(tx, input.workspaceId, input.actingUserId)
    await tx.execute(sql`select id from ${workspace} where id = ${input.workspaceId} for update`)
    const [target] = await tx
      .select({
        id: member.id,
        type: member.type,
        status: member.status,
        workspaceUserAccessId: member.workspaceUserAccessId,
        role: workspaceUserAccess.role,
      })
      .from(member)
      .leftJoin(workspaceUserAccess, eq(workspaceUserAccess.id, member.workspaceUserAccessId))
      .where(and(eq(member.id, input.memberId), eq(member.workspaceId, input.workspaceId)))
      .limit(1)
    if (!target) throw new MemberError('NOT_FOUND', 'Member not found')
    if (target.role === 'OWNER' && (input.status === 'DISABLED' || input.role !== undefined)) {
      throw new MemberError('FORBIDDEN', 'The owner cannot be changed')
    }
    if (input.role && target.type !== 'HUMAN') {
      throw new MemberError('INVALID_REQUEST', 'AI members have no workspace role')
    }
    if (input.available !== undefined && target.type !== 'HUMAN') {
      throw new MemberError('INVALID_REQUEST', 'AI members have no availability')
    }
    if (input.channelIds !== undefined) {
      await assertChannelsBelongToWorkspace(tx, input.workspaceId, unique(input.channelIds))
    }
    const accessId = target.workspaceUserAccessId
    if (input.role !== undefined && !accessId) {
      throw new MemberError('INVALID_REQUEST', 'Human member access is missing')
    }

    const requeuedConversationIds: string[] = []
    if (input.status === 'DISABLED' && target.status !== 'DISABLED') {
      const ownedConversations = await tx
        .select({ id: conversation.id })
        .from(conversation)
        .where(
          and(
            eq(conversation.workspaceId, input.workspaceId),
            eq(conversation.status, 'OPEN'),
            eq(conversation.assigneeMemberId, input.memberId),
          ),
        )
        .orderBy(asc(conversation.id))

      for (const owned of ownedConversations) {
        const result = await requeueMemberConversation(tx, {
          workspaceId: input.workspaceId,
          conversationId: owned.id,
          memberId: input.memberId,
          actingUserId: input.actingUserId,
        })
        if (result.changed) requeuedConversationIds.push(owned.id)
      }
    }

    const values: Partial<typeof member.$inferInsert> = { updatedAt: new Date() }
    if (input.displayName !== undefined) values.displayName = cleanDisplayName(input.displayName)
    if (input.avatarUrl !== undefined) values.avatarUrl = input.avatarUrl
    if (input.status !== undefined) values.status = input.status
    if (input.autoAssignmentEnabled !== undefined) {
      values.autoAssignmentEnabled = input.autoAssignmentEnabled
    }
    if (input.maxActiveConversations !== undefined) {
      values.maxActiveConversations = input.maxActiveConversations
    }
    await tx.update(member).set(values).where(eq(member.id, input.memberId))

    if (input.role !== undefined) {
      await tx
        .update(workspaceUserAccess)
        .set({ role: input.role, updatedAt: new Date() })
        .where(eq(workspaceUserAccess.id, accessId as string))
    }
    if (input.available !== undefined) {
      await tx
        .insert(humanMemberAvailability)
        .values({ memberId: input.memberId, available: input.available })
        .onConflictDoUpdate({
          target: humanMemberAvailability.memberId,
          set: { available: input.available, updatedAt: new Date() },
        })
    }
    if (input.channelIds !== undefined) {
      await replaceChannelAccess(tx, input.memberId, unique(input.channelIds))
    }

    return { id: input.memberId, requeuedConversationIds }
  })
}

export async function setMemberChannelAccess(
  db: Database,
  input: {
    workspaceId: string
    memberId: string
    actingUserId: string
    channelIds: string[]
  },
) {
  return db.transaction(async (tx) => {
    await assertManager(tx, input.workspaceId, input.actingUserId)
    await tx.execute(sql`select id from ${workspace} where id = ${input.workspaceId} for update`)
    const [target] = await tx
      .select({ id: member.id })
      .from(member)
      .where(and(eq(member.id, input.memberId), eq(member.workspaceId, input.workspaceId)))
      .limit(1)
    if (!target) throw new MemberError('NOT_FOUND', 'Member not found')
    const channelIds = unique(input.channelIds)
    await assertChannelsBelongToWorkspace(tx, input.workspaceId, channelIds)
    await replaceChannelAccess(tx, input.memberId, channelIds)
    return { memberId: input.memberId, channelIds }
  })
}

export async function deleteMember(
  db: Database,
  input: { workspaceId: string; memberId: string; actingUserId: string },
) {
  return db.transaction(async (tx) => {
    await assertManager(tx, input.workspaceId, input.actingUserId)
    const [target] = await tx
      .select({
        role: workspaceUserAccess.role,
        workspaceUserAccessId: member.workspaceUserAccessId,
      })
      .from(member)
      .leftJoin(workspaceUserAccess, eq(workspaceUserAccess.id, member.workspaceUserAccessId))
      .where(and(eq(member.id, input.memberId), eq(member.workspaceId, input.workspaceId)))
      .limit(1)
    if (!target) throw new MemberError('NOT_FOUND', 'Member not found')
    if (target.role === 'OWNER') throw new MemberError('FORBIDDEN', 'The owner cannot be removed')
    await tx.delete(member).where(eq(member.id, input.memberId))
    if (target.workspaceUserAccessId) {
      await tx
        .delete(workspaceUserAccess)
        .where(eq(workspaceUserAccess.id, target.workspaceUserAccessId))
    }
    return { memberId: input.memberId }
  })
}

async function assertManager(tx: Transaction, workspaceId: string, userId: string) {
  await tx.execute(
    sql`select id from workspace_user_access where workspace_id = ${workspaceId} and user_id = ${userId} for update`,
  )
  const [access] = await tx
    .select({ role: workspaceUserAccess.role })
    .from(workspaceUserAccess)
    .where(
      and(eq(workspaceUserAccess.workspaceId, workspaceId), eq(workspaceUserAccess.userId, userId)),
    )
    .limit(1)
  if (!access || access.role === 'AGENT')
    throw new MemberError('FORBIDDEN', 'Manager access required')
  return access.role
}

async function assertChannelsBelongToWorkspace(
  tx: Transaction,
  workspaceId: string,
  channelIds: string[],
) {
  if (!channelIds.length) return
  const rows = await tx
    .select({ id: channel.id })
    .from(channel)
    .where(and(eq(channel.workspaceId, workspaceId), inArray(channel.id, channelIds)))
  if (rows.length !== channelIds.length) {
    throw new MemberError('FORBIDDEN', 'Channel access must stay in the workspace')
  }
}

async function replaceChannelAccess(tx: Transaction, memberId: string, channelIds: string[]) {
  await tx.delete(memberChannelAccess).where(eq(memberChannelAccess.memberId, memberId))
  if (channelIds.length) {
    await tx
      .insert(memberChannelAccess)
      .values(channelIds.map((channelId) => ({ memberId, channelId })))
  }
}

async function lockInvitation(tx: Transaction, tokenHash: string) {
  const locked = await tx.execute(
    sql`select id from workspace_invitation where token_hash = ${tokenHash} for update`,
  )
  if (!locked.rows.length) throw new MemberError('INVITATION_INVALID', 'Invitation is invalid')

  const [invitation] = await tx
    .select()
    .from(workspaceInvitation)
    .where(eq(workspaceInvitation.tokenHash, tokenHash))
    .limit(1)
  if (!invitation) throw new MemberError('INVITATION_INVALID', 'Invitation is invalid')
  return invitation
}

async function lockRegistrationInvitation(tx: Transaction, tokenHash: string) {
  const locked = await tx.execute(
    sql`select id from registration_invitation where token_hash = ${tokenHash} for update`,
  )
  if (!locked.rows.length) throw new MemberError('INVITATION_INVALID', 'Invitation is invalid')

  const [invitation] = await tx
    .select()
    .from(registrationInvitation)
    .where(eq(registrationInvitation.tokenHash, tokenHash))
    .limit(1)
  if (!invitation) throw new MemberError('INVITATION_INVALID', 'Invitation is invalid')
  return invitation
}

function assertInvitationUsable(
  invitation: typeof workspaceInvitation.$inferSelect,
  email?: string,
) {
  if (invitation.acceptedAt) throw new MemberError('INVITATION_USED', 'Invitation was used')
  if (invitation.revokedAt) throw new MemberError('INVITATION_INVALID', 'Invitation is invalid')
  if (invitation.expiresAt.getTime() <= Date.now()) {
    throw new MemberError('INVITATION_EXPIRED', 'Invitation expired')
  }
  if (email !== undefined && invitation.email !== email) {
    throw new MemberError('INVITATION_EMAIL_MISMATCH', 'Invitation email does not match')
  }
}

function assertRegistrationInvitationUsable(
  invitation: typeof registrationInvitation.$inferSelect,
  email?: string,
) {
  if (invitation.acceptedByUserId || invitation.acceptedAt || invitation.workspaceCreatedAt) {
    throw new MemberError('INVITATION_USED', 'Invitation was used')
  }
  if (invitation.expiresAt.getTime() <= Date.now()) {
    throw new MemberError('INVITATION_EXPIRED', 'Invitation expired')
  }
  if (email !== undefined && invitation.email !== email) {
    throw new MemberError('INVITATION_EMAIL_MISMATCH', 'Invitation email does not match')
  }
}

export function normalizeEmail(email: string) {
  return email.trim().toLowerCase()
}

export async function hashInvitationToken(token: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function createToken() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')
}

function cleanDisplayName(displayName: string | null | undefined) {
  const value = displayName?.trim()
  return value || null
}

function isEmail(email: string) {
  return /^[^\s@]+@[^\s@]+$/.test(email)
}

function unique(values: string[]) {
  return [...new Set(values)]
}
