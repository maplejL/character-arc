import type { ChapterDraft, OutlineItem } from '@/types/app'
import { parseOutlinePlannedChapterCount, shouldSkipOutlineNodeForAutoCreation } from '@/features/chapters/wordTarget'

export function resolveLinkedChaptersForOutlineItem(
  chapters: ChapterDraft[],
  item: OutlineItem
): ChapterDraft[] {
  return chapters.filter((chapter) =>
    chapter.outlineItemId === item.id
    || (!chapter.outlineItemId && chapter.volumeId === item.volumeId && chapter.title.trim() === item.title.trim())
  )
}

export type VolumeChapterQueueEntry =
  | { kind: 'chapter'; chapterId: string }
  | { kind: 'pending-outline'; outlineItemId: string; partIndex: number; totalParts: number }

/**
 * 构建当前分卷的章节生产队列（按大纲 sort_order）。
 * 读取节点 wordTarget 中的规划章数（如「3–5章」「20–30章」），不足则补占位，Runner 处理时建章。
 */
export function buildVolumeChapterQueue(input: {
  volumeId: string
  chapters: ChapterDraft[]
  outlineItems: OutlineItem[]
}): VolumeChapterQueueEntry[] {
  const volumeItems = input.outlineItems
    .filter((item) => item.volumeId === input.volumeId)
    .sort((a, b) => a.sortOrder - b.sortOrder)

  const volumeChapters = input.chapters.filter((chapter) => chapter.volumeId === input.volumeId)
  const queuedChapterIds = new Set<string>()
  const queue: VolumeChapterQueueEntry[] = []

  for (const item of volumeItems) {
    if (shouldSkipOutlineNodeForAutoCreation(item)) continue
    const plannedParts = parseOutlinePlannedChapterCount(item.wordTarget)
    const linked = resolveLinkedChaptersForOutlineItem(volumeChapters, item)

    for (const chapter of linked) {
      if (queuedChapterIds.has(chapter.id)) continue
      queuedChapterIds.add(chapter.id)
      queue.push({ kind: 'chapter', chapterId: chapter.id })
    }

    const missing = Math.max(0, plannedParts - linked.length)
    for (let partIndex = linked.length; partIndex < linked.length + missing; partIndex += 1) {
      queue.push({
        kind: 'pending-outline',
        outlineItemId: item.id,
        partIndex,
        totalParts: plannedParts,
      })
    }
  }

  for (const chapter of volumeChapters) {
    if (queuedChapterIds.has(chapter.id)) continue
    queue.push({ kind: 'chapter', chapterId: chapter.id })
  }

  return queue
}

export function countVolumeChapterQueue(entries: VolumeChapterQueueEntry[]): number {
  return entries.length
}

/** 仅保留从分卷开头到目标大纲节点（含）的队列条目 */
export function limitVolumeChapterQueueByTargetOutline(
  queue: VolumeChapterQueueEntry[],
  input: {
    volumeId: string
    chapters: ChapterDraft[]
    outlineItems: OutlineItem[]
    targetOutlineItemId?: string
  }
): VolumeChapterQueueEntry[] {
  const { targetOutlineItemId } = input
  if (!targetOutlineItemId) return queue

  const volumeItems = input.outlineItems
    .filter((item) => item.volumeId === input.volumeId)
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .filter((item) => !shouldSkipOutlineNodeForAutoCreation(item))

  const targetIndex = volumeItems.findIndex((item) => item.id === targetOutlineItemId)
  if (targetIndex < 0) return queue

  const allowedOutlineIds = new Set(volumeItems.slice(0, targetIndex + 1).map((item) => item.id))

  return queue.filter((entry) => {
    if (entry.kind === 'pending-outline') {
      return allowedOutlineIds.has(entry.outlineItemId)
    }

    const chapter = input.chapters.find((item) => item.id === entry.chapterId)
    if (!chapter) return false

    if (chapter.outlineItemId) {
      return allowedOutlineIds.has(chapter.outlineItemId)
    }

    const matchedItem = volumeItems.find(
      (item) => item.volumeId === chapter.volumeId && item.title.trim() === chapter.title.trim()
    )
    return matchedItem ? allowedOutlineIds.has(matchedItem.id) : false
  })
}

export function getTargetOutlineQueueLength(input: {
  volumeId: string
  chapters: ChapterDraft[]
  outlineItems: OutlineItem[]
  targetOutlineItemId?: string
}): number | undefined {
  if (!input.targetOutlineItemId) return undefined
  const fullQueue = buildVolumeChapterQueue({
    volumeId: input.volumeId,
    chapters: input.chapters,
    outlineItems: input.outlineItems,
  })
  return limitVolumeChapterQueueByTargetOutline(fullQueue, input).length
}
