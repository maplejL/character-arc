type AutoCreationSocket = {
  readyState: number
  send: (data: string) => void
}

export type AutoCreationWsEvent =
  | { type: 'run-status'; runId: string; status: string; pauseReason?: string; message?: string }
  | { type: 'chapter-start'; runId: string; chapterId: string; index: number; total: number }
  | { type: 'step-progress'; runId: string; chapterId: string; step: string; message?: string }
  | {
      type: 'chapter-complete'
      runId: string
      chapterId: string
      skipped?: boolean
      auditPass?: boolean
      finalGatePass?: boolean
      acceptanceRecorded?: boolean
    }
  | { type: 'run-complete'; runId: string; completedCount: number; skippedCount: number }
  | { type: 'run-error'; runId: string; chapterId?: string; code: string; message: string }
  | { type: 'run-warning'; runId: string; chapterId?: string; code: string; message: string }

type Client = {
  userId: string
  socket: AutoCreationSocket
  runIds: Set<string>
}

const clients = new Set<Client>()

export function registerAutoCreationClient(userId: string, socket: AutoCreationSocket): () => void {
  const client: Client = { userId, socket, runIds: new Set() }
  clients.add(client)
  return () => {
    clients.delete(client)
  }
}

export function subscribeAutoCreationRun(userId: string, socket: AutoCreationSocket, runId: string): void {
  for (const client of clients) {
    if (client.userId === userId && client.socket === socket) {
      client.runIds.add(runId)
      return
    }
  }
}

export function broadcastAutoCreationEvent(userId: string, runId: string, event: AutoCreationWsEvent): void {
  const payload = JSON.stringify(event)
  for (const client of clients) {
    if (client.userId !== userId) continue
    if (!client.runIds.has(runId) && event.type !== 'run-status') continue
    if (client.socket.readyState === 1) {
      client.socket.send(payload)
    }
  }
}
