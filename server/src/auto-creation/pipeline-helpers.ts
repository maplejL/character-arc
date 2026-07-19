import { getPlainTextFromEditorContent } from './editor-content.js'
import {
  evaluateUnifiedFinalGate,
  formatUnifiedGateIssuesForRepair,
  recomputeAuditPass,
} from './shared/convergence.js'
import type { QualityCheckResult, QualityIssue } from './shared/types.js'

export type ChapterAuditPayload = {
  pass: boolean
  issues: QualityIssue[]
  wordCount?: number
}

export type KnowledgeDocument = {
  id: string
  title: string
  sourceType: string
  sourceLabel: string
  content: string
  summary?: string
  keywords?: string[]
  metadata?: Record<string, unknown>
  createdAt?: string
  updatedAt?: string
  projectId?: string
}

const NEXT_ADVICE_PREFIX = '下章建议：'
const MAX_REASONABLE_CHAPTER_WORDS = 10_000
const ABSOLUTE_MAX_WORD_TARGET = 50_000

type WordTargetInferenceContext = {
  siblingWordTargets?: Array<string | number | null | undefined>
  defaultCount?: number
}

function clampWordTarget(value: number): number {
  if (!Number.isFinite(value) || value < 1) return 3000
  return Math.min(value, ABSOLUTE_MAX_WORD_TARGET)
}

function inferFromContext(context?: WordTargetInferenceContext): number {
  const fallback = context?.defaultCount ?? 3000
  const siblings = (context?.siblingWordTargets ?? [])
    .map((item) => parseChapterWordTarget(item))
    .filter((value) => value >= 500 && value <= MAX_REASONABLE_CHAPTER_WORDS)
  if (siblings.length === 0) return fallback
  return clampWordTarget(Math.round(siblings.reduce((sum, value) => sum + value, 0) / siblings.length))
}

function tryParseConcatenatedRange(digits: string): { lo: number; hi: number } | null {
  if (digits.length < 7 || digits.length > 10) return null
  for (let split = 4; split <= 5; split += 1) {
    if (split >= digits.length) continue
    const lo = Number.parseInt(digits.slice(0, split), 10)
    const hi = Number.parseInt(digits.slice(split), 10)
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) continue
    if (lo < 500 || hi < 500) continue
    if (lo > MAX_REASONABLE_CHAPTER_WORDS || hi > MAX_REASONABLE_CHAPTER_WORDS) continue
    if (hi < lo) continue
    return { lo, hi }
  }
  return null
}

export function parseChapterWordTarget(
  value?: string | number | null,
  context?: WordTargetInferenceContext,
): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const parsed = clampWordTarget(Math.round(value))
    if (parsed > MAX_REASONABLE_CHAPTER_WORDS) return inferFromContext(context)
    return parsed
  }

  const raw = typeof value === 'string' ? value.trim() : String(value ?? '').trim()
  if (!raw) return inferFromContext(context)

  const wan = raw.match(/(\d+(?:\.\d+)?)\s*万/)
  if (wan) return clampWordTarget(Math.round(Number(wan[1]) * 10_000))

  const range = raw.match(/(\d{3,5})\s*[-~～—–至到]\s*(\d{3,5})/)
  if (range) {
    const lo = Number.parseInt(range[1]!, 10)
    const hi = Number.parseInt(range[2]!, 10)
    const parsed = clampWordTarget(hi >= lo ? Math.round((lo + hi) / 2) : lo)
    if (parsed > MAX_REASONABLE_CHAPTER_WORDS) return inferFromContext(context)
    return parsed
  }

  const single = raw.match(/(\d{3,5})/)
  if (single && /^\D*\d{3,5}\D*$/.test(raw.replace(/\s/g, ''))) {
    const parsed = clampWordTarget(Number.parseInt(single[1]!, 10))
    if (parsed > MAX_REASONABLE_CHAPTER_WORDS) return inferFromContext(context)
    return parsed
  }

  const digits = raw.replace(/\D/g, '')
  if (!digits) return inferFromContext(context)

  const concatenated = tryParseConcatenatedRange(digits)
  if (concatenated) {
    return clampWordTarget(Math.round((concatenated.lo + concatenated.hi) / 2))
  }

  const asInt = Number.parseInt(digits, 10)
  if (asInt <= ABSOLUTE_MAX_WORD_TARGET) {
    if (asInt > MAX_REASONABLE_CHAPTER_WORDS) return inferFromContext(context)
    return clampWordTarget(asInt)
  }

  const head = digits.match(/^(\d{4,5})/)
  return clampWordTarget(head ? Number.parseInt(head[1]!, 10) : inferFromContext(context))
}

export type AutoCreationWordTargetConfig = {
  targetWordCount?: number
  forcedWordCountMin?: number
  forcedWordCountMax?: number
}

export function resolveAutoCreationWordTarget(
  config: AutoCreationWordTargetConfig,
  chapterWordTarget?: string | number | null,
  context?: WordTargetInferenceContext,
): number {
  const min = config.forcedWordCountMin
  const max = config.forcedWordCountMax
  if (typeof min === 'number' && typeof max === 'number' && min > 0 && max >= min) {
    return clampWordTarget(Math.round((min + max) / 2))
  }
  if (typeof config.targetWordCount === 'number' && config.targetWordCount > 0) {
    return clampWordTarget(Math.round(config.targetWordCount))
  }
  return parseChapterWordTarget(chapterWordTarget, context)
}

export function extractNextChapterAdviceFromJournal(document: KnowledgeDocument): string {
  const summary = document.summary?.trim()
  if (summary) return summary
  const content = document.content ?? ''
  const markerIndex = content.indexOf(NEXT_ADVICE_PREFIX)
  if (markerIndex >= 0) return content.slice(markerIndex + NEXT_ADVICE_PREFIX.length).trim()
  return content.trim()
}

export function findWritingJournalForChapter(
  knowledgeDocuments: KnowledgeDocument[],
  chapterId: string,
): KnowledgeDocument | undefined {
  return knowledgeDocuments.find(
    (document) =>
      document.sourceLabel === 'writing-journal'
      && String(document.metadata?.chapterId ?? '') === chapterId,
  )
}

export function isChapterAcceptanceRecorded(
  knowledgeDocuments: KnowledgeDocument[],
  chapterId: string,
): boolean {
  const journal = findWritingJournalForChapter(knowledgeDocuments, chapterId)
  return Boolean(journal?.metadata?.autoAcceptancePassed)
}

export function loadPreviousChapterAdvice(
  chapters: Array<{ id: string; content?: string }>,
  knowledgeDocuments: KnowledgeDocument[],
  currentChapterId: string,
): string | undefined {
  const currentIndex = chapters.findIndex((chapter) => chapter.id === currentChapterId)
  if (currentIndex <= 0) return undefined
  for (const chapter of chapters.slice(0, currentIndex).reverse()) {
    if (!getPlainTextFromEditorContent(chapter.content ?? '').trim()) continue
    const journal = findWritingJournalForChapter(knowledgeDocuments, chapter.id)
    if (!journal) continue
    const advice = extractNextChapterAdviceFromJournal(journal)
    if (advice) return advice
  }
  return undefined
}

export function evaluateChapterAcceptanceSync(
  chapter: { id: string; content?: string },
  knowledgeDocuments: KnowledgeDocument[],
): { satisfied: boolean; hasBody: boolean } {
  const hasBody = getPlainTextFromEditorContent(chapter.content ?? '').trim().length >= 50
  if (!hasBody) return { satisfied: false, hasBody: false }
  return { satisfied: isChapterAcceptanceRecorded(knowledgeDocuments, chapter.id), hasBody: true }
}

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
  /** 大纲/角色等剧情约束，修复时必须作为基准注入 */
  storyConstraintContext?: Record<string, unknown>
  /** 允许透传 memoBaseContext 中的大纲/角色/接续等字段 */
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

export function formatMemoForRepair(memo: Record<string, unknown>): string {
  const normalized = normalizeChapterMemo(memo) ?? memo
  const parts: string[] = []
  if (normalized.currentTask) parts.push(`任务：${normalized.currentTask}`)
  if (normalized.emotionArc) parts.push(`情绪轨迹：${normalized.emotionArc}`)
  if (Array.isArray(normalized.payoffs) && normalized.payoffs.length > 0) {
    parts.push(`兑现：${normalized.payoffs.join('；')}`)
  }
  if (Array.isArray(normalized.holds) && normalized.holds.length > 0) {
    parts.push(`暂不掀：${normalized.holds.join('；')}`)
  }
  if (Array.isArray(normalized.endingChanges) && normalized.endingChanges.length > 0) {
    parts.push(`章末改变：${normalized.endingChanges.join('；')}`)
  }
  if (Array.isArray(normalized.doNotDo) && normalized.doNotDo.length > 0) {
    parts.push(`红线：${normalized.doNotDo.join('；')}`)
  }
  return parts.join('\n')
}

export function buildReferenceStyleContext(
  selectedRefIds: string[],
  referenceWorks: Array<{ id: string; title: string; analysis?: Record<string, unknown> }>,
  knowledgeDocuments: KnowledgeDocument[],
): string {
  if (!selectedRefIds.length) return ''
  const selectedWorks = referenceWorks.filter((work) => selectedRefIds.includes(work.id))
  if (!selectedWorks.length) return ''
  const summaryByTitle = new Map<string, { summary?: string; content: string }>()
  for (const document of knowledgeDocuments) {
    if (document.sourceType !== 'reference-summary') continue
    const title = String(document.metadata?.sourceTitle ?? '').trim()
    if (title && !summaryByTitle.has(title)) summaryByTitle.set(title, document)
  }
  const parts: string[] = []
  let totalChars = 0
  for (const work of selectedWorks.slice(0, 3)) {
    const analysis = work.analysis ?? {}
    const lines: string[] = []
    for (const key of [
      'overview',
      'sentenceStyle',
      'dialogueRatio',
      'pacingControl',
      'reusableStylePrompt',
    ] as const) {
      const value = analysis[key]
      if (typeof value === 'string' && value.trim()) lines.push(String(value))
    }
    if (!lines.length) continue
    const block = `【${work.title}】\n${lines.join('\n')}`
    if (totalChars + block.length > 1800) break
    parts.push(block)
    totalChars += block.length
  }
  return parts.join('\n\n')
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

export function formatAuditIssuesForRepair(
  issues: Array<{ severity: string; category: string; ref: string; hint: string }>,
): Array<{ severity: 'critical' | 'warning' | 'hint'; category: string; ref: string; hint: string }> {
  return issues.map((issue) => ({
    severity: (issue.severity === 'warning' || issue.severity === 'hint' ? issue.severity : 'critical') as
      | 'critical'
      | 'warning'
      | 'hint',
    category: issue.category,
    ref: issue.ref,
    hint: issue.hint,
  }))
}

export function evaluateFinalGate(
  content: string,
  targetWordCount: number,
  audit: ChapterAuditPayload,
  options?: {
    preflight?: { pass: boolean; issues: ChapterAuditPayload['issues'] }
    quality?: { pass: boolean; issues: ChapterAuditPayload['issues'] }
    qualityConfig?: import('./shared/types.js').AutoCreationQualityConfig
  },
): { pass: boolean; issues: string[] } {
  const plain = getPlainTextFromEditorContent(content).trim()
  const gate = evaluateUnifiedFinalGate(
    plain.length,
    targetWordCount,
    AUTO_CREATION_WORD_TOLERANCE * 100,
    {
      preflight: options?.preflight ?? { pass: true, issues: [] as QualityIssue[] },
      quality: options?.quality ?? { pass: true, issues: [] as QualityIssue[] },
      audit,
    },
    options?.qualityConfig,
  )
  return { pass: gate.pass, issues: gate.issues }
}

export { recomputeAuditPass }

export function formatFinalGateIssuesForRepair(issues: string[]): Array<{
  severity: 'critical'
  category: string
  ref: string
  hint: string
}> {
  return formatUnifiedGateIssuesForRepair(issues)
}

export function buildProjectWritingStyleContext(project: {
  writingStylePresetId?: string
  writingStylePrompt?: string
}): { label: string; prompt: string } {
  const prompt = project.writingStylePrompt?.trim()
  return {
    label: project.writingStylePresetId ?? 'cinematic-cool',
    prompt:
      prompt
      || '整体写作风格偏冷峻电影感。句子干净克制，画面构图清晰，细节以光线、动作、材质和环境声推进，不要过度抒情。',
  }
}
