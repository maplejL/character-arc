export const DEFAULT_CHAPTER_WORD_TARGET = '3000'
export const MAX_REASONABLE_CHAPTER_WORDS = 10_000
const ABSOLUTE_MAX_WORD_TARGET = 50_000

export type WordTargetIssue =
  | 'empty'
  | 'concatenated_range'
  | 'too_large'
  | 'non_numeric'
  | 'invalid_range'

export type WordTargetInferenceContext = {
  /** 同卷其他节点/章节的字数，用于推断 */
  siblingWordTargets?: Array<string | number | null | undefined>
  /** 无上下文时的兜底值 */
  defaultCount?: number
}

export type WordTargetValidation = {
  raw: string
  parsed: number
  normalized: string
  issue?: WordTargetIssue
  inferred: boolean
  message?: string
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

export function validateChapterWordTarget(
  value?: string | number | null,
  context?: WordTargetInferenceContext,
): WordTargetValidation {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const parsed = clampWordTarget(Math.round(value))
    if (parsed > MAX_REASONABLE_CHAPTER_WORDS) {
      return {
        raw: String(value),
        parsed: inferFromContext(context),
        normalized: String(inferFromContext(context)),
        issue: 'too_large',
        inferred: true,
        message: `章节字数 ${parsed} 超出合理上限，已按上下文推断`,
      }
    }
    return { raw: String(value), parsed, normalized: String(parsed), inferred: false }
  }

  const raw = typeof value === 'string' ? value.trim() : String(value ?? '').trim()
  if (!raw) {
    const parsed = inferFromContext(context)
    return {
      raw: '',
      parsed,
      normalized: String(parsed),
      issue: 'empty',
      inferred: true,
      message: '未设置预估字数，已按上下文推断',
    }
  }

  if (/(\d+)\s*[–\-~～—]\s*(\d+)\s*章/.test(raw) || /(\d+)\s*章/.test(raw)) {
    const parsed = inferFromContext(context)
    return { raw, parsed, normalized: raw, inferred: false }
  }

  const wan = raw.match(/(\d+(?:\.\d+)?)\s*万/)
  if (wan) {
    const parsed = clampWordTarget(Math.round(Number(wan[1]) * 10_000))
    return { raw, parsed, normalized: raw, inferred: false }
  }

  const range = raw.match(/(\d{3,5})\s*[-~～—–至到]\s*(\d{3,5})/)
  if (range) {
    const lo = Number.parseInt(range[1]!, 10)
    const hi = Number.parseInt(range[2]!, 10)
    const parsed = clampWordTarget(hi >= lo ? Math.round((lo + hi) / 2) : lo)
    if (parsed > MAX_REASONABLE_CHAPTER_WORDS) {
      const inferred = inferFromContext(context)
      return {
        raw,
        parsed: inferred,
        normalized: String(inferred),
        issue: 'too_large',
        inferred: true,
        message: `区间 ${lo}-${hi} 不合理，已按上下文推断`,
      }
    }
    return {
      raw,
      parsed,
      normalized: hi >= lo ? `${lo}-${hi}` : String(lo),
      inferred: false,
    }
  }

  const single = raw.match(/(\d{3,5})/)
  if (single && /^\D*\d{3,5}\D*$/.test(raw.replace(/\s/g, ''))) {
    const parsed = clampWordTarget(Number.parseInt(single[1]!, 10))
    if (parsed > MAX_REASONABLE_CHAPTER_WORDS) {
      const inferred = inferFromContext(context)
      return {
        raw,
        parsed: inferred,
        normalized: String(inferred),
        issue: 'too_large',
        inferred: true,
        message: `章节字数 ${parsed} 超出合理上限，已按上下文推断`,
      }
    }
    return { raw, parsed, normalized: String(parsed), inferred: false }
  }

  const digits = raw.replace(/\D/g, '')
  if (digits) {
    const concatenated = tryParseConcatenatedRange(digits)
    if (concatenated) {
      const parsed = clampWordTarget(Math.round((concatenated.lo + concatenated.hi) / 2))
      return {
        raw,
        parsed,
        normalized: `${concatenated.lo}-${concatenated.hi}`,
        issue: 'concatenated_range',
        inferred: false,
        message: `疑似将「${concatenated.lo}-${concatenated.hi}」误写为 ${digits}`,
      }
    }

    const asInt = Number.parseInt(digits, 10)
    if (asInt <= ABSOLUTE_MAX_WORD_TARGET) {
      if (asInt > MAX_REASONABLE_CHAPTER_WORDS) {
        const inferred = inferFromContext(context)
        return {
          raw,
          parsed: inferred,
          normalized: String(inferred),
          issue: 'too_large',
          inferred: true,
          message: `章节字数 ${asInt} 超出合理上限，已按上下文推断`,
        }
      }
      return { raw, parsed: clampWordTarget(asInt), normalized: String(asInt), inferred: false }
    }

    const head = digits.match(/^(\d{4,5})/)
    const parsed = clampWordTarget(head ? Number.parseInt(head[1]!, 10) : inferFromContext(context))
    return {
      raw,
      parsed,
      normalized: String(parsed),
      issue: 'concatenated_range',
      inferred: !head,
      message: head ? `疑似区间误拼，已取 ${parsed}` : '无法解析字数，已按上下文推断',
    }
  }

  const parsed = inferFromContext(context)
  return {
    raw,
    parsed,
    normalized: String(parsed),
    issue: 'non_numeric',
    inferred: true,
    message: '预估字数不是有效数字，已按上下文推断',
  }
}

export function parseChapterWordTarget(
  value?: string | number | null,
  context?: WordTargetInferenceContext,
): number {
  return validateChapterWordTarget(value, context).parsed
}

export function normalizeChapterWordTarget(
  value?: string | number | null,
  context?: WordTargetInferenceContext,
): string {
  return validateChapterWordTarget(value, context).normalized
}

export function formatChapterWordTargetLabel(value?: string | number | null): string {
  const chapterPlan = formatOutlinePlannedChapterLabel(value)
  if (chapterPlan) return chapterPlan
  const validation = validateChapterWordTarget(value)
  if (validation.issue === 'concatenated_range' && validation.normalized.includes('-')) {
    return `${validation.normalized}字（约 ${validation.parsed}）`
  }
  return `${validation.parsed}字`
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
  if (isOutlineChapterCountTarget(chapterWordTarget)) {
    return parseChapterWordTarget(undefined, context)
  }
  return parseChapterWordTarget(chapterWordTarget, context)
}

export function shouldSkipOutlineNodeForAutoCreation(item: {
  title?: string
  wordTarget?: string
}): boolean {
  const title = (item.title ?? '').trim()
  const wordTarget = (item.wordTarget ?? '').trim()
  if (/索引条|非单章|写作索引/.test(wordTarget)) return true
  if (/正史总览|写作索引|章级索引/.test(title)) return true
  return false
}

/** 大纲节点 wordTarget 里写的规划章数，如「3–5章」「20–30章」；纯字数描述返回 1 */
export function parseOutlinePlannedChapterCount(value?: string | number | null): number {
  const raw = typeof value === 'string' ? value.trim() : String(value ?? '').trim()
  if (!raw) return 1

  const rangeChapter = raw.match(/(\d+)\s*[–\-~～—]\s*(\d+)\s*章/)
  if (rangeChapter) {
    const lo = Number.parseInt(rangeChapter[1]!, 10)
    const hi = Number.parseInt(rangeChapter[2]!, 10)
    if (hi >= lo) return Math.max(1, Math.round((lo + hi) / 2))
    return Math.max(1, lo)
  }

  const singleChapter = raw.match(/(\d+)\s*章/)
  if (singleChapter) return Math.max(1, Number.parseInt(singleChapter[1]!, 10))

  return 1
}

export function isOutlineChapterCountTarget(value?: string | number | null): boolean {
  const raw = typeof value === 'string' ? value.trim() : String(value ?? '').trim()
  return /章/.test(raw) && parseOutlinePlannedChapterCount(raw) >= 1 && !/^\d+\s*[-–—~～]?\s*\d+$/.test(raw.replace(/章.*$/, ''))
}

export function formatOutlinePlannedChapterLabel(value?: string | number | null): string | null {
  const raw = typeof value === 'string' ? value.trim() : String(value ?? '').trim()
  if (!isOutlineChapterCountTarget(raw)) return null
  const count = parseOutlinePlannedChapterCount(raw)
  const range = raw.match(/(\d+)\s*[–\-~～—]\s*(\d+)\s*章/)
  if (range) return `规划 ${range[1]}–${range[2]} 章（队列按 ${count} 章计）`
  return `规划 ${count} 章`
}
