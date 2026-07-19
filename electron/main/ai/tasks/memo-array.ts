/** STREAM_REPAIR 有时返回扁平 memo 字段（无 memo 外壳），与标准 {"memo":{...}} 统一解包 */
export function unwrapChapterMemoPayload(parsed: unknown): Record<string, unknown> {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const root = parsed as Record<string, unknown>
  const nested = root.memo
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    const nestedRecord = nested as Record<string, unknown>
    if (String(nestedRecord.currentTask ?? '').trim()) {
      return nestedRecord
    }
  }
  if (String(root.currentTask ?? '').trim()) {
    return root
  }
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    return nested as Record<string, unknown>
  }
  return {}
}

/** 将备忘 JSON 中的数组项规范为可读字符串（避免 [object Object]） */
export function coerceMemoStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map(coerceMemoStringEntry).filter(Boolean)
}

function coerceMemoStringEntry(value: unknown): string {
  if (typeof value === 'string') {
    const text = value.trim()
    return text === '[object Object]' ? '' : text
  }
  if (value && typeof value === 'object') {
    const item = value as Record<string, unknown>
    const type = String(item.type ?? item.changeType ?? '').trim()
    const desc = String(item.description ?? item.change ?? item.text ?? item.content ?? '').trim()
    const combined = [type, desc].filter(Boolean).join('：')
    return combined.trim()
  }
  const text = String(value ?? '').trim()
  return text === '[object Object]' ? '' : text
}
