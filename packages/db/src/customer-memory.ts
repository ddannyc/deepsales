import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { reserveAiOperation } from './ai-operations'
import type { Database } from './database'
import {
  aiMemberConfig,
  aiOperation,
  channel,
  channelIdentity,
  customerMemory,
  customerMemoryCommunication,
  member,
  memberChannelAccess,
  message,
  workspace,
} from './schema'

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0]
type Handle = Database | Transaction
export type CustomerMemoryInput = {
  customerId: string
  revision: number
  throughCursor: number
  sourceChannelIds: string[]
  previousSummary: string
  messages: { id: string; text: string; origin: string; truncated: boolean }[]
}

export async function memoryChannelsAllowed(
  db: Handle,
  workspaceId: string,
  memberId: string,
  ids: string[],
) {
  const [viewer] = await db
    .select({ id: member.id })
    .from(member)
    .where(
      and(
        eq(member.id, memberId),
        eq(member.workspaceId, workspaceId),
        eq(member.status, 'ACTIVE'),
      ),
    )
  if (!viewer) return false
  const allowed = ids.length
    ? await db
        .select({ id: channel.id })
        .from(memberChannelAccess)
        .innerJoin(channel, eq(channel.id, memberChannelAccess.channelId))
        .where(
          and(
            eq(memberChannelAccess.memberId, memberId),
            eq(channel.workspaceId, workspaceId),
            eq(channel.status, 'ACTIVE'),
            inArray(channel.id, ids),
          ),
        )
    : []
  return ids.every((id) => allowed.some((a) => a.id === id))
}

export async function readCustomerMemory(
  db: Handle,
  input: { workspaceId: string; customerId: string; memberId: string },
) {
  const [memory] = await db
    .select()
    .from(customerMemory)
    .where(
      and(
        eq(customerMemory.customerId, input.customerId),
        eq(customerMemory.workspaceId, input.workspaceId),
      ),
    )
  if (!memory)
    return { available: true, summary: '', revision: 0, sourceChannelIds: [], state: 'EMPTY' }
  if (
    !(await memoryChannelsAllowed(db, input.workspaceId, input.memberId, memory.sourceChannelIds))
  )
    return {
      available: false,
      summary: '',
      revision: memory.revision,
      sourceChannelIds: [],
      state: 'RESTRICTED',
    }
  const [operation] = memory.pendingOperationId
    ? await db
        .select({ state: aiOperation.state })
        .from(aiOperation)
        .where(eq(aiOperation.id, memory.pendingOperationId))
    : []
  return {
    available: true,
    summary: memory.summary,
    revision: memory.revision,
    sourceChannelIds: memory.sourceChannelIds,
    state: operation?.state ?? (memory.summary ? 'READY' : 'EMPTY'),
  }
}

export async function invalidateCustomerMemory(
  tx: Transaction,
  input: { workspaceId: string; customerId: string; clear: boolean; expectedRevision?: number },
) {
  if (input.clear)
    await tx
      .select({ id: channelIdentity.id })
      .from(channelIdentity)
      .where(
        and(
          eq(channelIdentity.customerId, input.customerId),
          eq(channelIdentity.workspaceId, input.workspaceId),
        ),
      )
      .orderBy(asc(channelIdentity.id))
      .for('update')
  await tx
    .insert(customerMemory)
    .values({ workspaceId: input.workspaceId, customerId: input.customerId })
    .onConflictDoNothing()
  const [memory] = await tx
    .select()
    .from(customerMemory)
    .where(
      and(
        eq(customerMemory.customerId, input.customerId),
        eq(customerMemory.workspaceId, input.workspaceId),
      ),
    )
    .for('update')
  if (
    !memory ||
    (input.expectedRevision !== undefined && memory.revision !== input.expectedRevision)
  )
    return false
  if (memory.pendingOperationId)
    await tx
      .update(aiOperation)
      .set({ state: 'CANCELLED', failureCode: 'MEMORY_CLEARED', updatedAt: new Date() })
      .where(
        and(
          eq(aiOperation.id, memory.pendingOperationId),
          sql`${aiOperation.state} in ('RESERVED', 'STARTED')`,
        ),
      )
  let boundary = memory.cursor
  if (input.clear) {
    const [maximum] = await tx
      .select({
        value: sql<number>`coalesce(max(${customerMemoryCommunication.sequence}), 0)::bigint`,
      })
      .from(customerMemoryCommunication)
    boundary = Number(maximum?.value ?? 0)
    await tx
      .update(channelIdentity)
      .set({ memoryBoundarySequence: boundary, memoryBoundaryAt: new Date() })
      .where(
        and(
          eq(channelIdentity.customerId, input.customerId),
          eq(channelIdentity.workspaceId, input.workspaceId),
        ),
      )
  }
  await tx
    .update(customerMemory)
    .set({
      revision: memory.revision + 1,
      pendingOperationId: null,
      updatedAt: new Date(),
      ...(input.clear
        ? { summary: '', sourceChannelIds: [], cursor: boundary, clearedAt: new Date() }
        : {}),
    })
    .where(eq(customerMemory.customerId, input.customerId))
  return true
}

export async function listDueCustomerMemoryIds(db: Database, now = new Date()) {
  const rows = await db.execute<{ customer_id: string; revision: number }>(sql`
    select cm.customer_id, cm.revision from customer_memory cm where cm.latest_activity_at <= ${new Date(now.getTime() - 600_000)}
    and exists (select 1 from member m join ai_member_config cfg on cfg.member_id = m.id
      where m.workspace_id = cm.workspace_id and m.status = 'ACTIVE' and m.type = 'AI'
      and cfg.published_snapshot->>'memoryEnabled' = 'true'
      and (cm.pending_operation_id is null or m.id = (select op.member_id from ai_operation op where op.id = cm.pending_operation_id))
      and not exists (select 1 from (
        select unnest(cm.source_channel_ids) as channel_id where cm.pending_operation_id is null
        union select (jsonb_array_elements_text(op.input::jsonb->'sourceChannelIds'))::uuid from ai_operation op where op.id = cm.pending_operation_id
        union select i.channel_id from customer_memory_communication e join channel_identity i on i.id = e.identity_id
          where cm.pending_operation_id is null and i.customer_id = cm.customer_id and e.sequence > cm.cursor and e.sequence > i.memory_boundary_sequence
      ) sources left join channel c on c.id = sources.channel_id and c.workspace_id = cm.workspace_id and c.status = 'ACTIVE'
      where c.id is null or not exists (select 1 from member_channel_access a where a.member_id = m.id and a.channel_id = sources.channel_id)))
    and ((cm.pending_operation_id is not null and exists (select 1 from ai_operation op where op.id = cm.pending_operation_id and op.state in ('RESERVED', 'STARTED')))
      or (cm.pending_operation_id is null and exists (select 1 from customer_memory_communication e
      join channel_identity i on i.id = e.identity_id where i.customer_id = cm.customer_id
      and e.sequence > cm.cursor and e.sequence > i.memory_boundary_sequence)))
    order by cm.latest_activity_at, cm.customer_id limit 50`)
  return rows.rows.map((r) => ({ customerId: r.customer_id, revision: r.revision }))
}

export async function prepareCustomerMemoryUpdate(
  db: Database,
  customerId: string,
  expectedRevision: number,
  now = new Date(),
) {
  const [reference] = await db
    .select({ workspaceId: customerMemory.workspaceId })
    .from(customerMemory)
    .where(eq(customerMemory.customerId, customerId))
  if (!reference) return null
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select id from ${workspace} where id = ${reference.workspaceId} for update`,
    )
    const [memory] = await tx
      .select()
      .from(customerMemory)
      .where(eq(customerMemory.customerId, customerId))
      .for('update')
    if (
      !memory ||
      memory.revision !== expectedRevision ||
      memory.latestActivityAt.getTime() > now.getTime() - 600_000
    )
      return null
    if (memory.pendingOperationId) {
      const [existing] = await tx
        .select()
        .from(aiOperation)
        .where(eq(aiOperation.id, memory.pendingOperationId))
      if (
        !existing?.memberId ||
        !['RESERVED', 'STARTED'].includes(existing.state) ||
        !existing.input
      )
        return null
      const input = JSON.parse(existing.input) as CustomerMemoryInput
      return (await memoryUpdateAllowed(tx, existing.workspaceId, existing.memberId, input))
        ? existing
        : null
    }
    const contributions = await tx
      .selectDistinct({ id: channelIdentity.channelId })
      .from(customerMemoryCommunication)
      .innerJoin(channelIdentity, eq(channelIdentity.id, customerMemoryCommunication.identityId))
      .where(
        and(
          eq(channelIdentity.customerId, customerId),
          sql`${customerMemoryCommunication.sequence} > ${memory.cursor}`,
          sql`${customerMemoryCommunication.sequence} > ${channelIdentity.memoryBoundarySequence}`,
        ),
      )
    const sourceIds = [...new Set([...memory.sourceChannelIds, ...contributions.map((c) => c.id)])]
    const candidates = await tx
      .select({ id: member.id, versionId: aiMemberConfig.publishedVersionId })
      .from(member)
      .innerJoin(aiMemberConfig, eq(aiMemberConfig.memberId, member.id))
      .where(
        and(
          eq(member.workspaceId, reference.workspaceId),
          eq(member.status, 'ACTIVE'),
          eq(member.type, 'AI'),
          sql`${aiMemberConfig.publishedSnapshot}->>'memoryEnabled' = 'true'`,
        ),
      )
      .orderBy(asc(member.id))
    for (const candidate of candidates) {
      if (!(await memoryChannelsAllowed(tx, reference.workspaceId, candidate.id, sourceIds)))
        continue
      const rows = await tx
        .select({
          sequence: customerMemoryCommunication.sequence,
          id: message.id,
          text: message.text,
          origin: message.senderType,
          channelId: channelIdentity.channelId,
        })
        .from(customerMemoryCommunication)
        .innerJoin(channelIdentity, eq(channelIdentity.id, customerMemoryCommunication.identityId))
        .innerJoin(message, eq(message.id, customerMemoryCommunication.messageId))
        .where(
          and(
            eq(channelIdentity.customerId, customerId),
            sql`${customerMemoryCommunication.sequence} > ${memory.cursor}`,
            sql`${customerMemoryCommunication.sequence} > ${channelIdentity.memoryBoundarySequence}`,
          ),
        )
        .orderBy(asc(customerMemoryCommunication.sequence))
        .limit(50)
      if (!rows.length) return null
      const messages: CustomerMemoryInput['messages'] = []
      let size = 0,
        throughCursor = memory.cursor
      for (const row of rows) {
        const points = Array.from(row.text?.trim() || '[Attachment; content not extracted]')
        if (messages.length && size + points.length > 8000) break
        const remaining = 8000 - size
        const text = points.slice(0, remaining).join('')
        messages.push({
          id: row.id,
          text,
          origin: row.origin,
          truncated: points.length > remaining,
        })
        size += Array.from(text).length
        throughCursor = row.sequence
      }
      const input: CustomerMemoryInput = {
        customerId,
        revision: memory.revision,
        throughCursor,
        sourceChannelIds: [
          ...new Set([
            ...memory.sourceChannelIds,
            ...rows.filter((r) => r.sequence <= throughCursor).map((r) => r.channelId),
          ]),
        ],
        previousSummary: memory.summary,
        messages,
      }
      const operation = await reserveAiOperation(tx, {
        id: crypto.randomUUID(),
        workspaceId: reference.workspaceId,
        memberId: candidate.id,
        configVersionId: candidate.versionId,
        kind: 'CUSTOMER_MEMORY',
        text: JSON.stringify(input),
        now,
      })
      await tx
        .update(customerMemory)
        .set({ pendingOperationId: operation.id })
        .where(eq(customerMemory.customerId, customerId))
      return operation
    }
    return null
  })
}

async function memoryUpdateAllowed(
  tx: Transaction,
  workspaceId: string,
  memberId: string,
  input: CustomerMemoryInput,
) {
  const [config] = await tx
    .select({ snapshot: aiMemberConfig.publishedSnapshot })
    .from(aiMemberConfig)
    .where(eq(aiMemberConfig.memberId, memberId))
  const [memory] = await tx
    .select()
    .from(customerMemory)
    .where(
      and(
        eq(customerMemory.customerId, input.customerId),
        eq(customerMemory.workspaceId, workspaceId),
      ),
    )
  return (
    config?.snapshot?.memoryEnabled === true &&
    memory?.revision === input.revision &&
    (await memoryChannelsAllowed(tx, workspaceId, memberId, input.sourceChannelIds))
  )
}

export async function completeCustomerMemoryUpdate(
  db: Database,
  operationId: string,
  summary: string,
) {
  if (!summary.trim() || Array.from(summary).length > 1000) throw new Error('Invalid memory output')
  return db.transaction(async (tx) => {
    const [operation] = await tx.select().from(aiOperation).where(eq(aiOperation.id, operationId))
    if (operation?.kind !== 'CUSTOMER_MEMORY' || !operation.memberId || !operation.input)
      return false
    await tx.execute(sql`select id from ${workspace} where id = ${operation.workspaceId} for share`)
    const input = JSON.parse(operation.input) as CustomerMemoryInput
    const [memory] = await tx
      .select()
      .from(customerMemory)
      .where(eq(customerMemory.customerId, input.customerId))
      .for('update')
    if (
      memory?.pendingOperationId !== operationId ||
      !(await memoryUpdateAllowed(tx, operation.workspaceId, operation.memberId, input))
    ) {
      await tx
        .update(aiOperation)
        .set({ state: 'CANCELLED', failureCode: 'MEMORY_INPUT_CHANGED' })
        .where(
          and(
            eq(aiOperation.id, operationId),
            sql`${aiOperation.state} in ('RESERVED', 'STARTED')`,
          ),
        )
      if (memory?.pendingOperationId === operationId)
        await tx
          .update(customerMemory)
          .set({ pendingOperationId: null })
          .where(eq(customerMemory.customerId, input.customerId))
      return false
    }
    const completed = await tx
      .update(aiOperation)
      .set({ state: 'COMPLETED', output: { summary: summary.trim() }, updatedAt: new Date() })
      .where(
        and(eq(aiOperation.id, operationId), sql`${aiOperation.state} in ('RESERVED', 'STARTED')`),
      )
      .returning()
    if (!completed.length) return false
    await tx
      .update(customerMemory)
      .set({
        summary: summary.trim(),
        revision: memory.revision + 1,
        cursor: input.throughCursor,
        sourceChannelIds: input.sourceChannelIds,
        pendingOperationId: null,
        updatedAt: new Date(),
      })
      .where(eq(customerMemory.customerId, input.customerId))
    return true
  })
}
