export function prependFrozenPhase(
  frozenPrefix: string | undefined,
  phase: string,
  body: string,
): string {
  const frozen = String(frozenPrefix ?? '').trim()
  const trimmedBody = body.trim()
  if (!frozen) return trimmedBody
  return `${frozen}\n\n【阶段】${phase}\n\n${trimmedBody}`
}
