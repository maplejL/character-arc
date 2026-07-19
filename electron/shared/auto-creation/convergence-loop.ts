import {
  evaluateUnifiedFinalGate,
  formatQualityIssuesForRepair,
  collectContractRepairIssues,
  prioritizeRepairIssues,
  recomputeQualityPass,
} from './convergence.js'
import { evaluateDraftPreflight } from './preflight.js'
import { resolveQualityConfig, resolveMaxRepairRounds } from './types.js'
import type {
  AutoCreationQualityConfig,
  ChapterAuditPayload,
  ChapterProductionContext,
  QualityCheckResult,
  QualityIssue,
} from './types.js'
import {
  buildAuditPhaseInstruction,
  buildQualityPhaseInstruction,
  buildRepairPhaseInstruction,
} from './chapter-production-prompts.js'
import type { ChapterConvergenceSession } from './convergence-session.js'

export type { ChapterAuditPayload }

export type ChapterQualityReviewPayload = {
  pass: boolean
  issues: Array<{
    severity: string
    category: string
    ref: string
    hint: string
    repairAction?: string
  }>
}

export type ConvergenceStreamTaskName = 'chapter-quality-review' | 'chapter-audit' | 'chapter-repair'

export type ConvergencePhaseResult = {
  text: string
  result?: unknown
  usage?: {
    promptTokens?: number
    cachedInputTokens?: number
    promptCacheMissTokens?: number
  }
}

export type ConvergenceLoopDeps = {
  getPlainText: (content: string) => string
  normalizeDraft: (content: string) => string
  fitDraftToWordBounds: (content: string, targetWordCount: number) => string
  formatMemoForRepair: (memo: Record<string, unknown>) => string
  buildChapterRepairContext: (input: Record<string, unknown>) => Record<string, unknown>
  filterGateIssuesForRepair: (
    issues: string[],
    content: string,
    targetWordCount: number,
  ) => { issues: string[]; wordCountStrict: boolean }
  wordTolerancePercent: number
}

export async function runConvergenceLoop(
  input: {
    streamTask?: (
      task: ConvergenceStreamTaskName,
      context: Record<string, unknown>,
    ) => Promise<{ text: string; result?: unknown }>
    streamSessionPhase?: (args: {
      phase: ConvergenceStreamTaskName
      session: ChapterConvergenceSession
      userTurn: string
    }) => Promise<ConvergencePhaseResult>
    session?: ChapterConvergenceSession
    content: string
    targetWordCount: number
    productionContext: ChapterProductionContext
    chapterMemo?: Record<string, unknown>
    repairContextBase: Record<string, unknown>
    qualityConfig?: AutoCreationQualityConfig
    maxRounds: number
    memoBaseContext: Record<string, unknown>
    projectId: string
    chapterId: string
    chapterTitle?: string
    onProgress?: (progress: { step: 'audit' | 'repair' | 'final-gate'; label: string }) => void
    onDraftRepaired?: (content: string) => void
  },
  deps: ConvergenceLoopDeps,
): Promise<{
  content: string
  finalGatePass: boolean
  audit: ChapterAuditPayload | null
  qualityIssues: QualityIssue[]
}> {
  const qualitySettings = resolveQualityConfig(input.qualityConfig)
  let content = input.content
  let audit: ChapterAuditPayload | null = null
  let lastQualityIssues: QualityIssue[] = []
  const useSession = Boolean(input.streamSessionPhase && input.session)

  for (let round = 0; round <= input.maxRounds; round += 1) {
    content = deps.normalizeDraft(content)
    const plain = deps.getPlainText(content).trim()

    const preflight = evaluateDraftPreflight(content, input.productionContext, input.qualityConfig)

    let quality: QualityCheckResult = { pass: true, issues: [] }
    if (qualitySettings.qualityReviewEnabled) {
      input.onProgress?.({
        step: 'audit',
        label: round === 0 ? '正在进行网文体检...' : `第 ${round} 轮网文体检...`,
      })
      const qualityUserTurn = buildQualityPhaseInstruction(round, qualitySettings.qualityReviewMaxWarnings)
      const qualityStream = useSession
        ? await input.streamSessionPhase!({
            phase: 'chapter-quality-review',
            session: input.session!,
            userTurn: qualityUserTurn,
          })
        : await input.streamTask!('chapter-quality-review', {
            projectId: input.projectId,
            chapterId: input.chapterId,
            chapterTitle: input.chapterTitle,
            chapterSummary: input.repairContextBase.chapterSummary,
            projectGenre: input.repairContextBase.projectGenre,
            draftText: content,
            qualityReviewMaxWarnings: qualitySettings.qualityReviewMaxWarnings,
            currentOutlineItem: input.productionContext.currentOutlineItem,
            outlineChapterSplit: input.productionContext.outlineChapterSplit,
            relatedChapters: input.memoBaseContext.relatedChapters,
            previousChapterHandoff: input.productionContext.previousChapterHandoff,
          })
      const review = (qualityStream.result as { review?: ChapterQualityReviewPayload } | undefined)?.review
      const issues = (review?.issues ?? []) as QualityIssue[]
      quality = {
        pass: recomputeQualityPass(issues, qualitySettings.qualityReviewMaxWarnings),
        issues,
      }
      lastQualityIssues = issues
    }

    input.onProgress?.({
      step: 'audit',
      label: round === 0 ? '正在审计章节质量...' : `第 ${round} 轮复审计...`,
    })
    const auditUserTurn = buildAuditPhaseInstruction(input.targetWordCount)
    const auditStream = useSession
      ? await input.streamSessionPhase!({
          phase: 'chapter-audit',
          session: input.session!,
          userTurn: auditUserTurn,
        })
      : await input.streamTask!('chapter-audit', {
          ...input.memoBaseContext,
          projectId: input.projectId,
          chapterId: input.chapterId,
          chapterTitle: input.chapterTitle,
          targetWordCount: input.targetWordCount,
          draftText: content,
          chapterMemo: input.chapterMemo,
          previousChapterHandoff: input.productionContext.previousChapterHandoff,
          currentOutlineItem: input.productionContext.currentOutlineItem,
          outlineChapterSplit: input.productionContext.outlineChapterSplit,
        })
    audit = (auditStream.result as { audit?: ChapterAuditPayload } | undefined)?.audit ?? null
    if (!audit) break

    const gate = evaluateUnifiedFinalGate(
      plain.length,
      input.targetWordCount,
      deps.wordTolerancePercent,
      { preflight, quality, audit },
      input.qualityConfig,
    )

    if (gate.pass) {
      return { content, finalGatePass: true, audit, qualityIssues: lastQualityIssues }
    }
    if (round >= input.maxRounds) {
      return { content, finalGatePass: false, audit, qualityIssues: lastQualityIssues }
    }

    const mergedRepairIssues = prioritizeRepairIssues(
      collectContractRepairIssues(preflight.issues, audit.issues ?? []).filter(
        (issue) => issue.severity !== 'hint',
      ),
      6,
    )

    const repairPlan = deps.filterGateIssuesForRepair(gate.issues, content, input.targetWordCount)

    input.onProgress?.({
      step: 'final-gate',
      label: `质检未通过（${gate.issues.slice(0, 3).join('；')}）`,
    })

    if (mergedRepairIssues.length === 0) {
      content = deps.fitDraftToWordBounds(content, input.targetWordCount)
      continue
    }

    const repairIssues = formatQualityIssuesForRepair(
      gate.repairIssues.length > 0 ? gate.repairIssues : mergedRepairIssues,
    )

    input.onProgress?.({
      step: 'repair',
      label: `发现 ${repairIssues.length} 个问题，正在修复...`,
    })

    const repairUserTurn = buildRepairPhaseInstruction(repairIssues, repairPlan.wordCountStrict)
    const repairStream = useSession
      ? await input.streamSessionPhase!({
          phase: 'chapter-repair',
          session: input.session!,
          userTurn: repairUserTurn,
        })
      : await input.streamTask!('chapter-repair', deps.buildChapterRepairContext({
          ...input.repairContextBase,
          chapterContent: content,
          targetWordCount: input.targetWordCount,
          auditIssues: repairIssues,
          chapterMemoText: input.chapterMemo ? deps.formatMemoForRepair(input.chapterMemo) : '',
          repairWordCountStrict: repairPlan.wordCountStrict,
        }))
    const repairedText = repairStream.text.trim()
    const beforeLen = plain.length
    if (repairedText && repairedText.length > content.length * 0.5) content = repairedText
    const fitted = deps.fitDraftToWordBounds(content, input.targetWordCount)
    if (fitted.length < beforeLen) content = fitted
    if (repairedText && content.trim()) {
      input.onDraftRepaired?.(content)
    }
  }

  return { content, finalGatePass: false, audit, qualityIssues: lastQualityIssues }
}

export { resolveMaxRepairRounds }
