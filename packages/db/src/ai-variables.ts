export const AI_VARIABLES = [
  { key: 'customer.name', label: '联系人姓名', type: 'text' },
  { key: 'customer.email', label: '联系人邮箱', type: 'text' },
  { key: 'customer.phone', label: '联系人电话', type: 'text' },
  { key: 'customer.language', label: '联系人偏好语言', type: 'text' },
  { key: 'customer.properties', label: '客户级属性', type: 'properties' },
  { key: 'conversation.properties', label: '会话级属性', type: 'properties' },
  { key: 'customer.tags', label: '客户级标签', type: 'tags' },
  { key: 'conversation.tags', label: '会话级标签', type: 'tags' },
  { key: 'conversation.context', label: '当前授权上下文', type: 'text' },
  { key: 'conversation.replyCount', label: '已提交逻辑回复轮次', type: 'number' },
  { key: 'system.now', label: '服务端当前时间', type: 'text' },
  { key: 'system.timeZone', label: '配置时区', type: 'text' },
] as const

export type AiVariableKey = (typeof AI_VARIABLES)[number]['key']
export type AiVariableValue =
  | string
  | number
  | null
  | string[]
  | { name: string; value: string | number | null }[]
export type AiVariableInput = {
  version: 1
  capturedAt: string
  values: Partial<Record<AiVariableKey, AiVariableValue>>
  source?: {
    customerId: string
    channelIds: string[]
    profileRevision: number
    customerTagRevision: number
    conversationTagRevision: number
    properties: { id: string; revision: number; definitionRevision: number }[]
  }
}

export function instructionVariableKeys(instructions: string): AiVariableKey[] {
  const names = [...instructions.matchAll(/\{\{([^{}]*)\}\}/g)].map((match) => match[1])
  if (names.some((key) => !AI_VARIABLES.some((variable) => variable.key === key)))
    throw new Error('Unknown instruction variable')
  return [...new Set(names)] as AiVariableKey[]
}

export function validateAiVariableInput(input: AiVariableInput) {
  if (input.version !== 1 || !Number.isFinite(new Date(input.capturedAt).getTime()))
    throw new Error('Invalid variable snapshot')
  for (const [key, value] of Object.entries(input.values)) {
    const definition = AI_VARIABLES.find((variable) => variable.key === key)
    if (!definition) throw new Error('Unknown variable')
    if (value === null) continue
    if (
      definition.type === 'text'
        ? typeof value !== 'string'
        : definition.type === 'number'
          ? typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0
          : definition.type === 'tags'
            ? !Array.isArray(value) ||
              value.length > 50 ||
              value.some((item) => typeof item !== 'string')
            : !Array.isArray(value) ||
              value.length > 20 ||
              value.some(
                (item) =>
                  !item ||
                  typeof item !== 'object' ||
                  !('name' in item) ||
                  typeof item.name !== 'string' ||
                  !('value' in item) ||
                  (item.value !== null &&
                    typeof item.value !== 'string' &&
                    (typeof item.value !== 'number' || !Number.isFinite(item.value))),
              )
    )
      throw new Error('Invalid variable type')
  }
}
