import type { WorkspacePayload } from '../workspace/json-store.js'

type OutlineItem = {
  id: string
  volumeId: string
  title?: string
  wordTarget?: string
  sortOrder: number
}

type ChapterDraft = {
  id: string
  volumeId: string
  outlineItemId?: string
  title?: string
}

const OUTLINE_QUEUE_PREFIX = 'outline:'

function shouldSkipOutlineNodeForAutoCreation(item: { title?: string; wordTarget?: string }): boolean {
  const title = (item.title ?? '').trim()
  const wordTarget = (item.wordTarget ?? '').trim()
  if (/索引条|非单章|写作索引/.test(wordTarget)) return true
  if (/正史总览|写作索引|章级索引/.test(title)) return true
  return false
}

function parseOutlineQueueEntry(entryId: string): { outlineItemId: string; partIndex: number } | null {
  if (!entryId.startsWith(OUTLINE_QUEUE_PREFIX)) return null
  const body = entryId.slice(OUTLINE_QUEUE_PREFIX.length)
  const [outlineItemId, partRaw] = body.split(':')
  if (!outlineItemId) return null
  const partIndex = partRaw ? Number.parseInt(partRaw, 10) : 0
  return { outlineItemId, partIndex: Number.isFinite(partIndex) ? partIndex : 0 }
}

export function limitChapterQueueToTargetOutline(
  queue: string[],
  input: {
    volumeId: string
    workspace: WorkspacePayload
    projectId: string
    targetOutlineItemId?: string
  },
): string[] {
  const { targetOutlineItemId, projectId, volumeId, workspace } = input
  if (!targetOutlineItemId) return queue

  const ws = workspace.workspaces[projectId] ?? {}
  const outlineItems = (Array.isArray(ws.outlineItems) ? ws.outlineItems : []) as OutlineItem[]
  const chapters = (Array.isArray(ws.chapters) ? ws.chapters : []) as ChapterDraft[]

  const volumeItems = outlineItems
    .filter((item) => item.volumeId === volumeId)
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .filter((item) => !shouldSkipOutlineNodeForAutoCreation(item))

  const targetIndex = volumeItems.findIndex((item) => item.id === targetOutlineItemId)
  if (targetIndex < 0) return queue

  const allowedOutlineIds = new Set(volumeItems.slice(0, targetIndex + 1).map((item) => item.id))

  return queue.filter((entry) => {
    const parsed = parseOutlineQueueEntry(entry)
    if (parsed) {
      return allowedOutlineIds.has(parsed.outlineItemId)
    }

    const chapter = chapters.find((item) => item.id === entry)
    if (!chapter) return false

    if (chapter.outlineItemId) {
      return allowedOutlineIds.has(chapter.outlineItemId)
    }

    const matchedItem = volumeItems.find(
      (item) => item.volumeId === chapter.volumeId && item.title?.trim() === chapter.title?.trim(),
    )
    return matchedItem ? allowedOutlineIds.has(matchedItem.id) : false
  })
}

export function getTargetOutlineQueueLength(
  queue: string[],
  input: {
    volumeId: string
    workspace: WorkspacePayload
    projectId: string
    targetOutlineItemId?: string
  },
): number | undefined {
  if (!input.targetOutlineItemId) return undefined
  return limitChapterQueueToTargetOutline(queue, input).length
}
