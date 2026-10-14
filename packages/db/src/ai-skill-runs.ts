import { and, eq, sql } from 'drizzle-orm'
import { AiMemberError, getAiMemberConfig } from './ai-members'
import { commitAiResponse } from './ai-responses'
import { type AiSkillSelection, firstMatchingAiSkill } from './ai-skills'
import type { Database } from './database'
import { aiOperation, aiResponseRun, aiTestSession, conversation, workspace } from './schema'

export async function recordAiSkillSelection(
  db: Database,
  input: {
    workspaceId: string
    memberId: string
    operationId: string
    matchedSkillIds: string[]
    actingUserId?: string
    handoffEvaluation?: Parameters<typeof commitAiResponse>[1]['handoffEvaluation']
  },
) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select id from ${workspace} where id = ${input.workspaceId} for update`)
    const [operation] = await tx
      .select()
      .from(aiOperation)
      .where(
        and(
          eq(aiOperation.id, input.operationId),
          eq(aiOperation.workspaceId, input.workspaceId),
          eq(aiOperation.memberId, input.memberId),
        ),
      )
    if (!operation || !['RESERVED', 'STARTED'].includes(operation.state))
      return { kind: 'BLOCKED' as const, guard: null }
    let snapshot = operation.snapshot
    if (operation.kind === 'TEST') {
      if (!input.actingUserId) throw new AiMemberError('FORBIDDEN')
      await getAiMemberConfig(tx, { ...input, actingUserId: input.actingUserId })
      const context = (
        operation.output as { testContext?: { sessionId: string; generation: number } } | null
      )?.testContext
      if (context) {
        const [session] = await tx
          .select()
          .from(aiTestSession)
          .where(
            and(
              eq(aiTestSession.id, context.sessionId),
              eq(aiTestSession.workspaceId, input.workspaceId),
              eq(aiTestSession.memberId, input.memberId),
              eq(aiTestSession.userId, input.actingUserId),
            ),
          )
          .for('update')
        if (
          !session ||
          session.generation !== context.generation ||
          !session.operationIds.includes(operation.id)
        )
          return { kind: 'BLOCKED' as const, guard: null }
      }
    } else if (['LIVE_REPLY', 'FOLLOW_UP'].includes(operation.kind)) {
      const guard = await commitAiResponse(tx, {
        runId: operation.id,
        text: '',
        stopCheckOnly: true,
        handoffEvaluation: input.handoffEvaluation,
      })
      if (guard?.kind !== 'CONTINUE') return { kind: 'BLOCKED' as const, guard }
      const [run] = await tx
        .select({ snapshot: aiResponseRun.configSnapshot })
        .from(aiResponseRun)
        .innerJoin(conversation, eq(conversation.id, aiResponseRun.conversationId))
        .where(
          and(
            eq(aiResponseRun.id, operation.id),
            eq(aiResponseRun.memberId, input.memberId),
            eq(conversation.workspaceId, input.workspaceId),
          ),
        )
      snapshot = run?.snapshot ?? null
    } else throw new AiMemberError('INVALID_REQUEST')
    if (!snapshot) throw new AiMemberError('INVALID_CONFIGURATION')
    const output = operation.output as { skillSelection?: AiSkillSelection } | null
    if (output?.skillSelection)
      return { kind: 'SELECTED' as const, selection: output.skillSelection }
    let skill: ReturnType<typeof firstMatchingAiSkill>
    try {
      skill = firstMatchingAiSkill(snapshot.skills ?? [], input.matchedSkillIds)
    } catch {
      throw new AiMemberError('INVALID_REQUEST')
    }
    const selection: AiSkillSelection = {
      id: skill?.id ?? null,
      name: skill?.name ?? null,
      configVersionId: operation.configVersionId,
    }
    await tx
      .update(aiOperation)
      .set({
        output: { ...((operation.output as object) ?? {}), skillSelection: selection },
        updatedAt: new Date(),
      })
      .where(eq(aiOperation.id, operation.id))
    return { kind: 'SELECTED' as const, selection }
  })
}
