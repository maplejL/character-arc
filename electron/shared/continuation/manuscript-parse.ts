import type { ManuscriptFileInput, ManuscriptParseResult, ParsedChapterCandidate } from './types.js'

const CHAPTER_HEADING_RE =
  /^(?:第\s*([0-9０-９一二三四五六七八九十百千万两〇零]+)\s*章|Chapter\s*([0-9]+)|CHAPTER\s*([0-9]+))([^\n]*)/gim

const FILENAME_CHAPTER_RE =
  /(?:^|[_\-\s.])(?:第)?\s*([0-9０-９]{1,5})\s*(?:章|[_\-\s.])|chapter\s*[-_ ]*0*([0-9]+)/i

const LEADING_NUMBER_RE = /^0*([0-9]{1,5})(?:\D|$)/

function normalizeFullWidthDigits(value: string): string {
  return value.replace(/[０-９]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xff10 + 0x30))
}

function parseChineseInteger(value: string): number | null {
  const normalized = value.replace(/两/g, '二').replace(/[零〇]/g, '')
  if (!normalized) return 0
  const digitMap: Record<string, number> = {
    一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
  }
  const unitMap: Record<string, number> = {
    十: 10, 百: 100, 千: 1000, 万: 10000,
  }
  let total = 0
  let section = 0
  let number = 0
  let hasValue = false
  for (const char of normalized) {
    if (digitMap[char] !== undefined) {
      number = digitMap[char]
      hasValue = true
      continue
    }
    const unit = unitMap[char]
    if (!unit) return null
    hasValue = true
    if (unit === 10000) {
      section = (section + (number || 1)) * unit
      total += section
      section = 0
    } else {
      section += (number || 1) * unit
    }
    number = 0
  }
  const result = total + section + number
  return hasValue && result > 0 ? result : null
}

export function parseChapterNumberToken(raw: string): number | null {
  const normalized = normalizeFullWidthDigits(raw.trim())
  if (!normalized) return null
  if (/^\d+$/.test(normalized)) return Number.parseInt(normalized, 10)
  return parseChineseInteger(normalized)
}

export function detectChapterNumberFromFilename(name: string): number | null {
  const stem = name.replace(/\.[^.]+$/, '')
  const normalized = normalizeFullWidthDigits(stem.normalize('NFKC'))
  const match = FILENAME_CHAPTER_RE.exec(normalized)
  if (match?.[1]) return Number.parseInt(match[1], 10)
  if (match?.[2]) return Number.parseInt(match[2], 10)
  const leading = LEADING_NUMBER_RE.exec(normalized)
  if (leading?.[1]) return Number.parseInt(leading[1], 10)
  return null
}

function titleFromFilename(name: string, chapterNumber: number | null): string {
  const stem = name.replace(/\.[^.]+$/, '').trim() || name
  if (chapterNumber != null) {
    const cleaned = stem
      .replace(/^(?:第\s*)?[0-9０-９一二三四五六七八九十百千万两〇零]+\s*章?\s*[_\-\s.]*/i, '')
      .replace(/^chapter\s*[-_ ]*[0-9]+\s*/i, '')
      .trim()
    return cleaned ? `第${chapterNumber}章 ${cleaned}` : `第${chapterNumber}章`
  }
  return stem
}

function plainCharCount(text: string): number {
  return text.replace(/\s+/g, '').length
}

function finalizeCandidates(
  raw: Array<Omit<ParsedChapterCandidate, 'index' | 'charCount'>>,
  warnings: string[],
): ManuscriptParseResult {
  const chapters: ParsedChapterCandidate[] = raw
    .map((item) => ({
      ...item,
      plainText: item.plainText.replace(/\r\n/g, '\n').trim(),
    }))
    .filter((item) => item.plainText.length > 0)
    .map((item, index) => ({
      index: index + 1,
      detectedNumber: item.detectedNumber,
      title: item.title.trim() || `第${index + 1}章`,
      plainText: item.plainText,
      sourceName: item.sourceName,
      charCount: plainCharCount(item.plainText),
      isPartial: item.isPartial,
    }))

  if (chapters.length === 0) {
    warnings.push('没有识别到可读章节正文')
  }

  return { chapters, warnings }
}

/** 单文件整本：按「第N章 / Chapter N」标题行切分 */
export function parseSingleBookText(text: string, sourceName?: string): ManuscriptParseResult {
  const warnings: string[] = []
  const normalized = text.replace(/\r\n/g, '\n')
  const matches = [...normalized.matchAll(CHAPTER_HEADING_RE)]
  if (matches.length === 0) {
    const body = normalized.trim()
    if (!body) {
      return finalizeCandidates([], ['文件为空或无可读文本'])
    }
    warnings.push('未识别到章节标题行，整份文件将作为第 1 章')
    return finalizeCandidates(
      [
        {
          detectedNumber: 1,
          title: sourceName ? titleFromFilename(sourceName, 1) : '第1章',
          plainText: body,
          sourceName,
        },
      ],
      warnings,
    )
  }

  const raw: Array<Omit<ParsedChapterCandidate, 'index' | 'charCount'>> = []
  for (let i = 0; i < matches.length; i += 1) {
    const match = matches[i]!
    const start = match.index ?? 0
    const end = i + 1 < matches.length ? (matches[i + 1]!.index ?? normalized.length) : normalized.length
    const block = normalized.slice(start, end).trim()
    const numToken = match[1] || match[2] || match[3] || ''
    const detectedNumber = parseChapterNumberToken(numToken)
    const suffix = (match[4] ?? '').trim().replace(/^[:：\-\s]+/, '')
    const title =
      detectedNumber != null
        ? suffix
          ? `第${detectedNumber}章 ${suffix}`
          : `第${detectedNumber}章`
        : block.split('\n')[0]?.trim() || `章节 ${i + 1}`
    const bodyStart = block.indexOf('\n')
    const plainText = bodyStart >= 0 ? block.slice(bodyStart + 1).trim() : ''
    raw.push({
      detectedNumber,
      title,
      plainText: plainText || block,
      sourceName,
    })
  }

  return finalizeCandidates(raw, warnings)
}

/** 多文件：每个文件一章，按文件名章号排序 */
export function parseManuscriptFiles(files: ManuscriptFileInput[]): ManuscriptParseResult {
  const warnings: string[] = []
  if (files.length === 0) {
    return finalizeCandidates([], ['未选择任何文件'])
  }

  if (files.length === 1) {
    const only = files[0]!
    const split = parseSingleBookText(only.text, only.name)
    if (split.chapters.length > 1) {
      return {
        ...split,
        detectedTitle: only.name.replace(/\.[^.]+$/, '') || undefined,
      }
    }
  }

  const prepared = files.map((file) => {
    const detectedNumber = detectChapterNumberFromFilename(file.name)
    return {
      file,
      detectedNumber,
      sortKey: detectedNumber ?? Number.MAX_SAFE_INTEGER,
    }
  })

  prepared.sort((a, b) => {
    if (a.sortKey !== b.sortKey) return a.sortKey - b.sortKey
    return a.file.name.localeCompare(b.file.name, 'zh')
  })

  const raw: Array<Omit<ParsedChapterCandidate, 'index' | 'charCount'>> = []
  for (const item of prepared) {
    const body = item.file.text.replace(/\r\n/g, '\n').trim()
    if (!body) {
      warnings.push(`已跳过空文件：${item.file.name}`)
      continue
    }
    raw.push({
      detectedNumber: item.detectedNumber,
      title: titleFromFilename(item.file.name, item.detectedNumber),
      plainText: body,
      sourceName: item.file.name,
    })
  }

  const result = finalizeCandidates(raw, warnings)
  return result
}

export function parseManuscriptFromInputs(
  files: ManuscriptFileInput[],
  mode: 'auto' | 'force-single-book' = 'auto',
): ManuscriptParseResult {
  if (mode === 'force-single-book') {
    const merged = files.map((f) => f.text).join('\n\n')
    const name = files[0]?.name
    return parseSingleBookText(merged, name)
  }
  return parseManuscriptFiles(files)
}
