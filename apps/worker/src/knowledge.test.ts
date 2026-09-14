import { describe, expect, it, vi } from 'vitest'
import { chunkKnowledgeText, normalizeKnowledgeText } from '@deepsales/db'
import { AIEmbeddingError, createAIClient } from './ai'

describe('knowledge text processing', () => {
  it('normalizes line endings and control characters', () => {
    expect(normalizeKnowledgeText('  first\r\nsecond\u0000\n\n third  ')).toBe(
      'first\nsecond\n\n third',
    )
  })

  it('keeps paragraphs together and splits long Unicode text with overlap', () => {
    expect(chunkKnowledgeText('one\nline\n\ntwo')).toEqual(['one\nline\n\ntwo'])
    const chunks = chunkKnowledgeText('😀'.repeat(2_001))
    expect(chunks.map((chunk) => Array.from(chunk).length)).toEqual([2_000, 201])
    expect(Array.from(chunks[1] ?? '')[0]).toBe('😀')
  })
})

describe('OpenAI embeddings', () => {
  it('orders and validates the embedding batch', async () => {
    const vector = Array.from({ length: 1_536 }, (_, index) => index / 1_536)
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            { index: 1, embedding: vector },
            { index: 0, embedding: vector },
          ],
        }),
        { status: 200 },
      ),
    )
    const result = await createAIClient(
      { apiKey: 'test-key', embeddingModel: 'test-model', baseUrl: 'http://ai.test/v1' },
      fetcher,
    ).embed(['first', 'second'])

    expect(result).toHaveLength(2)
    expect(fetcher).toHaveBeenCalledWith(
      'http://ai.test/v1/embeddings',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('rejects a provider dimension mismatch', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ data: [{ index: 0, embedding: [1] }] }), { status: 200 }),
      )
    await expect(
      createAIClient({ apiKey: 'test-key' }, fetcher).embed(['text']),
    ).rejects.toBeInstanceOf(AIEmbeddingError)
  })
})
