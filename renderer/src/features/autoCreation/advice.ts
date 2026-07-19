import { getPlainTextFromEditorContent } from '@/features/chapters/editorContent'
import type { ChapterDraft, KnowledgeDocument } from '@/types/app'

const NEXT_ADVICE_PREFIX = '下章建议：'

export function extractNextChapterAdviceFromJournal(document: KnowledgeDocument): string {
  const summary = document.summary?.trim()
  if (summary) return summary
  const content = document.content ?? ''
  const markerIndex = content.indexOf(NEXT_ADVICE_PREFIX)
  if (markerIndex >= 0) {
    return content.slice(markerIndex + NEXT_ADVICE_PREFIX.length).trim()
  }
  return content.trim()
}

export function findWritingJournalForChapter(
  knowledgeDocuments: KnowledgeDocument[],
  chapterId: string
): KnowledgeDocument | undefined {
  return knowledgeDocuments.find((document) =>
    document.sourceLabel === 'writing-journal'
    && String(document.metadata?.chapterId ?? '') === chapterId
  )
}

export function isChapterAcceptanceRecorded(
  knowledgeDocuments: KnowledgeDocument[],
  chapterId: string
): boolean {
  const journal = findWritingJournalForChapter(knowledgeDocuments, chapterId)
  return Boolean(journal?.metadata?.autoAcceptancePassed)
}

export function loadPreviousChapterAdvice(
  chapters: ChapterDraft[],
  knowledgeDocuments: KnowledgeDocument[],
  currentChapterId: string
): string | undefined {
  const currentIndex = chapters.findIndex((chapter) => chapter.id === currentChapterId)
  if (currentIndex <= 0) return undefined

  const preceding = chapters.slice(0, currentIndex).reverse()
  for (const chapter of preceding) {
    if (!getPlainTextFromEditorContent(chapter.content ?? '').trim()) continue
    const journal = findWritingJournalForChapter(knowledgeDocuments, chapter.id)
    if (!journal) continue
    const advice = extractNextChapterAdviceFromJournal(journal)
    if (advice) return advice
  }
  return undefined
}
