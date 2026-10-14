import { describe, expect, it } from 'vitest'
import { AlibabaLlmProvider } from './ai'

describe('authorized built-in tool output', () => {
  it('accepts only explicitly authorized typed tools and never arbitrary targets or URLs', async () => {
    let toolCalls: unknown = [
      { tool: 'record', arguments: { text: 'Customer prefers a short explanation.' } },
    ]
    const provider = new AlibabaLlmProvider(
      { apiKey: 'test', baseUrl: 'http://ai.test' },
      async () =>
        Response.json({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  decision: 'ANSWER',
                  response: 'Thank you.',
                  handoffReason: null,
                  containsBusinessFacts: false,
                  usedChunkIds: [],
                  toolCalls,
                }),
              },
            },
          ],
        }),
    )
    const input = {
      instructions: '[[tool:record]] [[tool:skip]]',
      responseLanguage: 'English',
      messages: [],
      history: [],
      knowledgeChunks: [],
    }
    expect(await provider.generateResponse(input)).toMatchObject({ toolCalls })
    for (const calls of [
      [{ tool: 'handoff', arguments: { assigneeMemberId: crypto.randomUUID() } }],
      [{ tool: 'send_media', arguments: { url: 'https://example.com/file' } }],
      Array.from({ length: 4 }, () => ({ tool: 'record', arguments: { text: 'One' } })),
      [
        { tool: 'skip', arguments: {} },
        { tool: 'record', arguments: { text: 'Later' } },
      ],
    ]) {
      toolCalls = calls
      await expect(provider.generateResponse(input)).rejects.toThrow()
    }
  })
})
