import { stripToPlainText } from './text-utils.js'

export const MIN_CHAPTER_BODY_CHARS = 50

export type OutlineItemLike = {
  id: string
  title?: string
  wordTarget?: string
  status?: string
  volumeId?: string
}

export type ChapterLike = {
  id: string
  outlineItemId?: string
  volumeId?: string
  title?: string
  content?: string
}

export type KnowledgeDocLike = {
  id: string
  title?: string
  sourceLabel?: string
  metadata?: Record<string, unknown>
}

export function hasChapterBody(content: string | undefined | null): boolean {
  return stripToPlainText(content ?? '').length >= MIN_CHAPTER_BODY_CHARS
}

export function isChapterAcceptanceRecorded(
  knowledgeDocuments: KnowledgeDocLike[],
  chapterId: string,
): boolean {
  return knowledgeDocuments.some((document) => {
    if (document.sourceLabel !== 'writing-journal') return false
    const meta = document.metadata ?? {}
    return String(meta.chapterId ?? '') === chapterId && Boolean(meta.autoAcceptancePassed)
  })
}

export function parseOutlinePlannedChapterCount(wordTarget?: string): number {
  const raw = (wordTarget ?? '').trim()
  if (!raw) return 1
  const rangeChapter = raw.match(/(\d+)\s*[–\-~～—]\s*(\d+)\s*章/)
  if (rangeChapter) {
    const lo = Number.parseInt(rangeChapter[1]!, 10)
    const hi = Number.parseInt(rangeChapter[2]!, 10)
    if (hi >= lo) return Math.max(1, Math.round((lo + hi) / 2))
    return Math.max(1, lo)
  }
  const singleChapter = raw.match(/(\d+)\s*章/)
  if (singleChapter) return Math.max(1, Number.parseInt(singleChapter[1]!, 10))
  return 1
}

export function shouldSkipOutlineNode(item: OutlineItemLike): boolean {
  const title = (item.title ?? '').trim()
  const wordTarget = (item.wordTarget ?? '').trim()
  if (/索引条|非单章|写作索引/.test(wordTarget)) return true
  if (/正史总览|写作索引|章级索引/.test(title)) return true
  return false
}

function linkedChapters(
  item: OutlineItemLike,
  chapters: ChapterLike[],
): ChapterLike[] {
  const title = (item.title ?? '').trim()
  return chapters.filter(
    (chapter) =>
      chapter.outlineItemId === item.id
      || (
        !chapter.outlineItemId
        && chapter.volumeId === item.volumeId
        && (chapter.title ?? '').trim() === title
      ),
  )
}

export function inferOutlineItemStatus(
  item: OutlineItemLike,
  chapters: ChapterLike[],
  knowledgeDocuments: KnowledgeDocLike[],
): 'planned' | 'drafting' | 'done' {
  if (shouldSkipOutlineNode(item)) {
    return item.status === 'done' || item.status === 'drafting' ? item.status : 'planned'
  }

  const planned = parseOutlinePlannedChapterCount(item.wordTarget)
  const linked = linkedChapters(item, chapters)
  const withBody = linked.filter((chapter) => hasChapterBody(chapter.content))
  const accepted = withBody.filter((chapter) =>
    isChapterAcceptanceRecorded(knowledgeDocuments, chapter.id),
  )

  if (withBody.length === 0) return 'planned'
  if (accepted.length >= planned && withBody.length >= planned) return 'done'
  return 'drafting'
}

function normalizeTitleKey(value: string): string {
  return value.replace(/\s+/g, '')
}

export function findChapterForOrphanJournal(
  doc: KnowledgeDocLike,
  chapters: ChapterLike[],
  outlineItems: OutlineItemLike[],
): string | undefined {
  const title = (doc.title ?? '').replace(/^写作日志｜/, '').trim()
  const key = normalizeTitleKey(title)
  if (!key) return undefined

  for (const chapter of chapters) {
    const chapterTitle = (chapter.title ?? '').trim()
    const chapterKey = normalizeTitleKey(chapterTitle)
    if (chapterKey && key.includes(chapterKey)) return chapter.id
    if (chapterKey && chapterKey.includes(key)) return chapter.id
  }

  for (const item of outlineItems) {
    const itemTitle = (item.title ?? '').trim()
    if (!itemTitle || !title.includes(itemTitle)) continue
    const itemChapters = linkedChapters(item, chapters).filter((chapter) =>
      hasChapterBody(chapter.content),
    )
    if (itemChapters.length > 0) return itemChapters[0]!.id
  }

  return undefined
}

export function relinkOrphanedWritingJournals(
  knowledgeDocuments: KnowledgeDocLike[],
  chapters: ChapterLike[],
  outlineItems: OutlineItemLike[],
): { documents: KnowledgeDocLike[]; changed: number } {
  const chapterIds = new Set(chapters.map((chapter) => chapter.id))
  let changed = 0

  const documents = knowledgeDocuments.map((doc) => {
    if (doc.sourceLabel !== 'writing-journal') return doc
    const meta = { ...(doc.metadata ?? {}) }
    if (!meta.autoAcceptancePassed) return doc

    const oldId = String(meta.chapterId ?? '')
    if (oldId && chapterIds.has(oldId)) return doc

    const newId = findChapterForOrphanJournal(doc, chapters, outlineItems)
    if (!newId || newId === oldId) return doc

    changed += 1
    return {
      ...doc,
      metadata: { ...meta, chapterId: newId },
    }
  })

  return { documents, changed }
}

export function syncOutlineItemStatus(
  outlineItem: OutlineItemLike,
  chapters: ChapterLike[],
  knowledgeDocuments: KnowledgeDocLike[],
): 'planned' | 'drafting' | 'done' {
  return inferOutlineItemStatus(outlineItem, chapters, knowledgeDocuments)
}
