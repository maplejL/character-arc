import type {
  AutoCreationQualityConfig,
  ChapterAuditPayload,
  QualityCheckResult,
  QualityIssue,
} from './types.js'
import { resolveQualityConfig } from './types.js'

export function countIssuesBySeverity(issues: QualityIssue[]): {
  critical: number
  warning: number
  hint: number
} {
  return issues.reduce(
    (acc, issue) => {
      if (issue.severity === 'critical') acc.critical += 1
      else if (issue.severity === 'warning') acc.warning += 1
      else acc.hint += 1
      return acc
    },
    { critical: 0, warning: 0, hint: 0 },
  )
}

export function recomputeQualityPass(
  issues: QualityIssue[],
  maxWarnings: number,
): boolean {
  const counts = countIssuesBySeverity(issues)
  return counts.critical === 0 && counts.warning <= maxWarnings
}

export function recomputeAuditPass(issues: QualityIssue[], maxWarnings = 2): boolean {
  return recomputeQualityPass(issues, maxWarnings)
}

function isInvalidEndingChangeAuditIssue(issue: QualityIssue): boolean {
  if (issue.category !== 'ending-change') return false
  const text = `${issue.ref} ${issue.hint ?? ''}`
  return (
    text.includes('[object Object]')
    || text.includes('无法确认')
    || text.includes('格式错误')
    || text.includes('无效占位')
    || text.includes('数组为空')
  )
}

export function mergeQualityIssues(
  ...groups: Array<QualityIssue[] | undefined>
): QualityIssue[] {
  const merged: QualityIssue[] = []
  const seen = new Set<string>()
  for (const group of groups) {
    for (const issue of group ?? []) {
      const key = `${issue.severity}|${issue.category}|${issue.ref}`
      if (seen.has(key)) continue
      seen.add(key)
      merged.push(issue)
    }
  }
  return merged.sort((a, b) => {
    const rank = (severity: string) => (severity === 'critical' ? 0 : severity === 'warning' ? 1 : 2)
    return rank(a.severity) - rank(b.severity)
  })
}

export function qualityIssueToRepairHint(issue: QualityIssue): string {
  return issue.repairAction?.trim() || issue.hint?.trim() || issue.ref
}

export function formatQualityIssuesForRepair(
  issues: QualityIssue[],
): Array<{ severity: 'critical' | 'warning' | 'hint'; category: string; ref: string; hint: string }> {
  return issues.map((issue) => ({
    severity: (issue.severity === 'warning' || issue.severity === 'hint' ? issue.severity : 'critical'),
    category: issue.category,
    ref: issue.ref,
    hint: qualityIssueToRepairHint(issue),
  }))
}

export type UnifiedGateInput = {
  preflight: QualityCheckResult
  quality: QualityCheckResult
  audit: ChapterAuditPayload | null
}

export type UnifiedGateResult = {
  pass: boolean
  wordCountOk: boolean
  issues: string[]
  repairIssues: QualityIssue[]
}

const CONTRACT_CRITICAL_CATEGORIES = new Set([
  'payoff',
  'ending-change',
  'do-not-do',
  'word-count',
  'hold',
  'hard-rule',
  'opening-hook',
  'ending-hook',
  'opening-recycle',
  'adjacent-opening-recycle',
  'outline-scope',
  'outline-miss',
  'plot-drift',
  'character-ooc',
  'relation-drift',
  'continuity',
  'forbidden-advance',
])

function repairIssuePriority(issue: QualityIssue): number {
  if (issue.severity === 'critical' && CONTRACT_CRITICAL_CATEGORIES.has(issue.category)) return 0
  if (issue.severity === 'critical') return 1
  if (issue.severity === 'warning' && CONTRACT_CRITICAL_CATEGORIES.has(issue.category)) return 2
  if (issue.severity === 'warning') return 3
  return 4
}

/** 每轮修复只处理最高优先级的若干条，避免单次修订任务过载。 */
export function prioritizeRepairIssues(issues: QualityIssue[], maxIssues = 6): QualityIssue[] {
  return [...issues]
    .sort((a, b) => repairIssuePriority(a) - repairIssuePriority(b))
    .slice(0, maxIssues)
}

/** 契约返修队列：preflight 硬规则 + 契约审计；不含网文体检（quality-review）项。 */
export function collectContractRepairIssues(
  preflightIssues: QualityIssue[],
  auditIssues: QualityIssue[],
): QualityIssue[] {
  const preflightCritical = preflightIssues.filter((issue) => issue.severity === 'critical')
  const auditRepairable = auditIssues.filter(
    (issue) =>
      issue.severity === 'critical'
      || (issue.severity === 'warning' && CONTRACT_CRITICAL_CATEGORIES.has(issue.category)),
  )
  return mergeQualityIssues(preflightCritical, auditRepairable)
}

const POLISH_HINT_CATEGORY_ORDER = [
  'ending-hook',
  'pacing-flat',
  'conflict-stake',
  'literary-register',
  'tell-not-show',
  'dialogue-ratio',
  'imagery-density',
  'template-closing',
  'exposition-dialogue',
  'cross-chapter-recycle',
]

/** 从网文体检 issues 中抽取终稿润色提示（不进入契约返修）。 */
export function pickPolishHints(issues: QualityIssue[], maxHints = 3): string[] {
  const rank = (category: string) => {
    const index = POLISH_HINT_CATEGORY_ORDER.indexOf(category)
    return index === -1 ? POLISH_HINT_CATEGORY_ORDER.length : index
  }
  return [...issues]
    .filter((issue) => issue.severity !== 'hint')
    .sort((a, b) => {
      const severityRank = (severity: string) => (severity === 'critical' ? 0 : severity === 'warning' ? 1 : 2)
      const diff = severityRank(a.severity) - severityRank(b.severity)
      if (diff !== 0) return diff
      return rank(a.category) - rank(b.category)
    })
    .slice(0, maxHints)
    .map((issue) => issue.repairAction?.trim() || issue.hint?.trim() || issue.ref?.trim())
    .filter(Boolean)
}

export function evaluateUnifiedFinalGate(
  actualWordCount: number,
  targetWordCount: number,
  tolerancePercent: number,
  input: UnifiedGateInput,
  config?: AutoCreationQualityConfig,
): UnifiedGateResult {
  const qualityConfig = resolveQualityConfig(config)
  const min = Math.round(targetWordCount * (1 - tolerancePercent / 100))
  const max = Math.round(targetWordCount * (1 + tolerancePercent / 100))
  const wordCountOk = actualWordCount >= min && actualWordCount <= max

  const auditIssues = (input.audit?.issues ?? []).filter((issue) => !isInvalidEndingChangeAuditIssue(issue))
  const mergedForRepair = collectContractRepairIssues(input.preflight.issues, auditIssues)
  const preflightCritical = (input.preflight.issues ?? []).filter((issue) => issue.severity === 'critical')
  const auditPass = recomputeAuditPass(auditIssues)

  const issues: string[] = []
  if (!wordCountOk) {
    issues.push(`字数 ${actualWordCount} 不在目标 ${targetWordCount} 的 ±${tolerancePercent}% 范围内（${min}–${max}）`)
  }
  if (preflightCritical.length > 0) {
    issues.push(...preflightCritical.map((issue) => `[硬规则] ${qualityIssueToRepairHint(issue)}`))
  }
  if (!auditPass) {
    issues.push(
      ...auditIssues
        .filter((issue) => issue.severity === 'critical' || issue.severity === 'warning')
        .slice(0, 6)
        .map((issue) => `[契约] ${qualityIssueToRepairHint(issue)}`),
    )
  }

  const warningOverflow =
    auditIssues.filter((issue) => issue.severity === 'warning').length
    > qualityConfig.qualityReviewMaxWarnings
  if (warningOverflow && !auditPass) {
    issues.push('[警告] 契约审计未解决问题过多，需继续修订')
  }

  // 终检以契约审计 + 字数 + preflight 硬规则为准；网文体检 issue 留给终稿润色，不进返修环。
  const pass = wordCountOk && auditPass && preflightCritical.length === 0

  const repairIssues = prioritizeRepairIssues(
    mergedForRepair.filter((issue) => issue.severity !== 'hint'),
    6,
  )

  return {
    pass,
    wordCountOk,
    issues,
    repairIssues,
  }
}

export function formatUnifiedGateIssuesForRepair(issues: string[]): Array<{
  severity: 'critical'
  category: string
  ref: string
  hint: string
}> {
  return issues.map((issue) => ({
    severity: 'critical' as const,
    category: 'final-gate',
    ref: issue,
    hint: issue,
  }))
}
