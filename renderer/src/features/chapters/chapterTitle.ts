/** 从大纲节点标题提取可读副标题，如「破壳前中期⑨｜总装前夜」→「总装前夜」 */
export function extractChapterSubtitle(outlineTitle: string): string {
  const trimmed = outlineTitle.trim()
  if (!trimmed) return '未命名章节'
  const segments = trimmed.split(/[｜|]/).map((part) => part.trim()).filter(Boolean)
  if (segments.length >= 2) return segments[segments.length - 1]!
  return trimmed
}

export function parseChapterPartSuffix(title: string): {
  base: string
  partIndex?: number
  totalParts?: number
} {
  const trimmed = title.trim()
  const ratioMatch = trimmed.match(/（\s*(\d+)\s*\/\s*(\d+)\s*）\s*$/)
  if (ratioMatch?.index !== undefined) {
    const partIndex = Number.parseInt(ratioMatch[1]!, 10) - 1
    const totalParts = Number.parseInt(ratioMatch[2]!, 10)
    return {
      base: trimmed.slice(0, ratioMatch.index).trim(),
      partIndex: Number.isFinite(partIndex) ? Math.max(0, partIndex) : undefined,
      totalParts: Number.isFinite(totalParts) ? Math.max(1, totalParts) : undefined
    }
  }
  const singleMatch = trimmed.match(/（\s*(\d+)\s*）\s*$/)
  if (singleMatch?.index !== undefined) {
    const partIndex = Number.parseInt(singleMatch[1]!, 10) - 1
    return {
      base: trimmed.slice(0, singleMatch.index).trim(),
      partIndex: Number.isFinite(partIndex) ? Math.max(0, partIndex) : undefined,
      totalParts: undefined
    }
  }
  return { base: trimmed }
}

/** 创作时生成更易读的章节标题 */
export function formatChapterDisplayTitle(input: {
  outlineTitle: string
  volumeSequence?: number
  partIndex?: number
  totalParts?: number
}): string {
  const subtitle = extractChapterSubtitle(input.outlineTitle)
  const seq = input.volumeSequence
  const total = Math.max(1, input.totalParts ?? 1)
  const part = Math.max(0, input.partIndex ?? 0)
  const prefix = seq && seq > 0 ? `第${seq}章 ` : ''

  if (total > 1) {
    return `${prefix}${subtitle}（${part + 1}）`
  }
  return `${prefix}${subtitle}`
}

export function formatChapterDisplayTitleFromExisting(input: {
  currentTitle: string
  outlineTitle?: string
  volumeSequence: number
}): string {
  const parsed = parseChapterPartSuffix(input.currentTitle)
  const outlineTitle = input.outlineTitle?.trim() || parsed.base || input.currentTitle
  return formatChapterDisplayTitle({
    outlineTitle,
    volumeSequence: input.volumeSequence,
    partIndex: parsed.partIndex,
    totalParts: parsed.totalParts
  })
}

export type ChapterTitleBatchEntry = {
  index: number
  title: string
}

export type ChapterTitleBatchResult = {
  suggestion: string
  entries: ChapterTitleBatchEntry[]
}
