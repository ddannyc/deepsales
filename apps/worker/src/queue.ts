export type JobQueue = {
  send(payload: unknown): Promise<void>
}

export function createJobQueue(queue: Queue): JobQueue {
  return {
    async send(payload) {
      await queue.send(payload)
    },
  }
}

// Wake periodically; PostgreSQL retains the full deadline and authorizes actual dispatch.
export function queueRetryDelay(delayMs: number) {
  return Number.isFinite(delayMs)
    ? Math.min(43_200, Math.max(1, Math.ceil(delayMs / 1_000)))
    : 43_200
}
