import { z } from 'zod'

export const ALIBABA_EMBEDDING_PROVIDER = 'alibaba'
export const DEFAULT_EMBEDDING_MODEL = 'qwen3.7-text-embedding'
export const EMBEDDING_DIMENSIONS = 1_536
const ALIBABA_MAX_BATCH_SIZE = 20

export type EmbeddingMetadata = {
  provider: string
  model: string
  dimensions: number
}

export interface EmbeddingProvider {
  readonly metadata: EmbeddingMetadata
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

export function createAlibabaEmbeddingProvider(
  config: {
    provider?: string
    apiKey?: string
    baseUrl?: string
    model?: string
    dimensions?: string | number
  },
  fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> = (input, init) =>
    globalThis.fetch(input, init),
): EmbeddingProvider {
  if (!config.apiKey?.trim() || !config.baseUrl?.trim()) throw new AIProviderError(0, true)
  if ((config.provider ?? ALIBABA_EMBEDDING_PROVIDER) !== ALIBABA_EMBEDDING_PROVIDER) {
    throw new AIEmbeddingError()
  }

  const model = config.model ?? DEFAULT_EMBEDDING_MODEL
  if (model !== DEFAULT_EMBEDDING_MODEL) throw new AIEmbeddingError()
  const dimensions = Number(config.dimensions ?? EMBEDDING_DIMENSIONS)
  if (dimensions !== EMBEDDING_DIMENSIONS) throw new AIEmbeddingError()

  return new AlibabaEmbeddingProvider(
    {
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      model,
      dimensions,
    },
    fetcher,
  )
}

export class AlibabaEmbeddingProvider implements EmbeddingProvider {
  readonly metadata: EmbeddingMetadata

  private readonly apiKey: string
  private readonly baseUrl: string
  private readonly fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

  constructor(
    config: {
      apiKey: string
      baseUrl: string
      model?: string
      dimensions?: number
    },
    fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> = (input, init) =>
      globalThis.fetch(input, init),
  ) {
    const model = config.model ?? DEFAULT_EMBEDDING_MODEL
    if (model !== DEFAULT_EMBEDDING_MODEL) throw new AIEmbeddingError()
    const dimensions = config.dimensions ?? EMBEDDING_DIMENSIONS
    if (!Number.isInteger(dimensions) || dimensions !== EMBEDDING_DIMENSIONS) {
      throw new AIEmbeddingError()
    }
    this.apiKey = config.apiKey
    this.baseUrl = config.baseUrl.replace(/\/+$/, '')
    this.fetcher = fetcher
    this.metadata = {
      provider: ALIBABA_EMBEDDING_PROVIDER,
      model,
      dimensions,
    }
  }

  async embed(input: string[]) {
    const embeddings: number[][] = []
    for (let offset = 0; offset < input.length; offset += ALIBABA_MAX_BATCH_SIZE) {
      embeddings.push(
        ...(await this.embedBatch(input.slice(offset, offset + ALIBABA_MAX_BATCH_SIZE))),
      )
    }
    return embeddings
  }

  private async embedBatch(input: string[]) {
    let response: Response
    try {
      response = await this.fetcher(`${this.baseUrl}/embeddings`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.metadata.model,
          input,
          dimensions: this.metadata.dimensions,
          encoding_format: 'float',
        }),
      })
    } catch {
      throw new AIProviderError(0, true)
    }

    if (!response.ok) {
      throw new AIProviderError(response.status, response.status === 429 || response.status >= 500)
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
          embedding.length !== this.metadata.dimensions ||
          embedding.some((value) => !Number.isFinite(value)),
      )
    ) {
      throw new AIEmbeddingError()
    }
    return embeddings
  }
}
