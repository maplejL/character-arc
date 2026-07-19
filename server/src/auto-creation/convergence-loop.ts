import {
  runConvergenceLoop as runSharedConvergenceLoop,
  resolveMaxRepairRounds,
  type ChapterAuditPayload,
  type ChapterQualityReviewPayload,
  type ConvergenceStreamTaskName,
} from './shared/convergence-loop.js'
import {
  buildChapterRepairContext,
  filterGateIssuesForRepair,
  fitDraftToWordBounds,
  formatMemoForRepair,
  normalizeDraftForAutoCreation,
  AUTO_CREATION_WORD_TOLERANCE,
} from './pipeline-helpers.js'
import { getPlainTextFromEditorContent } from './editor-content.js'

import type { QualityIssue } from './shared/types.js'

export type { ChapterAuditPayload, ChapterQualityReviewPayload, ConvergenceStreamTaskName }

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
    getPlainText: (content) => getPlainTextFromEditorContent(content).trim(),
    normalizeDraft: normalizeDraftForAutoCreation,
    fitDraftToWordBounds,
    formatMemoForRepair,
    buildChapterRepairContext: (input) => buildChapterRepairContext(input as Parameters<typeof buildChapterRepairContext>[0]),
    filterGateIssuesForRepair,
    wordTolerancePercent: AUTO_CREATION_WORD_TOLERANCE * 100,
  })
}

export { resolveMaxRepairRounds }
