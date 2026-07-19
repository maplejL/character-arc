export type CacheUsageSnapshot = {
  promptTokens?: number
  cachedInputTokens?: number
  promptCacheMissTokens?: number
}

export function derivePromptCacheMissTokens(usage?: CacheUsageSnapshot): number | undefined {
  if (!usage) return undefined
  if (typeof usage.promptCacheMissTokens === 'number' && Number.isFinite(usage.promptCacheMissTokens)) {
    return usage.promptCacheMissTokens
  }
  const input = usage.promptTokens
  const hit = usage.cachedInputTokens
  if (typeof input === 'number' && typeof hit === 'number' && Number.isFinite(input) && Number.isFinite(hit)) {
    return Math.max(0, input - hit)
  }
  return undefined
}

export function formatCacheUsageLine(usage?: CacheUsageSnapshot): string {
  if (!usage) return ''
  const hit = usage.cachedInputTokens ?? 0
  const input = usage.promptTokens ?? 0
  const miss = derivePromptCacheMissTokens(usage) ?? 0
  const rate = input > 0 ? ((hit / input) * 100).toFixed(1) : '0.0'
  return `cache_hit=${hit} cache_miss=${miss} prompt_tokens=${input} hit_rate=${rate}%`
}
