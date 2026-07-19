import { runConvergenceLoop as runSharedConvergenceLoop, resolveMaxRepairRounds } from '@shared/auto-creation/convergence-loop'
import type {
  ChapterAuditPayload,
  ChapterQualityReviewPayload,
  ConvergenceStreamTaskName,
} from '@shared/auto-creation/convergence-loop'
import type { QualityIssue } from '@shared/auto-creation/types'
import { ensureEditorHtmlContent } from '@/features/chapters/editorContent'
import { getPlainTextFromEditorContent } from '@/features/chapters/editorContent'
import { formatMemoForRepair } from '@/features/autoCreation/chapterDraftHelpers'
import {
  buildChapterRepairContext,
  filterGateIssuesForRepair,
  fitDraftToWordBounds,
  normalizeDraftForAutoCreation,
  AUTO_CREATION_WORD_TOLERANCE,
} from '@/features/autoCreation/finalGate'

export type { ChapterQualityReviewPayload, ConvergenceStreamTaskName, ChapterAuditPayload }

export async function runConvergenceLoop(
  input: Parameters<typeof runSharedConvergenceLoop>[0],
): Promise<{
  content: string
  finalGatePass: boolean
  audit: ChapterAuditPayload | null
  qualityIssues: QualityIssue[]
  abortReason?: 'audit-error' | 'repair-error' | null
}> {
  return runSharedConvergenceLoop(input, {
    getPlainText: (content) => getPlainTextFromEditorContent(ensureEditorHtmlContent(content)).trim(),
    normalizeDraft: normalizeDraftForAutoCreation,
    fitDraftToWordBounds,
    formatMemoForRepair,
    buildChapterRepairContext: (input) => buildChapterRepairContext(input as Parameters<typeof buildChapterRepairContext>[0]),
    filterGateIssuesForRepair,
    wordTolerancePercent: AUTO_CREATION_WORD_TOLERANCE * 100,
  })
}

export { resolveMaxRepairRounds }
