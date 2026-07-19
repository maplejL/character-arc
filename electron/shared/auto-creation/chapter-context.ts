import type { ChapterProductionContext, OutlineChapterSplit, ReferenceOpening } from './types.js'
import { getEndingExcerpt, getLastLine, getOpeningExcerpt, stripToPlainText } from './text-utils.js'

export type BuildChapterProductionContextInput = {
  chapters: Array<{
    id: string
    title?: string
    summary?: string
    content?: string
    volumeId?: string
    outlineItemId?: string
  }>
  outlineItems: Array<{
    id: string
    volumeId: string
    title: string
    sortOrder?: number
    wordTarget?: string
    conflict?: string
    summary?: string
  }>
  chapterId: string
  volumeId: string
  openingExcerptChars?: number
  handoffChars?: number
  previewChars?: number
}

function getPreviewText(content: string | undefined, maxChars: number): string {
  const plain = stripToPlainText(content ?? '')
  if (!plain) return ''
  return plain.slice(0, maxChars)
}

export function buildOutlineChapterSplit(input: {
  chapters: BuildChapterProductionContextInput['chapters']
  outlineItems: BuildChapterProductionContextInput['outlineItems']
  chapterId: string
  currentOutlineItem: BuildChapterProductionContextInput['outlineItems'][number] | null
  previewChars: number
}): OutlineChapterSplit | null {
  const { currentOutlineItem } = input
  if (!currentOutlineItem) return null

  const sameOutlineChapters = input.chapters.filter(
    (item) =>
      item.outlineItemId === currentOutlineItem.id
      || (
        !item.outlineItemId
        && item.volumeId === currentOutlineItem.volumeId
        && item.title?.trim() === currentOutlineItem.title.trim()
      ),
  )
  if (sameOutlineChapters.length <= 1) return null

  const currentIndex = sameOutlineChapters.findIndex((item) => item.id === input.chapterId)
  const previousParts = (currentIndex >= 0 ? sameOutlineChapters.slice(0, currentIndex) : []).map((item) => ({
    title: item.title,
    summary: item.summary,
    preview: getPreviewText(item.content, input.previewChars),
  }))

  return {
    currentPart: currentIndex >= 0 ? currentIndex + 1 : 1,
    totalParts: Math.max(sameOutlineChapters.length, 1),
    previousParts,
  }
}

export function buildChapterProductionContext(
  input: BuildChapterProductionContextInput,
): ChapterProductionContext {
  const openingExcerptChars = input.openingExcerptChars ?? 400
  const handoffChars = input.handoffChars ?? 800
  const previewChars = input.previewChars ?? 220

  const currentIndex = input.chapters.findIndex((item) => item.id === input.chapterId)
  const chapter = input.chapters[currentIndex]
  const precedingChapters = currentIndex >= 0 ? input.chapters.slice(0, currentIndex) : []
  const chaptersWithContent = precedingChapters.filter((item) => stripToPlainText(item.content ?? '').length > 0)
  const handoffChapter = chaptersWithContent.at(-1)
  const firstChapterInBook = input.chapters[0]
  const firstChapterInVolume = input.chapters.find((item) => item.volumeId === input.volumeId)

  const volumeOutlineItems = input.outlineItems.filter((item) => item.volumeId === input.volumeId)
  const currentOutlineItem = chapter?.outlineItemId
    ? volumeOutlineItems.find((item) => item.id === chapter.outlineItemId) ?? null
    : volumeOutlineItems.find((item) => item.title?.trim() === chapter?.title?.trim()) ?? null

  const outlineChapterSplit = buildOutlineChapterSplit({
    chapters: input.chapters,
    outlineItems: input.outlineItems,
    chapterId: input.chapterId,
    currentOutlineItem,
    previewChars,
  })

  const referenceOpenings: ReferenceOpening[] = []
  if (firstChapterInBook && firstChapterInBook.id !== input.chapterId) {
    const excerpt = getOpeningExcerpt(firstChapterInBook.content ?? '', openingExcerptChars)
    if (excerpt) {
      referenceOpenings.push({
        chapterTitle: firstChapterInBook.title ?? '第一章',
        excerpt,
      })
    }
  }

  const previousChapter = handoffChapter
  const previousChapterOpeningExcerpt = previousChapter
    ? getOpeningExcerpt(previousChapter.content ?? '', openingExcerptChars)
    : null

  if (outlineChapterSplit?.previousParts.length) {
    for (const part of outlineChapterSplit.previousParts) {
      if (part.preview) {
        referenceOpenings.push({
          chapterTitle: part.title ?? '同纲前置章',
          excerpt: part.preview.slice(0, openingExcerptChars),
        })
      }
    }
  }

  const recentEndingsTrail = chaptersWithContent
    .slice(0, handoffChapter ? -1 : undefined)
    .slice(-3)
    .map((item) => ({
      chapterTitle: item.title,
      endingLine: getLastLine(item.content ?? ''),
    }))
    .filter((entry) => entry.endingLine)

  return {
    chapterId: input.chapterId,
    chapterTitle: chapter?.title,
    isFirstChapterInVolume: firstChapterInVolume?.id === input.chapterId,
    isFirstChapterInBook: firstChapterInBook?.id === input.chapterId,
    outlineChapterSplit,
    referenceOpenings,
    previousChapterOpeningExcerpt,
    previousChapterHandoff: handoffChapter
      ? {
          title: handoffChapter.title,
          endingText: getEndingExcerpt(handoffChapter.content ?? '', handoffChars),
        }
      : null,
    recentEndingsTrail,
    currentOutlineItem: currentOutlineItem
      ? {
          title: currentOutlineItem.title,
          summary: currentOutlineItem.summary,
          conflict: currentOutlineItem.conflict,
          wordTarget: currentOutlineItem.wordTarget,
        }
      : null,
  }
}
