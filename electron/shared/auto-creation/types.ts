export type QualityIssueSeverity = 'critical' | 'warning' | 'hint'

export type QualityIssue = {
  severity: QualityIssueSeverity
  category: string
  ref: string
  hint: string
  repairAction?: string
}

export type QualityCheckResult = {
  pass: boolean
  issues: QualityIssue[]
}

export type ChapterAuditPayload = {
  pass: boolean
  issues: QualityIssue[]
  wordCount?: number
}

export type OutlineChapterSplit = {
  currentPart: number
  totalParts: number
  previousParts: Array<{ title?: string; summary?: string; preview: string }>
}

export type ReferenceOpening = {
  chapterTitle: string
  excerpt: string
}

export type ChapterProductionContext = {
  chapterId: string
  chapterTitle?: string
  isFirstChapterInVolume: boolean
  isFirstChapterInBook: boolean
  outlineChapterSplit: OutlineChapterSplit | null
  referenceOpenings: ReferenceOpening[]
  previousChapterOpeningExcerpt: string | null
  previousChapterHandoff: { title?: string; endingText: string } | null
  recentEndingsTrail: Array<{ chapterTitle?: string; endingLine: string }>
  currentOutlineItem: {
    title?: string
    summary?: string
    conflict?: string
    wordTarget?: string
  } | null
}

export type AutoCreationQualityConfig = {
  openingRecycleMinChars?: number
  dialogueRatioMin?: number
  qualityReviewMaxWarnings?: number
  qualityReviewEnabled?: boolean
  narratorTelegraphEnabled?: boolean
  /** memo 生成后渲染可读任务书再写初稿 */
  chapterBriefEnabled?: boolean
  /** 契约通过后终稿去 AI 味 / 节奏轻修 */
  finalPolishEnabled?: boolean
}

export const DEFAULT_AUTO_CREATION_QUALITY_CONFIG: Required<AutoCreationQualityConfig> = {
  openingRecycleMinChars: 30,
  dialogueRatioMin: 0.25,
  qualityReviewMaxWarnings: 4,
  qualityReviewEnabled: true,
  narratorTelegraphEnabled: true,
  chapterBriefEnabled: true,
  finalPolishEnabled: true,
}

export function resolveQualityConfig(
  config?: AutoCreationQualityConfig,
): Required<AutoCreationQualityConfig> {
  return {
    openingRecycleMinChars:
      config?.openingRecycleMinChars ?? DEFAULT_AUTO_CREATION_QUALITY_CONFIG.openingRecycleMinChars,
    dialogueRatioMin: config?.dialogueRatioMin ?? DEFAULT_AUTO_CREATION_QUALITY_CONFIG.dialogueRatioMin,
    qualityReviewMaxWarnings:
      config?.qualityReviewMaxWarnings ?? DEFAULT_AUTO_CREATION_QUALITY_CONFIG.qualityReviewMaxWarnings,
    qualityReviewEnabled:
      config?.qualityReviewEnabled ?? DEFAULT_AUTO_CREATION_QUALITY_CONFIG.qualityReviewEnabled,
    narratorTelegraphEnabled:
      config?.narratorTelegraphEnabled ?? DEFAULT_AUTO_CREATION_QUALITY_CONFIG.narratorTelegraphEnabled,
    chapterBriefEnabled:
      config?.chapterBriefEnabled ?? DEFAULT_AUTO_CREATION_QUALITY_CONFIG.chapterBriefEnabled,
    finalPolishEnabled:
      config?.finalPolishEnabled ?? DEFAULT_AUTO_CREATION_QUALITY_CONFIG.finalPolishEnabled,
  }
}

export function resolveMaxRepairRounds(config: {
  maxRepairRounds?: number
  maxAuditRepairRounds?: number
  maxFinalGateRounds?: number
}): number {
  if (typeof config.maxRepairRounds === 'number') return config.maxRepairRounds
  if (typeof config.maxFinalGateRounds === 'number') return config.maxFinalGateRounds
  if (typeof config.maxAuditRepairRounds === 'number') return config.maxAuditRepairRounds
  return 2
}
