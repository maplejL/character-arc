export function extractChapterSubtitle(outlineTitle: string): string {
  const trimmed = outlineTitle.trim()
  if (!trimmed) return '未命名章节'
  const segments = trimmed.split(/[｜|]/).map((part) => part.trim()).filter(Boolean)
  if (segments.length >= 2) return segments[segments.length - 1]!
  return trimmed
}

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

export function countChaptersInVolume(
  chapters: Array<{ volumeId?: string }>,
  volumeId: string,
): number {
  return chapters.filter((chapter) => chapter.volumeId === volumeId).length
}
