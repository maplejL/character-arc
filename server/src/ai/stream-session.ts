type StreamEvent = Record<string, unknown>

export type StreamSession = {
  userId: string
  streamId: string
  controller: AbortController
  buffer: StreamEvent[]
  subscribers: Set<(event: StreamEvent) => void>
  closed: boolean
}

const sessions = new Map<string, StreamSession>()

export function createStreamSession(userId: string, streamId: string): StreamSession {
  const session: StreamSession = {
    userId,
    streamId,
    controller: new AbortController(),
    buffer: [],
    subscribers: new Set(),
    closed: false,
  }
  sessions.set(streamId, session)
  return session
}

export function getStreamSession(streamId: string): StreamSession | undefined {
  return sessions.get(streamId)
}

export function emitStreamEvent(streamId: string, event: StreamEvent): void {
  const session = sessions.get(streamId)
  if (!session || session.closed) return
  const payload = { streamId, ...event }
  if (session.subscribers.size === 0) {
    session.buffer.push(payload)
    return
  }
  for (const subscriber of session.subscribers) {
    subscriber(payload)
  }
}

export function subscribeStreamEvents(
  streamId: string,
  userId: string,
  onEvent: (event: StreamEvent) => void,
): () => void {
  const session = sessions.get(streamId)
  if (!session || session.userId !== userId) {
    throw Object.assign(new Error('流不存在或无权访问'), { statusCode: 404, code: 'stream_not_found' })
  }

  for (const buffered of session.buffer) {
    onEvent(buffered)
  }
  session.buffer.length = 0
  session.subscribers.add(onEvent)

  return () => {
    session.subscribers.delete(onEvent)
  }
}

export function closeStreamSession(streamId: string): void {
  const session = sessions.get(streamId)
  if (!session) return
  session.closed = true
  session.subscribers.clear()
  sessions.delete(streamId)
}

export function stopStreamSession(streamId: string, userId: string): boolean {
  const session = sessions.get(streamId)
  if (!session || session.userId !== userId) return false
  session.controller.abort()
  emitStreamEvent(streamId, { type: 'canceled', content: '' })
  closeStreamSession(streamId)
  return true
}
