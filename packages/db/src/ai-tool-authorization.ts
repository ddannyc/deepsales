import { readAiFollowUpAuthorization } from './ai-follow-ups'
import { aiSelectedSkillInstructions } from './ai-skills'
import { aiToolInstructions } from './ai-tools'
import type { Database } from './database'
import type { AiMemberRuntimeSnapshot } from './schema'

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0]

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
