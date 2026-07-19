type Listener = (event: unknown) => void

const listeners = new Map<string, Set<Listener>>()

function channelKey(userId: string, channel: string): string {
  return `${userId}:${channel}`
}

export function subscribeProgress(userId: string, channel: string, listener: Listener): () => void {
  const key = channelKey(userId, channel)
  const set = listeners.get(key) ?? new Set<Listener>()
  set.add(listener)
  listeners.set(key, set)
  return () => {
    set.delete(listener)
    if (set.size === 0) listeners.delete(key)
  }
}

export function emitProgress(userId: string, channel: string, event: unknown): void {
  const set = listeners.get(channelKey(userId, channel))
  if (!set) return
  for (const listener of set) listener(event)
}

export const PROGRESS_CHANNELS = {
  assistant: 'assistant',
  referenceImport: 'reference-import',
  spiral: 'spiral',
  backfillState: 'backfill-state',
} as const
