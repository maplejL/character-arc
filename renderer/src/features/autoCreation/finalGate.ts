import { getPlainTextFromEditorContent } from '@/features/chapters/editorContent'
import {
  evaluateUnifiedFinalGate as evaluateUnifiedGate,
  formatUnifiedGateIssuesForRepair,
} from '@shared/auto-creation/convergence'
import type { ChapterAuditPayload } from '@/components/chapterWorkspace/useChapterFirstDraft'
import type { FinalGateResult } from '@/features/autoCreation/types'

export const AUTO_CREATION_WORD_TOLERANCE = 0.25

function coerceMemoStringEntry(value: unknown): string {
  if (typeof value === 'string') {
    const text = value.trim()
    return text === '[object Object]' ? '' : text
  }
  if (value && typeof value === 'object') {
    const item = value as Record<string, unknown>
    const type = String(item.type ?? item.changeType ?? '').trim()
    const desc = String(item.description ?? item.change ?? item.text ?? item.content ?? '').trim()
    const combined = [type, desc].filter(Boolean).join('：')
    return combined.trim()
  }
  const text = String(value ?? '').trim()
  return text === '[object Object]' ? '' : text
}

export function coerceMemoStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map(coerceMemoStringEntry).filter(Boolean)
}

export function normalizeChapterMemo<T extends Record<string, unknown>>(memo: T | undefined): T | undefined {
  if (!memo) return memo
  return {
    ...memo,
    payoffs: coerceMemoStringArray(memo.payoffs),
    holds: coerceMemoStringArray(memo.holds),
    decisionChecks: coerceMemoStringArray(memo.decisionChecks),
    endingChanges: coerceMemoStringArray(memo.endingChanges),
    doNotDo: coerceMemoStringArray(memo.doNotDo),
  }
}

export function normalizeDraftForAutoCreation(content: string): string {
  return getPlainTextFromEditorContent(content)
    .replace(/——/g, '，')
    .replace(/—/g, '，')
    .trim()
}

export function getAutoCreationWordBounds(targetWordCount: number): { min: number; max: number } {
  return {
    min: Math.round(targetWordCount * (1 - AUTO_CREATION_WORD_TOLERANCE)),
    max: Math.round(targetWordCount * (1 + AUTO_CREATION_WORD_TOLERANCE)),
  }
}

function isInvalidEndingChangeAuditIssue(issue: { category: string; ref: string; hint?: string }): boolean {
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

export function fitDraftToWordBounds(content: string, targetWordCount: number): string {
  let plain = normalizeDraftForAutoCreation(content)
  const { max } = getAutoCreationWordBounds(targetWordCount)
  if (plain.length <= max) return plain

  const paragraphs = plain.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean)
  if (paragraphs.length === 0) return plain.slice(0, max)

  while (paragraphs.join('\n\n').length > max && paragraphs.length > 4) {
    const removeAt = Math.max(2, Math.floor(paragraphs.length / 2))
    paragraphs.splice(removeAt, 1)
  }
  plain = paragraphs.join('\n\n').trim()
  if (plain.length <= max) return plain

  plain = plain.slice(0, max)
  const cut = Math.max(
    plain.lastIndexOf('。'),
    plain.lastIndexOf('！'),
    plain.lastIndexOf('？'),
    plain.lastIndexOf('」'),
    plain.lastIndexOf('”'),
  )
  if (cut > max * 0.75) return plain.slice(0, cut + 1).trim()
  return plain.trim()
}

export function filterGateIssuesForRepair(
  issues: string[],
  content: string,
  targetWordCount: number,
): { issues: string[]; wordCountStrict: boolean } {
  const { min, max } = getAutoCreationWordBounds(targetWordCount)
  const count = getPlainTextFromEditorContent(content).trim().length
  const wordCountOutOfBounds = count > max || count < min
  const wordIssues = issues.filter((issue) => issue.includes('字数'))
  const structuralIssues = issues.filter((issue) => !issue.includes('字数'))
  if (wordCountOutOfBounds && wordIssues.length > 0) {
    return {
      issues: [...wordIssues, ...structuralIssues.slice(0, 4)],
      wordCountStrict: true,
    }
  }
  return { issues: structuralIssues, wordCountStrict: false }
}

export function evaluateFinalGate(
  content: string,
  targetWordCount: number,
  audit: ChapterAuditPayload,
  options?: {
    preflight?: { pass: boolean; issues: ChapterAuditPayload['issues'] }
    quality?: { pass: boolean; issues: ChapterAuditPayload['issues'] }
    qualityConfig?: import('@shared/auto-creation/types').AutoCreationQualityConfig
  },
): FinalGateResult {
  const plain = getPlainTextFromEditorContent(content).trim()
  const gate = evaluateUnifiedGate(
    plain.length,
    targetWordCount,
    AUTO_CREATION_WORD_TOLERANCE * 100,
    {
      preflight: options?.preflight ?? { pass: true, issues: [] },
      quality: options?.quality ?? { pass: true, issues: [] },
      audit,
    },
    options?.qualityConfig,
  )
  return {
    pass: gate.pass,
    wordCountOk: gate.wordCountOk,
    deAiOk: gate.pass || gate.issues.every((issue) => !issue.includes('[硬规则]')),
    naturalOk: gate.pass || gate.issues.every((issue) => !issue.includes('[结构]') && !issue.includes('[钩子]')),
    issues: gate.issues,
  }
}

export function formatFinalGateIssuesForRepair(issues: string[]): Array<{ severity: 'critical'; category: string; ref: string; hint: string }> {
  return formatUnifiedGateIssuesForRepair(issues)
}

export function buildChapterRepairContext(input: {
  projectId: string
  chapterTitle?: string
  chapterSummary?: string
  chapterContent: string
  projectTitle?: string
  projectGenre?: string
  writingStyleLabel?: string
  writingStylePrompt?: string
  targetWordCount: number
  auditIssues: Array<{ severity: string; category: string; ref: string; hint: string }>
  chapterMemoText?: string
  repairWordCountStrict?: boolean
  storyConstraintContext?: Record<string, unknown>
  [key: string]: unknown
}): Record<string, unknown> {
  const {
    storyConstraintContext,
    chapterMemoText,
    repairWordCountStrict,
    auditIssues,
    ...rest
  } = input
  return {
    ...(storyConstraintContext ?? {}),
    ...rest,
    targetWordCount: input.targetWordCount,
    repairWordCountStrict: repairWordCountStrict ?? false,
    auditIssues,
    chapterMemo: Boolean(chapterMemoText),
    chapterMemoText: chapterMemoText ?? '',
  }
}
