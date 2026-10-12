import { and, eq, sql } from 'drizzle-orm'
import { AiMemberError, getAiMemberConfig } from './ai-members'
import { AiUsageError, reserveAiOperation } from './ai-operations'
import type { Database } from './database'
import { aiOperation, channel, knowledgeDocument, memberChannelAccess, workspace } from './schema'

type Identity = { workspaceId: string; memberId: string; actingUserId: string }
export type PersonaInput = Identity & {
  id: string
  mode: 'GENERATE' | 'OPTIMIZE'
  brief: string
  sourceInstructions: string
}

export async function getAiSetupStatus(db: Database, input: Identity) {
  const config = await getAiMemberConfig(db, input)
  const [documents] = await db
    .select({ count: sql<number>`count(*)::integer` })
    .from(knowledgeDocument)
    .where(
      and(
        eq(knowledgeDocument.workspaceId, input.workspaceId),
        eq(
          knowledgeDocument.knowledgeBaseId,
          config.knowledgeBaseId ?? '00000000-0000-0000-0000-000000000000',
        ),
        eq(knowledgeDocument.status, 'READY'),
      ),
    )
  const channels = await db
    .select({ id: channel.id, name: channel.displayName })
    .from(memberChannelAccess)
    .innerJoin(channel, eq(channel.id, memberChannelAccess.channelId))
    .where(
      and(
        eq(memberChannelAccess.memberId, input.memberId),
        eq(channel.workspaceId, input.workspaceId),
        eq(channel.status, 'ACTIVE'),
      ),
    )
  return {
    memberActive: config.memberStatus === 'ACTIVE',
    knowledgeBaseId: config.knowledgeBaseId,
    readyDocuments: documents?.count ?? 0,
    channels,
  }
}

export async function createPersonaOperation(db: Database, input: PersonaInput) {
  if (
    !['GENERATE', 'OPTIMIZE'].includes(input.mode) ||
    !input.brief.trim() ||
    input.brief.length > 2000 ||
    input.sourceInstructions.length > 20000 ||
    (input.mode === 'OPTIMIZE' && !input.sourceInstructions.trim())
  )
    throw new AiMemberError('INVALID_REQUEST')
  return db.transaction(async (tx) => {
    await tx.execute(sql`select id from ${workspace} where id = ${input.workspaceId} for update`)
    const config = await getAiMemberConfig(tx, input)
    if (config.memberStatus !== 'ACTIVE') throw new AiMemberError('INVALID_REQUEST')
    const text = JSON.stringify({
      mode: input.mode,
      brief: input.brief.trim(),
      sourceInstructions: input.sourceInstructions,
      actingUserId: input.actingUserId,
    })
    return reserveAiOperation(tx, {
      id: input.id,
      workspaceId: input.workspaceId,
      memberId: input.memberId,
      kind: 'PERSONA',
      text,
    })
  })
}

export async function completePersonaOperation(
  db: Database,
  input: Identity & { id: string; instructions: string },
) {
  if (!input.instructions.trim() || Array.from(input.instructions).length > 20000)
    throw new AiMemberError('INVALID_REQUEST')
  return db.transaction(async (tx) => {
    await tx.execute(sql`select id from ${workspace} where id = ${input.workspaceId} for share`)
    const config = await getAiMemberConfig(tx, input)
    if (config.memberStatus !== 'ACTIVE') throw new AiMemberError('INVALID_REQUEST')
    const [record] = await tx
      .select()
      .from(aiOperation)
      .where(
        and(
          eq(aiOperation.id, input.id),
          eq(aiOperation.workspaceId, input.workspaceId),
          eq(aiOperation.memberId, input.memberId),
          eq(aiOperation.kind, 'PERSONA'),
        ),
      )
      .for('update')
    if (!record?.input || JSON.parse(record.input).actingUserId !== input.actingUserId)
      throw new AiMemberError('NOT_FOUND')
    if (!['RESERVED', 'STARTED'].includes(record.state)) throw new AiUsageError('OPERATION_PAUSED')
    await tx
      .update(aiOperation)
      .set({
        output: { instructions: input.instructions.trim() },
        state: 'COMPLETED',
        updatedAt: new Date(),
      })
      .where(eq(aiOperation.id, record.id))
    return {
      id: record.id,
      sourceInstructions: JSON.parse(record.input).sourceInstructions as string,
      instructions: input.instructions.trim(),
    }
  })
}
