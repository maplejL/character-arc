import {
  evaluateUnifiedFinalGate,
  formatQualityIssuesForRepair,
  collectContractRepairIssues,
  prioritizeRepairIssues,
  recomputeQualityPass,
} from './convergence.js'
import { evaluateDraftPreflight, evaluateDeterministicHardRules } from './preflight.js'
import { resolveQualityConfig, resolveMaxRepairRounds } from './types.js'
import type {
  AutoCreationQualityConfig,
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

export type ChapterAuditPayload = {
  pass: boolean
  issues: QualityIssue[]
  wordCount?: number
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
      /** 当轮被审/被修的正文，用于证据校验 */
      draftText?: string
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
  /** 非质量原因的终止：audit-error 等；正常走质量路径时为 null */
  abortReason?: 'audit-error' | 'repair-error' | null
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
    // 确定性硬规则兜底：字数/破折号/分隔符/日式引号/疲劳词；与 preflight 合并进 gate
    const deterministicIssues = evaluateDeterministicHardRules(content, {
      targetWordCount: input.targetWordCount,
      wordTolerancePercent: deps.wordTolerancePercent,
    })
    const preflightMerged = {
      pass: preflight.pass && !deterministicIssues.some((i) => i.severity === 'critical'),
      issues: [...preflight.issues, ...deterministicIssues],
    }

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
          draftText: content,
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
    if (!audit) {
      // 审查模型未返回可解析结果：这是模型/调用错误，不是"质量不达标"。
      // 不再静默当作质量失败，区分返回以便上层决定重试或换模型。
      return {
        content,
        finalGatePass: false,
        audit: null,
        qualityIssues: lastQualityIssues,
        abortReason: 'audit-error',
      }
    }

    const gate = evaluateUnifiedFinalGate(
      plain.length,
      input.targetWordCount,
      deps.wordTolerancePercent,
      { preflight: preflightMerged, quality, audit },
      input.qualityConfig,
    )

    if (gate.pass) {
      return { content, finalGatePass: true, audit, qualityIssues: lastQualityIssues, abortReason: null }
    }
    if (round >= input.maxRounds) {
      return { content, finalGatePass: false, audit, qualityIssues: lastQualityIssues, abortReason: null }
    }

    const mergedRepairIssues = prioritizeRepairIssues(
      collectContractRepairIssues(preflightMerged.issues, audit.issues ?? []).filter(
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
    if (!repairedText) {
      // 修复模型未输出有效内容：模型错误，区别于"修复后仍不达标"
      return {
        content,
        finalGatePass: false,
        audit,
        qualityIssues: lastQualityIssues,
        abortReason: 'repair-error',
      }
    }
    // 修复护栏：拒绝明显截断/畸形的输出；且修复引入的 critical 不得多于修复前，否则丢弃（防"越修越偏"）。
    const repairedPlain = deps.getPlainText(repairedText).trim()
    const preRepairCritical = gate.repairIssues.filter((i) => i.severity === 'critical').length
    const repairedDetIssues = evaluateDeterministicHardRules(repairedText, {
      targetWordCount: input.targetWordCount,
      wordTolerancePercent: deps.wordTolerancePercent,
    })
    const repairedCritical = repairedDetIssues.filter((i) => i.severity === 'critical').length
    const severeRegression = repairedCritical > preRepairCritical + 2
    const tooShort = repairedText.length < content.length * 0.5
    const suspiciouslyEmpty = repairedPlain.length < 400

    if (severeRegression || tooShort || suspiciouslyEmpty) {
      input.onProgress?.({
        step: 'final-gate',
        label: `本轮修复输出被丢弃（${
          severeRegression ? '引入更多硬规则冲突' : tooShort ? '输出过短' : '正文异常'
        }），保留上一版进入下一轮`,
      })
      continue
    }

    const beforeLen = plain.length
    if (repairedText.length > content.length * 0.5) content = repairedText
    const fitted = deps.fitDraftToWordBounds(content, input.targetWordCount)
    if (fitted.length < beforeLen) content = fitted
    if (content.trim()) {
      input.onDraftRepaired?.(content)
    }
  }

  return { content, finalGatePass: false, audit, qualityIssues: lastQualityIssues, abortReason: null }
}

export { resolveMaxRepairRounds }
