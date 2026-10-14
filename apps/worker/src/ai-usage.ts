import {
  AiUsageError,
  aiRetryDeadline,
  beginAiProviderAttempt,
  type Database,
  finishAiProviderAttempt,
  getAiProviderResponse,
  reserveAiOperation,
} from '@deepsales/db'

export function parseAiRetryAfter(value: string | null, now = new Date()) {
  if (value === null) return 0
  const text = value.trim()
  let delayMs: number
  if (/^\d+$/.test(text)) delayMs = Number(text) * 1000
  else {
    const timestamp = Date.parse(text)
    if (!Number.isFinite(timestamp) || new Date(timestamp).toUTCString() !== text) return null
    delayMs = Math.max(0, timestamp - now.getTime())
  }
  return aiRetryDeadline(delayMs, now) ? delayMs : null
}

// One logical charge includes retrieval and generation; embedding batches remain separate attempts.
export function meteredAiFetch(
  withDb: <T>(work: (db: Database) => Promise<T>) => Promise<T>,
  operation: Parameters<typeof reserveAiOperation>[1],
  llmStage: string = 'LLM',
) {
  let embeddingBatch = 0
  return async (url: RequestInfo | URL, init?: RequestInit) => {
    const stage = String(url).endsWith('/embeddings')
      ? `${llmStage === 'LLM' ? '' : `${llmStage}:`}EMBEDDING:${embeddingBatch++}`
      : llmStage
    await withDb((db) => reserveAiOperation(db, operation))
    const cached = await withDb((db) => getAiProviderResponse(db, operation.id, stage))
    if (cached) return Response.json(cached.response)
    const attempt = await withDb((db) =>
      beginAiProviderAttempt(db, { operationId: operation.id, stage }),
    )
    let response: Response
    try {
      response = await globalThis.fetch(url, init)
    } catch {
      await withDb((db) => finishAiProviderAttempt(db, { attemptId: attempt.id, state: 'UNKNOWN' }))
      throw new AiUsageError('OPERATION_PAUSED')
    }
    const payload: unknown = await response
      .clone()
      .json()
      .catch(() => null)
    const retryAfterMs = response.ok ? 0 : parseAiRetryAfter(response.headers.get('retry-after'))
    await withDb((db) =>
      finishAiProviderAttempt(db, {
        attemptId: attempt.id,
        state: response.ok ? 'SUCCESS' : 'FAILED',
        httpStatus: response.status,
        response: response.ok ? payload : undefined,
        retryAfterMs: retryAfterMs ?? NaN,
      }),
    )
    if (retryAfterMs === null) throw new AiUsageError('INVALID_RETRY_AFTER')
    return response
  }
}
