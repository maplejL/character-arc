import { getPlainTextFromEditorContent } from '@/features/chapters/editorContent'
import { isChapterAcceptanceRecorded } from '@/features/autoCreation/advice'
import type { ChapterDraft, KnowledgeDocument } from '@/types/app'

const MIN_BODY_CHARS = 50

export function hasChapterBody(content: string | undefined | null): boolean {
  return getPlainTextFromEditorContent(content ?? '').trim().length >= MIN_BODY_CHARS
}

export function evaluateChapterAcceptanceSync(
  chapter: ChapterDraft,
  knowledgeDocuments: KnowledgeDocument[]
): { satisfied: boolean; hasBody: boolean } {
  const hasBody = hasChapterBody(chapter.content)
  // 隔离章（失败/未过终检）必须重新处理，不得按已完成跳过
  if (chapter.status === 'quarantine') {
    return { satisfied: false, hasBody }
  }
  if (!hasBody) {
    return { satisfied: false, hasBody: false }
  }
  const satisfied = isChapterAcceptanceRecorded(knowledgeDocuments, chapter.id)
  return { satisfied, hasBody: true }
}
