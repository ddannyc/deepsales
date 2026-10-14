export const BUILTIN_AI_TOOLS = [
  { id: 'handoff', label: '转人工', description: '通过现有分配边界转人工，不接受目标成员 ID。' },
  {
    id: 'record',
    label: '记录内部备注',
    description: '记录内部信息，保留 AI 来源；不外发，不作为公司知识。',
  },
  { id: 'skip', label: '单轮跳过', description: '仅跳过当前输入；不关闭会话，不改变所有权。' },
  { id: 'search', label: '检索知识', description: '仅检索配置的知识库。' },
  {
    id: 'send_media',
    label: '发送私有素材',
    description: '仅发送授权知识引用的已有私有素材 ID，不接受 URL。',
  },
] as const
export type BuiltinAiTool = (typeof BUILTIN_AI_TOOLS)[number]['id']
export type AiToolCall =
  | { tool: 'handoff'; arguments: Record<string, never> }
  | { tool: 'skip'; arguments: Record<string, never> }
  | { tool: 'record'; arguments: { text: string } }
  | { tool: 'search'; arguments: { query: string } }
  | { tool: 'send_media'; arguments: { assetId: string } }

export function instructionTools(instructions: string): BuiltinAiTool[] {
  const ids = [...instructions.matchAll(/\[\[tool:([^\]]+)\]\]/g)].map((match) => match[1])
  if (ids.some((id) => !BUILTIN_AI_TOOLS.some((tool) => tool.id === id)))
    throw new Error('Unknown tool reference')
  return [...new Set(ids)] as BuiltinAiTool[]
}
export function validateAiToolCalls(instructions: string, calls: AiToolCall[]) {
  const allowed = instructionTools(instructions)
  if (calls.length > 3 || calls.some((call) => !allowed.includes(call.tool)))
    throw new Error('Unauthorized tool')
  if (
    calls.some(
      (call, index) =>
        ['handoff', 'skip', 'send_media'].includes(call.tool) && index !== calls.length - 1,
    )
  )
    throw new Error('Terminal tool must be last')
}
