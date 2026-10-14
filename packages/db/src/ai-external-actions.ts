import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import { AiResponseError, commitAiResponse } from './ai-responses'
import { aiSelectedSkillInstructions, selectedAiSkillId } from './ai-skills'
import { instructionTools, validateAiToolCalls, type AiToolCall } from './ai-tools'
import { readAiViewerChannelIds } from './ai-members'
import { validValue } from './ai-external-contracts'
import { authorizeAiTestTool } from './ai-operations'
import type { Database } from './database'
import {
  aiExternalPlugin,
  aiExternalTool,
  aiMemberConfig,
  aiOperation,
  aiResponseRun,
  aiToolAction,
  channel,
  channelIdentity,
  conversation,
  memberChannelAccess,
  workspace,
} from './schema'

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0]
type ExternalCall = Extract<AiToolCall, { tool: 'external' }>
export type ExternalActionInput = {
  runId: string
  ordinal: number
  call: ExternalCall
  handoffEvaluation?: Parameters<typeof commitAiResponse>[1]['handoffEvaluation']
}

export async function readAiExternalCatalog(
  db: Database | Tx,
  input: { workspaceId: string; memberId: string; channelId?: string; actingUserId?: string },
) {
  const viewerChannels = input.actingUserId
    ? await readAiViewerChannelIds(db, { ...input, actingUserId: input.actingUserId })
    : null
  return db
    .select({
      tool: aiExternalTool,
      origin: aiExternalPlugin.origin,
      channelId: aiExternalPlugin.channelId,
      pluginId: aiExternalPlugin.id,
      pluginRevision: aiExternalPlugin.revision,
      auth: aiExternalPlugin.auth,
    })
    .from(aiExternalTool)
    .innerJoin(aiExternalPlugin, eq(aiExternalPlugin.id, aiExternalTool.pluginId))
    .innerJoin(channel, eq(channel.id, aiExternalPlugin.channelId))
    .innerJoin(
      memberChannelAccess,
      and(
        eq(memberChannelAccess.memberId, input.memberId),
        eq(memberChannelAccess.channelId, channel.id),
      ),
    )
    .where(
      and(
        eq(aiExternalPlugin.workspaceId, input.workspaceId),
        eq(aiExternalPlugin.memberId, input.memberId),
        eq(aiExternalPlugin.enabled, true),
        eq(aiExternalTool.enabled, true),
        isNull(aiExternalPlugin.deletedAt),
        isNull(aiExternalTool.deletedAt),
        eq(channel.workspaceId, input.workspaceId),
        eq(channel.status, 'ACTIVE'),
        sql`(${aiExternalPlugin.auth} = 'NONE' or ${aiExternalPlugin.encryptedCredential} is not null)`,
        input.channelId ? eq(channel.id, input.channelId) : undefined,
        viewerChannels ? inArray(channel.id, viewerChannels) : undefined,
      ),
    )
}

async function lockRun(tx: Tx, runId: string) {
  const [reference] = await tx
    .select({ workspaceId: conversation.workspaceId, channelId: channelIdentity.channelId })
    .from(aiResponseRun)
    .innerJoin(conversation, eq(conversation.id, aiResponseRun.conversationId))
    .innerJoin(channelIdentity, eq(channelIdentity.id, conversation.channelIdentityId))
    .where(eq(aiResponseRun.id, runId))
  if (!reference) throw new AiResponseError('INVALID_REQUEST')
  await tx.execute(sql`select id from ${workspace} where id = ${reference.workspaceId} for update`)
  const [run] = await tx.select().from(aiResponseRun).where(eq(aiResponseRun.id, runId))
  const [operation] = await tx
    .select({ output: aiOperation.output })
    .from(aiOperation)
    .where(eq(aiOperation.id, runId))
  const [current] = await tx
    .select({ snapshot: aiMemberConfig.publishedSnapshot })
    .from(aiMemberConfig)
    .where(eq(aiMemberConfig.memberId, run.memberId))
  return {
    ...reference,
    run,
    current: current?.snapshot,
    skillId: selectedAiSkillId(operation?.output),
  }
}
async function authorizedDefinition(
  tx: Tx,
  context: Awaited<ReturnType<typeof lockRun>>,
  id: string,
) {
  const reference = `external:${id}` as const
  if (
    !context.run.configSnapshot ||
    !context.current ||
    !instructionTools(
      aiSelectedSkillInstructions(context.run.configSnapshot, context.skillId),
    ).includes(reference) ||
    !instructionTools(aiSelectedSkillInstructions(context.current, context.skillId)).includes(
      reference,
    )
  )
    return null
  return (
    (await readAiExternalCatalog(tx, { ...context, memberId: context.run.memberId })).find(
      (row) => row.tool.id === id,
    ) ?? null
  )
}
export async function readAiRunExternalCatalog(db: Database, runId: string) {
  return db.transaction(async (tx) => {
    const context = await lockRun(tx, runId)
    return readAiExternalCatalog(tx, { ...context, memberId: context.run.memberId })
  })
}
export async function claimAiExternalAction(db: Database, input: ExternalActionInput) {
  return db.transaction(async (tx) => {
    const context = await lockRun(tx, input.runId)
    if (!Number.isInteger(input.ordinal) || input.ordinal < 0 || input.ordinal > 2)
      throw new AiResponseError('INVALID_REQUEST')
    validateAiToolCalls(
      context.run.configSnapshot
        ? aiSelectedSkillInstructions(context.run.configSnapshot, context.skillId)
        : '',
      [input.call],
    )
    const [existing] = await tx
      .select()
      .from(aiToolAction)
      .where(
        and(eq(aiToolAction.operationId, input.runId), eq(aiToolAction.ordinal, input.ordinal)),
      )
      .for('update')
    if (existing) {
      if (
        existing.tool !== `external:${input.call.arguments.definitionId}` ||
        JSON.stringify(existing.arguments) !== JSON.stringify(input.call.arguments.values)
      )
        throw new AiResponseError('INVALID_REQUEST')
      if (
        existing.state === 'RUNNING' &&
        Date.now() - (existing.startedAt?.getTime() ?? 0) > 15_000
      ) {
        const [unknown] = await tx
          .update(aiToolAction)
          .set({
            state: 'UNKNOWN',
            failureCode: 'EXTERNAL_RESULT_UNKNOWN',
            completedAt: new Date(),
          })
          .where(eq(aiToolAction.id, existing.id))
          .returning()
        await tx
          .update(aiResponseRun)
          .set({
            state: 'FAILED',
            failureCode: 'EXTERNAL_RESULT_UNKNOWN',
            completedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(and(eq(aiResponseRun.id, input.runId), eq(aiResponseRun.state, 'GENERATING')))
        await tx
          .update(aiOperation)
          .set({ state: 'UNKNOWN', failureCode: 'EXTERNAL_RESULT_UNKNOWN', updatedAt: new Date() })
          .where(
            and(
              eq(aiOperation.id, input.runId),
              inArray(aiOperation.state, ['RESERVED', 'STARTED']),
            ),
          )
        return { action: unknown, dispatch: null }
      }
      return { action: existing, dispatch: null }
    }
    const definition = await authorizedDefinition(tx, context, input.call.arguments.definitionId)
    const guard = await commitAiResponse(tx, {
      runId: input.runId,
      text: '',
      stopCheckOnly: true,
      handoffEvaluation: input.handoffEvaluation,
    })
    const allowed = definition && guard?.kind === 'CONTINUE'
    const [action] = await tx
      .insert(aiToolAction)
      .values({
        workspaceId: context.workspaceId,
        memberId: context.run.memberId,
        operationId: input.runId,
        runId: input.runId,
        ordinal: input.ordinal,
        tool: `external:${input.call.arguments.definitionId}`,
        definitionRevision: definition?.tool.revision ?? 1,
        arguments: input.call.arguments.values,
        state: allowed ? 'RUNNING' : 'CANCELLED',
        startedAt: new Date(),
        completedAt: allowed ? null : new Date(),
        failureCode: allowed ? null : 'TOOL_AUTHORIZATION_CHANGED',
      })
      .returning()
    return { action, dispatch: allowed ? definition : null }
  })
}

// Called after local request validation and immediately before dispatch. No credential is
// loaded by catalog, simulated tests, debug or model-prompt construction.
export async function readExternalDispatchCredential(
  db: Database,
  input: ExternalActionInput & { actionId: string },
) {
  return db.transaction(async (tx) => {
    const context = await lockRun(tx, input.runId)
    const [action] = await tx.select().from(aiToolAction).where(eq(aiToolAction.id, input.actionId))
    const definition = await authorizedDefinition(tx, context, input.call.arguments.definitionId)
    const guard = await commitAiResponse(tx, {
      runId: input.runId,
      text: '',
      stopCheckOnly: true,
      handoffEvaluation: input.handoffEvaluation,
    })
    if (
      !action ||
      action.runId !== input.runId ||
      action.state !== 'RUNNING' ||
      !definition ||
      action.definitionRevision !== definition.tool.revision ||
      guard?.kind !== 'CONTINUE'
    )
      return null
    const [credential] = await tx
      .select({
        ciphertext: aiExternalPlugin.encryptedCredential,
        iv: aiExternalPlugin.credentialIv,
        keyVersion: aiExternalPlugin.credentialKeyVersion,
      })
      .from(aiExternalPlugin)
      .where(eq(aiExternalPlugin.id, definition.pluginId))
    return {
      definition,
      credential:
        definition.auth === 'BEARER' &&
        credential.ciphertext &&
        credential.iv &&
        credential.keyVersion
          ? {
              ciphertext: credential.ciphertext,
              iv: credential.iv,
              keyVersion: credential.keyVersion,
            }
          : null,
    }
  })
}
export async function recordExternalActionReceipt(
  db: Database,
  input: {
    actionId: string
    state: 'SUCCEEDED' | 'FAILED' | 'UNKNOWN' | 'CANCELLED'
    result?: Record<string, unknown>
    failureCode?: string
  },
) {
  return db.transaction(async (tx) => {
    const [reference] = await tx
      .select({ workspaceId: aiToolAction.workspaceId })
      .from(aiToolAction)
      .where(eq(aiToolAction.id, input.actionId))
    if (!reference) throw new AiResponseError('INVALID_REQUEST')
    await tx.execute(
      sql`select id from ${workspace} where id = ${reference.workspaceId} for update`,
    )
    const [action] = await tx
      .select()
      .from(aiToolAction)
      .where(eq(aiToolAction.id, input.actionId))
      .for('update')
    if (!action || action.state === 'SUCCEEDED' || action.state === 'CANCELLED') return action
    const [saved] = await tx
      .update(aiToolAction)
      .set({
        state: input.state,
        result: input.result ?? null,
        failureCode: input.failureCode ?? null,
        completedAt: new Date(),
      })
      .where(eq(aiToolAction.id, action.id))
      .returning()
    if (input.state !== 'SUCCEEDED' && action.runId) {
      await tx
        .update(aiResponseRun)
        .set({
          state: input.state === 'CANCELLED' ? 'CANCELLED' : 'FAILED',
          failureCode: input.failureCode ?? 'EXTERNAL_RESULT_UNKNOWN',
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(eq(aiResponseRun.id, action.runId), eq(aiResponseRun.state, 'GENERATING')))
      await tx
        .update(aiOperation)
        .set({
          state: input.state === 'UNKNOWN' ? 'UNKNOWN' : 'FAILED',
          failureCode: input.failureCode ?? 'EXTERNAL_RESULT_UNKNOWN',
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(aiOperation.id, action.operationId),
            inArray(aiOperation.state, ['RESERVED', 'STARTED']),
          ),
        )
    }
    return saved
  })
}

export async function checkExternalActionResults(tx: Tx, runId: string, usedIds: string[] = []) {
  const actions = await tx
    .select()
    .from(aiToolAction)
    .where(and(eq(aiToolAction.runId, runId), sql`${aiToolAction.tool} like 'external:%'`))
  if (!actions.length) return usedIds.length === 0
  if (
    new Set(usedIds).size !== usedIds.length ||
    usedIds.some((id) => !actions.some((action) => action.id === id))
  )
    return false
  const context = await lockRun(tx, runId)
  for (const action of actions) {
    if (action.state !== 'SUCCEEDED') return false
    const current = await authorizedDefinition(tx, context, action.tool.slice('external:'.length))
    if (!current || current.tool.revision !== action.definitionRevision) return false
    if (
      !action.result ||
      Object.keys(action.result).length !== current.tool.output.length ||
      current.tool.output.some(
        (field) =>
          !validValue(action.result?.[field.name]) ||
          typeof action.result?.[field.name] !== field.type,
      )
    )
      return false
  }
  return true
}
export async function assertExternalToolReferences(
  db: Database | Tx,
  input: { workspaceId: string; memberId: string; actingUserId: string; instructions: string },
) {
  const refs = instructionTools(input.instructions).filter((id) => id.startsWith('external:'))
  if (!refs.length) return
  const catalog = await readAiExternalCatalog(db, input)
  if (refs.some((reference) => !catalog.some((row) => `external:${row.tool.id}` === reference)))
    throw new Error('External tool reference is unavailable')
}
export async function simulateExternalTestAction(
  db: Database,
  input: {
    workspaceId: string
    memberId: string
    actingUserId: string
    id: string
    ordinal: number
    call: ExternalCall
  },
) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select id from ${workspace} where id = ${input.workspaceId} for update`)
    const operation = await authorizeAiTestTool(tx, input)
    if (!operation || input.ordinal < 0 || input.ordinal > 2) return null
    const definition = (await readAiExternalCatalog(tx, input)).find(
      (row) => row.tool.id === input.call.arguments.definitionId,
    )
    if (!definition) return null
    const [existing] = await tx
      .select()
      .from(aiToolAction)
      .where(and(eq(aiToolAction.operationId, input.id), eq(aiToolAction.ordinal, input.ordinal)))
    if (existing)
      return existing.definitionRevision === definition.tool.revision &&
        existing.state === 'SUCCEEDED' &&
        existing.simulated
        ? existing
        : null
    // This branch has no credential columns, decryption or network callback.
    const result = Object.fromEntries(
      definition.tool.output.map((field) => [
        field.name,
        field.type === 'string' ? '沙箱示例' : field.type === 'number' ? 0 : false,
      ]),
    )
    const [action] = await tx
      .insert(aiToolAction)
      .values({
        workspaceId: input.workspaceId,
        memberId: input.memberId,
        operationId: input.id,
        ordinal: input.ordinal,
        tool: `external:${definition.tool.id}`,
        definitionRevision: definition.tool.revision,
        arguments: input.call.arguments.values,
        simulated: true,
        state: 'SUCCEEDED',
        result,
        startedAt: new Date(),
        completedAt: new Date(),
      })
      .returning()
    return action
  })
}
export async function checkExternalTestResults(
  tx: Tx,
  input: { workspaceId: string; memberId: string; actingUserId: string; id: string },
) {
  const catalog = await readAiExternalCatalog(tx, input)
  const actions = await tx
    .select()
    .from(aiToolAction)
    .where(and(eq(aiToolAction.operationId, input.id), sql`${aiToolAction.tool} like 'external:%'`))
  return (
    actions.length > 0 &&
    actions.every(
      (action) =>
        action.simulated &&
        action.state === 'SUCCEEDED' &&
        catalog.some(
          (row) =>
            action.tool === `external:${row.tool.id}` &&
            action.definitionRevision === row.tool.revision,
        ),
    )
  )
}
export async function readExternalResultsForReply(db: Database, runId: string) {
  return db.transaction(async (tx) => {
    await lockRun(tx, runId)
    if (!(await checkExternalActionResults(tx, runId))) return null
    return tx
      .select({ actionId: aiToolAction.id, values: aiToolAction.result })
      .from(aiToolAction)
      .where(
        and(
          eq(aiToolAction.runId, runId),
          sql`${aiToolAction.tool} like 'external:%'`,
          eq(aiToolAction.state, 'SUCCEEDED'),
        ),
      )
  })
}
