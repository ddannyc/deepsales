import { z } from 'zod'

export const realtimeEventSchema = z.object({
  type: z.enum(['conversation.changed', 'message.changed', 'member.changed', 'knowledge.changed']),
  entityId: z.string().min(1).max(200),
})

export type RealtimeEvent = z.infer<typeof realtimeEventSchema>

export async function publishRealtime(
  namespace: DurableObjectNamespace | undefined,
  workspaceId: string,
  event: RealtimeEvent,
) {
  if (!namespace) return
  const stub = namespace.get(namespace.idFromName(workspaceId))
  const response = await stub.fetch('https://realtime/publish', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-realtime-publish': '1' },
    body: JSON.stringify(event),
  })
  if (!response.ok) throw new Error('Realtime publish failed')
}

export class WorkspaceRealtime {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request) {
    if (request.method === 'POST' && new URL(request.url).pathname === '/publish') {
      if (request.headers.get('x-realtime-publish') !== '1') {
        return new Response('Forbidden', { status: 403 })
      }
      const event = realtimeEventSchema.safeParse(await request.json().catch(() => null))
      if (!event.success) return new Response('Bad Request', { status: 400 })
      this.broadcast(event.data)
      return Response.json({ ok: true })
    }

    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('WebSocket upgrade required', { status: 426 })
    }
    if (!request.headers.get('x-user-id') || !request.headers.get('x-workspace-id')) {
      return new Response('Forbidden', { status: 403 })
    }

    const pair = new WebSocketPair()
    this.state.acceptWebSocket(pair[1], [
      `user:${request.headers.get('x-user-id')}`,
      `workspace:${request.headers.get('x-workspace-id')}`,
    ])
    return new Response(null, { status: 101, webSocket: pair[0] })
  }

  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
    if (message === 'ping') socket.send('pong')
  }

  webSocketClose() {}

  webSocketError() {}

  private broadcast(event: RealtimeEvent) {
    const payload = JSON.stringify(event)
    for (const socket of this.state.getWebSockets()) {
      try {
        socket.send(payload)
      } catch {
        socket.close()
      }
    }
  }
}
