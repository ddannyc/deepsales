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
