import type { FirstDraftConfig } from '@/components/chapterWorkspace/useChapterFirstDraft'

export type AutoCreationRunStatus = 'idle' | 'running' | 'paused' | 'completed' | 'failed'

export type AutoCreationPauseReason = 'user' | 'api_error' | 'config_error' | 'quality_limit'

export type AutoCreationChapterStep =
  | 'ensure-chapter'
  | 'acceptance-check'
  | 'load-advice'
  | 'memo'
  | 'brief'
  | 'first-draft'
  | 'audit'
  | 'quality-review'
  | 'repair'
  | 'final-gate'
  | 'final-polish'
  | 'session-note'
  | 'persist'

export type ChapterPipelineMode = 'full' | 'quality-only'

export interface AutoCreationConfig extends Omit<FirstDraftConfig, 'targetWordCount'> {
  /** 未设置时，每章使用大纲节点上的 wordTarget */
  targetWordCount?: number
  /** 强制覆盖每章字数下限（与 forcedWordCountMax 同时设置时生效） */
  forcedWordCountMin?: number
  /** 强制覆盖每章字数上限（与 forcedWordCountMin 同时设置时生效） */
  forcedWordCountMax?: number
  maxAuditRepairRounds: number
  maxFinalGateRounds: number
  maxRepairRounds?: number
  maxChapters?: number
  /** 处理到该大纲节点（含）即停止；与 maxChapters 同时设置时取更严限制 */
  targetOutlineItemId?: string
  openingRecycleMinChars?: number
  dialogueRatioMin?: number
  qualityReviewMaxWarnings?: number
  qualityReviewEnabled?: boolean
  narratorTelegraphEnabled?: boolean
  chapterBriefEnabled?: boolean
  finalPolishEnabled?: boolean
}

export interface AutoCreationRun {
  id: string
  projectId: string
  volumeId: string
  status: AutoCreationRunStatus
  pauseReason?: AutoCreationPauseReason
  pauseMessage?: string
  config: AutoCreationConfig
  chapterQueue: string[]
  currentIndex: number
  currentStep?: AutoCreationChapterStep
  startedAt: string
  updatedAt: string
  completedChapterIds: string[]
  skippedChapterIds: string[]
  failedChapterId?: string
}

export interface FinalGateResult {
  pass: boolean
  wordCountOk: boolean
  deAiOk: boolean
  naturalOk: boolean
  issues: string[]
}

export interface ChapterPipelineProgress {
  step: AutoCreationChapterStep
  label: string
}

export interface ChapterPipelineResult {
  ok: boolean
  skipped?: boolean
  mode?: ChapterPipelineMode
  finalContent?: string
  auditPass?: boolean
  finalGatePass?: boolean
  acceptanceRecorded?: boolean
  error?: string
}

export const DEFAULT_AUTO_CREATION_CONFIG: AutoCreationConfig = {
  selectedReferenceWorkIds: [],
  enabledSkillIds: [],
  userPrompt: '',
  maxAuditRepairRounds: 2,
  maxFinalGateRounds: 2,
  maxRepairRounds: 2,
  qualityReviewEnabled: true,
  chapterBriefEnabled: true,
  finalPolishEnabled: true,
}

/** 本次 run 实际要处理的章节数（受目标大纲节点与 maxChapters 限制） */
export function getAutoCreationEffectiveTotal(input: {
  chapterQueueLength: number
  maxChapters?: number
  targetOutlineQueueLength?: number
}): number {
  const { chapterQueueLength, maxChapters, targetOutlineQueueLength } = input
  let limit = chapterQueueLength
  if (targetOutlineQueueLength != null && targetOutlineQueueLength > 0) {
    limit = Math.min(limit, targetOutlineQueueLength)
  }
  if (maxChapters != null && maxChapters > 0) {
    limit = Math.min(limit, Math.round(maxChapters))
  }
  return limit
}

export const AUTO_CREATION_RUN_STORAGE_KEY = 'characterarc:auto-creation-run'
