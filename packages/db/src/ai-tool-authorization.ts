import { readAiFollowUpAuthorization } from './ai-follow-ups'
import { aiSelectedSkillInstructions } from './ai-skills'
import { aiToolInstructions } from './ai-tools'
import type { Database } from './database'
import type { AiMemberRuntimeSnapshot } from './schema'
import { aiToolAction } from './schema'
import { and, eq, sql } from 'drizzle-orm'

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0]

// Callers hold the workspace lock; a slot is reserved before any possible I/O.
export async function readAiToolSlotCount(tx: Tx, runId: string) {
  const [count] = await tx
    .select({ value: sql<number>`coalesce(sum(${aiToolAction.attemptCount}), 0)::integer` })
    .from(aiToolAction)
    .where(and(eq(aiToolAction.runId, runId), eq(aiToolAction.simulated, false)))
  return count.value
}

// The event's frozen revision must still be eligible before its independent
// requirements grant tools. Raw model/customer text never enters this boundary.
export async function readAiRunToolInstructions(
  tx: Tx,
  runId: string,
  frozen: AiMemberRuntimeSnapshot | null,
  current: AiMemberRuntimeSnapshot | null,
  skillId: string | null,
) {
  if (!frozen || !current) return null
  const proactive = await readAiFollowUpAuthorization(tx, runId, new Date())
  if (!proactive.valid) return null
  return {
    frozen: aiToolInstructions(
      aiSelectedSkillInstructions(frozen, skillId),
      proactive.followUp?.instructions,
    ),
    current: aiToolInstructions(
      aiSelectedSkillInstructions(current, skillId),
      proactive.followUp?.instructions,
    ),
  }
}
