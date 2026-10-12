import {
  AiUsageError,
  beginAiProviderAttempt,
  type Database,
  finishAiProviderAttempt,
  getAiProviderResponse,
  reserveAiOperation,
} from '@deepsales/db'

// One logical charge includes retrieval and generation; embedding batches remain separate attempts.
export function meteredAiFetch(
  withDb: <T>(work: (db: Database) => Promise<T>) => Promise<T>,
  operation: Parameters<typeof reserveAiOperation>[1],
  llmStage: string = 'LLM',
) {
  let embeddingBatch = 0
  return async (url: RequestInfo | URL, init?: RequestInit) => {
    const stage = String(url).endsWith('/embeddings')
      ? `${llmStage.startsWith('BATCH:') ? `${llmStage}:` : ''}EMBEDDING:${embeddingBatch++}`
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
    const retryAfter = response.headers.get('retry-after')
    const seconds = Number(retryAfter)
    const retryAfterMs = retryAfter
      ? Number.isFinite(seconds)
        ? seconds * 1_000
        : Math.max(0, Date.parse(retryAfter) - Date.now())
      : 0
    await withDb((db) =>
      finishAiProviderAttempt(db, {
        attemptId: attempt.id,
        state: response.ok ? 'SUCCESS' : 'FAILED',
        httpStatus: response.status,
        response: response.ok ? payload : undefined,
        retryAfterMs: Number.isFinite(retryAfterMs) ? retryAfterMs : 0,
      }),
    )
    return response
  }
}
