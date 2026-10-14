import { instructionTools } from './ai-tools'
import { instructionVariableKeys } from './ai-variables'
import type { AiMemberRuntimeSnapshot } from './schema'

export type AiSkill = { id: string; name: string; condition: string; instructions: string }
export type AiSkillSelection = {
  id: string | null
  name: string | null
  configVersionId: string | null
}

export function firstMatchingAiSkill(skills: AiSkill[], ids: string[]) {
  if (
    !Array.isArray(ids) ||
    ids.length > skills.length ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => !skills.some((skill) => skill.id === id))
  )
    throw new Error('Invalid matched skills')
  return skills.find((skill) => ids.includes(skill.id)) ?? null
}

export function selectedAiSkillId(output: unknown) {
  const selection = (output as { skillSelection?: AiSkillSelection } | null)?.skillSelection
  return typeof selection?.id === 'string' ? selection.id : null
}

export function aiSkillVariableInstructions(
  snapshot: Pick<AiMemberRuntimeSnapshot, 'instructions' | 'skills'>,
) {
  return [
    snapshot.instructions,
    ...(snapshot.skills ?? []).flatMap((skill) => [skill.condition, skill.instructions]),
  ].join('\n')
}

export function aiSelectedSkillInstructions(
  snapshot: Pick<AiMemberRuntimeSnapshot, 'instructions' | 'skills'>,
  id?: string | null,
) {
  return [
    snapshot.instructions,
    snapshot.skills?.find((skill) => skill.id === id)?.instructions ?? '',
  ]
    .filter(Boolean)
    .join('\n')
}

export function normalizeAiSkills(value: AiSkill[]): AiSkill[] {
  if (!Array.isArray(value) || value.length > 20) throw new Error('Invalid skills')
  const skills = value.map((item) => {
    if (
      !item ||
      Object.keys(item).some((key) => !['id', 'name', 'condition', 'instructions'].includes(key)) ||
      typeof item.id !== 'string' ||
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(item.id)
    )
      throw new Error('Invalid skill')
    for (const [key, limit] of [
      ['name', 100],
      ['condition', 2000],
      ['instructions', 8000],
    ] as const)
      if (
        typeof item[key] !== 'string' ||
        !item[key].trim() ||
        Array.from(item[key].trim()).length > limit
      )
        throw new Error('Invalid skill text')
    instructionVariableKeys(item.condition)
    instructionVariableKeys(item.instructions)
    instructionTools(item.instructions)
    return {
      id: item.id,
      name: item.name.trim(),
      condition: item.condition.trim(),
      instructions: item.instructions.trim(),
    }
  })
  if (
    new Set(skills.map((skill) => skill.id)).size !== skills.length ||
    skills.reduce(
      (size, skill) => size + Array.from(skill.condition + skill.instructions).length,
      0,
    ) > 20000
  )
    throw new Error('Invalid skill list')
  return skills
}
