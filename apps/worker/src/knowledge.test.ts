import { describe, expect, it, vi } from 'vitest'
import { chunkKnowledgeText, normalizeKnowledgeText } from '@deepsales/db'
import { AIEmbeddingError, AlibabaEmbeddingProvider } from './ai'

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

describe('Alibaba embeddings', () => {
  it('constructs the request and preserves batch order', async () => {
    const vector = (value: number) =>
      Array.from({ length: 1_536 }, (_item, index) => (index === 0 ? value : 0))
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            { index: 1, embedding: vector(2) },
            { index: 0, embedding: vector(1) },
          ],
        }),
        { status: 200 },
      ),
    )
    const result = await new AlibabaEmbeddingProvider(
      { apiKey: 'test-key', baseUrl: 'http://ai.test/v1' },
      fetcher,
    ).embed(['first', 'second'])

    expect(result).toHaveLength(2)
    expect(result.map((embedding) => embedding[0])).toEqual([1, 2])
    expect(fetcher).toHaveBeenCalledWith(
      'http://ai.test/v1/embeddings',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer test-key' }),
        body: JSON.stringify({
          model: 'qwen3.7-text-embedding',
          input: ['first', 'second'],
          dimensions: 1_536,
          encoding_format: 'float',
        }),
      }),
    )
  })

  it('splits large ingestion batches without changing result order', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as { input: string[] }
      return Response.json({
        data: body.input.map((value, index) => ({
          index,
          embedding: Array.from({ length: 1_536 }, (_item, position) =>
            position === 0 ? Number(value.slice(5)) : 0,
          ),
        })),
      })
    })

    const result = await new AlibabaEmbeddingProvider(
      { apiKey: 'test-key', baseUrl: 'http://ai.test/v1' },
      fetcher,
    ).embed(Array.from({ length: 21 }, (_, index) => `item-${index}`))

    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(result.map((embedding) => embedding[0])).toEqual(Array.from({ length: 21 }, (_, i) => i))
  })

  it('rejects a provider dimension mismatch', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ data: [{ index: 0, embedding: [1] }] }), { status: 200 }),
      )
    await expect(
      new AlibabaEmbeddingProvider(
        { apiKey: 'test-key', baseUrl: 'http://ai.test/v1' },
        fetcher,
      ).embed(['text']),
    ).rejects.toBeInstanceOf(AIEmbeddingError)
  })

  it('rejects a partial embedding response', async () => {
    const vector = Array.from({ length: 1_536 }, () => 0)
    const fetcher = vi
      .fn()
      .mockResolvedValue(Response.json({ data: [{ index: 0, embedding: vector }] }))

    await expect(
      new AlibabaEmbeddingProvider(
        { apiKey: 'test-key', baseUrl: 'http://ai.test/v1' },
        fetcher,
      ).embed(['first', 'second']),
    ).rejects.toBeInstanceOf(AIEmbeddingError)
  })
})
