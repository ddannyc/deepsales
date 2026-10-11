import { describe, expect, it } from 'vitest'
import { buildAiPrompt } from './ai'

describe('published natural reply style', () => {
  const input = {
    instructions: 'Use support facts.',
    responseLanguage: 'English',
    messages: [{ id: 'input', text: 'Hello' }],
    history: [],
    knowledgeChunks: [],
  }
  it('adds conversational style only when enabled, while preserving AI identity and grounding', () => {
    const enabled = buildAiPrompt({ ...input, naturalToneEnabled: true })
    expect(enabled[0].content).toContain('Use a natural, conversational tone')
    expect(enabled[0].content).toContain('Keep your AI identity; never pretend to be human')
    expect(enabled[0].content).toContain('supported by the supplied knowledge chunks')
    expect(buildAiPrompt(input)[0].content).not.toContain('Use a natural, conversational tone')
  })
})
