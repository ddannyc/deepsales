import { z } from 'zod'

export const OPENAI_EMBEDDING_DIMENSIONS = 1_536

export interface AIClient {
  embed(input: string[]): Promise<number[][]>
}

export class AIProviderError extends Error {
  constructor(
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super('AI provider request failed')
  }
}

export class AIEmbeddingError extends Error {
  constructor() {
    super('AI provider returned an invalid embedding')
  }
}

export function createAIClient(
  config: {
    apiKey: string
    embeddingModel?: string
    baseUrl?: string
  },
  fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> = globalThis.fetch,
): AIClient {
  const baseUrl = config.baseUrl?.replace(/\/$/, '') ?? 'https://api.openai.com/v1'

  return {
    async embed(input) {
      if (!input.length) return []
      let response: Response
      try {
        response = await fetcher(`${baseUrl}/embeddings`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: config.embeddingModel ?? 'text-embedding-3-small',
            input,
            encoding_format: 'float',
          }),
        })
      } catch {
        throw new AIProviderError(0, true)
      }

      if (!response.ok) {
        throw new AIProviderError(
          response.status,
          response.status === 429 || response.status >= 500,
        )
      }

      const payload = await response.json().catch(() => null)
      const parsed = z
        .object({
          data: z.array(
            z.object({
              index: z.number().int().nonnegative(),
              embedding: z.array(z.number()),
            }),
          ),
        })
        .safeParse(payload)
      if (!parsed.success || parsed.data.data.length !== input.length) {
        throw new AIEmbeddingError()
      }

      const rows = [...parsed.data.data].sort((left, right) => left.index - right.index)
      if (rows.some((row, index) => row.index !== index)) throw new AIEmbeddingError()
      const embeddings = rows.map(({ embedding }) => embedding)
      if (
        embeddings.some(
          (embedding) =>
            embedding.length !== OPENAI_EMBEDDING_DIMENSIONS ||
            embedding.some((value) => !Number.isFinite(value)),
        )
      ) {
        throw new AIEmbeddingError()
      }
      return embeddings
    },
  }
}
