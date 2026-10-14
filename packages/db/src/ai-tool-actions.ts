import { and, eq, sql } from 'drizzle-orm'
import { AiResponseError, type CommitAiResponseResult, commitAiResponse } from './ai-responses'
import { type AiToolCall, instructionTools, validateAiToolCalls } from './ai-tools'
import { type AssignmentResult, executeAssignment } from './assignments'
import type { Database } from './database'
import { createAiInternalNote } from './inbox-collaboration'
import { aiMemberConfig, aiResponseRun, aiToolAction, conversation, workspace } from './schema'

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0]
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
async function lockActionRun(tx: Transaction, input: ActionInput) {
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

export async function executeAiBuiltinAction(db: Database, input: ActionInput) {
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
    return { action, guard: state === 'CANCELLED' ? guard : null }
  })
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
