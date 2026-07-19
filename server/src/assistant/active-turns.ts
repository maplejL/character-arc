const activeTurns = new Map<string, AbortController>()

export function setActiveTurn(turnId: string, controller: AbortController): void {
  activeTurns.set(turnId, controller)
}

export function takeActiveTurn(turnId: string): AbortController | undefined {
  const controller = activeTurns.get(turnId)
  activeTurns.delete(turnId)
  return controller
}

export function cancelActiveTurn(turnId: string): boolean {
  const controller = activeTurns.get(turnId)
  if (!controller) return false
  controller.abort()
  activeTurns.delete(turnId)
  return true
}
