import { and, eq, inArray, sql } from 'drizzle-orm'
import { AiResponseError, type CommitAiResponseResult, commitAiResponse } from './ai-responses'
import { type AiToolCall, instructionTools, validateAiToolCalls } from './ai-tools'
import { type AssignmentResult, executeAssignment } from './assignments'
import type { Database } from './database'
import { createAiInternalNote } from './inbox-collaboration'
import {
  aiMemberConfig,
  aiResponseRun,
  aiToolAction,
  conversation,
  knowledgeChunk,
  knowledgeDocument,
  mediaAsset,
  workspace,
} from './schema'

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0]
export type AiToolSearchChunk = { id: string; text: string; mediaAssetId: string | null }

export async function readAiToolSearchChunks(
  db: Database | Transaction,
  input: { workspaceId: string; knowledgeBaseId: string; ids: string[] },
) {
  const { ids } = input
  if (!Array.isArray(ids) || ids.length > 6 || ids.some((id) => typeof id !== 'string'))
    throw new AiResponseError('INVALID_REQUEST')
  const chunks = ids.length
    ? await db
        .select({
          id: knowledgeChunk.id,
          text: knowledgeChunk.text,
          mediaAssetId: knowledgeDocument.mediaAssetId,
        })
        .from(knowledgeChunk)
        .innerJoin(knowledgeDocument, eq(knowledgeDocument.id, knowledgeChunk.knowledgeDocumentId))
        .leftJoin(mediaAsset, eq(mediaAsset.id, knowledgeDocument.mediaAssetId))
        .where(
          and(
            inArray(knowledgeChunk.id, ids),
            eq(knowledgeChunk.workspaceId, input.workspaceId),
            eq(knowledgeDocument.workspaceId, input.workspaceId),
            eq(knowledgeDocument.knowledgeBaseId, input.knowledgeBaseId),
            eq(knowledgeDocument.status, 'READY'),
            sql`(${knowledgeDocument.mediaAssetId} is null or (${mediaAsset.inLibrary} and ${mediaAsset.deletedAt} is null))`,
          ),
        )
    : []
  if (chunks.length !== ids.length) throw new AiResponseError('INVALID_REQUEST')
  return ids.map((id) => {
    const chunk = chunks.find((chunk) => chunk.id === id)
    if (!chunk) throw new AiResponseError('INVALID_REQUEST')
    return chunk
  })
}
type ActionInput = {
  runId: string
  ordinal: number
  call: AiToolCall
  noticeText?: string
  reply?: Pick<
    Parameters<typeof commitAiResponse>[1],
    'text' | 'languageSelection' | 'collectedProperties' | 'appendedTags'
  >
  handoffEvaluation?: Parameters<typeof commitAiResponse>[1]['handoffEvaluation']
}

// Workspace first, matching assignment and response commit lock ordering.
async function lockActionRun(tx: Transaction, input: Pick<ActionInput, 'runId'>) {
  const [reference] = await tx
    .select({ workspaceId: conversation.workspaceId })
    .from(aiResponseRun)
    .innerJoin(conversation, eq(conversation.id, aiResponseRun.conversationId))
    .where(eq(aiResponseRun.id, input.runId))
  if (!reference) throw new AiResponseError('INVALID_REQUEST')
  await tx.execute(sql`select id from ${workspace} where id = ${reference.workspaceId} for update`)
  const [run] = await tx.select().from(aiResponseRun).where(eq(aiResponseRun.id, input.runId))
  if (!run) throw new AiResponseError('INVALID_REQUEST')
  return { ...run, workspaceId: reference.workspaceId }
}

async function checkTool(
  tx: Transaction,
  input: ActionInput,
  run: Awaited<ReturnType<typeof lockActionRun>>,
) {
  if (!Number.isInteger(input.ordinal) || input.ordinal < 0 || input.ordinal > 2)
    throw new AiResponseError('INVALID_REQUEST')
  validateAiToolCalls(run.configSnapshot?.instructions ?? '', [input.call])
  const [current] = await tx
    .select({ snapshot: aiMemberConfig.publishedSnapshot })
    .from(aiMemberConfig)
    .where(eq(aiMemberConfig.memberId, run.memberId))
  if (!instructionTools(current?.snapshot?.instructions ?? '').includes(input.call.tool))
    return false
  return true
}

async function cancelRevokedToolRun(tx: Transaction, runId: string) {
  await tx
    .update(aiResponseRun)
    .set({
      state: 'CANCELLED',
      failureCode: 'TOOL_AUTHORIZATION_CHANGED',
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(aiResponseRun.id, runId), eq(aiResponseRun.state, 'GENERATING')))
}

export async function cancelAiToolAuthorizationRun(db: Database, runId: string) {
  await db.transaction(async (tx) => {
    await lockActionRun(tx, { runId })
    await cancelRevokedToolRun(tx, runId)
  })
}

export async function failPendingAiToolActions(
  db: Database,
  input: { runId: string; unknown: boolean; failureCode: string },
) {
  await db
    .update(aiToolAction)
    .set({
      state: input.unknown ? 'UNKNOWN' : 'FAILED',
      failureCode: input.failureCode.slice(0, 100),
      completedAt: new Date(),
    })
    .where(
      and(eq(aiToolAction.runId, input.runId), inArray(aiToolAction.state, ['PENDING', 'RUNNING'])),
    )
}

export async function executeAiBuiltinAction(
  db: Database,
  input: ActionInput,
  search?: (input: {
    workspaceId: string
    knowledgeBaseId: string
    query: string
    actionId: string
  }) => Promise<AiToolSearchChunk[]>,
) {
  const claim = await db.transaction(async (tx) => {
    const run = await lockActionRun(tx, input)
    const [existing] = await tx
      .select()
      .from(aiToolAction)
      .where(and(eq(aiToolAction.operationId, run.id), eq(aiToolAction.ordinal, input.ordinal)))
    if (
      existing &&
      (existing.tool !== input.call.tool ||
        JSON.stringify(existing.arguments) !== JSON.stringify(input.call.arguments))
    )
      throw new AiResponseError('INVALID_REQUEST')
    if (existing?.state === 'SUCCEEDED') return { action: existing, guard: null }
    if (existing && !['PENDING', 'RUNNING'].includes(existing.state))
      return { action: existing, guard: null }
    const allowed = await checkTool(tx, input, run)
    const guard = await commitAiResponse(tx, {
      runId: run.id,
      text: '',
      stopCheckOnly: true,
      handoffEvaluation: input.handoffEvaluation,
    })
    const state = allowed && guard?.kind === 'CONTINUE' ? 'RUNNING' : 'CANCELLED'
    if (!allowed && guard?.kind === 'CONTINUE') await cancelRevokedToolRun(tx, run.id)
    const values = {
      state,
      startedAt: new Date(),
      failureCode: allowed ? null : 'TOOL_AUTHORIZATION_CHANGED',
      completedAt: state === 'CANCELLED' ? new Date() : null,
    } as const
    const [action] = existing
      ? await tx
          .update(aiToolAction)
          .set(values)
          .where(eq(aiToolAction.id, existing.id))
          .returning()
      : await tx
          .insert(aiToolAction)
          .values({
            ...values,
            workspaceId: run.workspaceId,
            memberId: run.memberId,
            operationId: run.id,
            runId: run.id,
            ordinal: input.ordinal,
            tool: input.call.tool,
            arguments: input.call.arguments,
          })
          .returning()
    return {
      action,
      guard: state === 'CANCELLED' ? guard : null,
      knowledgeBaseId: run.configSnapshot?.knowledgeBaseId,
    }
  })
  if (input.call.tool === 'search' && ['RUNNING', 'SUCCEEDED'].includes(claim.action.state)) {
    let ids = (claim.action.result?.chunkIds ?? []) as string[]
    if (claim.action.state !== 'SUCCEEDED') {
      if (!search || !claim.knowledgeBaseId) throw new AiResponseError('INVALID_REQUEST')
      // Read-only retrieval and its provider calls happen after the durable claim, outside transactions.
      const chunks = await search({
        workspaceId: claim.action.workspaceId,
        knowledgeBaseId: claim.knowledgeBaseId,
        query: input.call.arguments.query,
        actionId: claim.action.id,
      })
      ids = chunks.map((chunk) => chunk.id)
      if (ids.length > 6 || new Set(ids).size !== ids.length)
        throw new AiResponseError('INVALID_REQUEST')
    }
    return db.transaction(async (tx) => {
      const run = await lockActionRun(tx, input)
      const [action] = await tx
        .select()
        .from(aiToolAction)
        .where(eq(aiToolAction.id, claim.action.id))
        .for('update')
      const allowed = await checkTool(tx, input, run)
      const guard = await commitAiResponse(tx, {
        runId: run.id,
        text: '',
        stopCheckOnly: true,
        handoffEvaluation: input.handoffEvaluation,
      })
      if (!allowed || guard?.kind !== 'CONTINUE') {
        if (!allowed && guard?.kind === 'CONTINUE') await cancelRevokedToolRun(tx, run.id)
        const [cancelled] =
          action.state === 'SUCCEEDED'
            ? [action]
            : await tx
                .update(aiToolAction)
                .set({
                  state: 'CANCELLED',
                  failureCode: 'RUN_AUTHORIZATION_CHANGED',
                  completedAt: new Date(),
                })
                .where(eq(aiToolAction.id, action.id))
                .returning()
        return { action: cancelled, result: guard, withheld: true }
      }
      // Re-read canonical authorized content even when reusing an already successful search.
      const ordered = await readAiToolSearchChunks(tx, {
        workspaceId: run.workspaceId,
        knowledgeBaseId: run.configSnapshot?.knowledgeBaseId ?? '',
        ids,
      })
      await tx
        .update(aiResponseRun)
        .set({
          retrievedChunkIds: [...new Set([...(run.retrievedChunkIds ?? []), ...ids])],
          updatedAt: new Date(),
        })
        .where(eq(aiResponseRun.id, run.id))
      const [completed] =
        action.state === 'SUCCEEDED'
          ? [action]
          : await tx
              .update(aiToolAction)
              .set({ state: 'SUCCEEDED', result: { chunkIds: ids }, completedAt: new Date() })
              .where(eq(aiToolAction.id, action.id))
              .returning()
      return { action: completed, result: { kind: 'CONTINUE' as const }, searchChunks: ordered }
    })
  }
  if (claim.action.state !== 'RUNNING') return { action: claim.action, result: claim.guard }
  // Claim is durable before execution. Database effects and their successful receipt commit together.
  return db.transaction(async (tx) => {
    const run = await lockActionRun(tx, input)
    const [action] = await tx
      .select()
      .from(aiToolAction)
      .where(eq(aiToolAction.id, claim.action.id))
      .for('update')
    if (action.state !== 'RUNNING') return { action, result: null }
    const allowed = await checkTool(tx, input, run)
    const guard = await commitAiResponse(tx, {
      runId: run.id,
      text: '',
      stopCheckOnly: true,
      handoffEvaluation: input.handoffEvaluation,
    })
    if (!allowed || guard?.kind !== 'CONTINUE') {
      if (!allowed && guard?.kind === 'CONTINUE') await cancelRevokedToolRun(tx, run.id)
      const [cancelled] = await tx
        .update(aiToolAction)
        .set({
          state: 'CANCELLED',
          failureCode: allowed ? 'RUN_AUTHORIZATION_CHANGED' : 'TOOL_AUTHORIZATION_CHANGED',
          completedAt: new Date(),
        })
        .where(eq(aiToolAction.id, action.id))
        .returning()
      return { action: cancelled, result: guard }
    }
    let result: CommitAiResponseResult
    let noteId: string | undefined
    let handoff: AssignmentResult | undefined
    if (input.call.tool === 'skip')
      result = await commitAiResponse(tx, {
        runId: run.id,
        text: '',
        toolSkip: true,
        handoffEvaluation: input.handoffEvaluation,
      })
    else if (input.call.tool === 'record') {
      const recorded = await createAiInternalNote(tx, {
        runId: run.id,
        clientKey: action.id,
        text: input.call.arguments.text,
        handoffEvaluation: input.handoffEvaluation,
      })
      result = 'guard' in recorded ? (recorded.guard ?? null) : { kind: 'CONTINUE' }
      noteId = recorded.noteId
    } else if (input.call.tool === 'handoff') {
      handoff = await executeAssignment(tx, {
        type: 'AI_HANDOFF',
        workspaceId: run.workspaceId,
        conversationId: run.conversationId,
        memberId: run.memberId,
        runId: run.id,
        reason: 'UNABLE_TO_ANSWER',
        failureCode: 'TOOL_HANDOFF',
        noticeText: input.noticeText,
      })
      result = null
    } else if (input.call.tool === 'send_media' && input.reply)
      result = await commitAiResponse(tx, {
        ...input.reply,
        runId: run.id,
        mediaAssetId: input.call.arguments.assetId,
        handoffEvaluation: input.handoffEvaluation,
      })
    else throw new AiResponseError('INVALID_REQUEST')
    const [completed] = await tx
      .update(aiToolAction)
      .set({
        state:
          result?.kind === 'SKIPPED' || result?.kind === 'COMMITTED' || noteId || handoff?.changed
            ? 'SUCCEEDED'
            : 'CANCELLED',
        result: {
          kind: handoff?.changed ? 'HANDOFF' : (result?.kind ?? 'CANCELLED'),
          ...(noteId ? { noteId } : {}),
          ...(handoff?.changed
            ? { assignmentId: handoff.assignmentId, messageId: handoff.messageId }
            : {}),
        },
        completedAt: new Date(),
      })
      .where(eq(aiToolAction.id, action.id))
      .returning()
    return { action: completed, result, handoff }
  })
}
