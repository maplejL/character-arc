const HTML_TAG_PATTERN = /<\/?[a-z][\s\S]*>/i

export function stripToPlainText(content: string): string {
  const raw = String(content ?? '').trim()
  if (!raw) return ''
  if (!HTML_TAG_PATTERN.test(raw)) return raw.replace(/\r\n/g, '\n').trim()
  return raw
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function getOpeningExcerpt(content: string, maxChars = 400): string {
  return stripToPlainText(content).slice(0, maxChars).trim()
}

export function getEndingExcerpt(content: string, maxChars = 200): string {
  const plain = stripToPlainText(content)
  return plain.slice(Math.max(0, plain.length - maxChars)).trim()
}

export function getLastLine(content: string, maxChars = 80): string {
  const plain = stripToPlainText(content)
  const lastLine = plain.split('\n').map((line) => line.trim()).filter(Boolean).at(-1) ?? ''
  return lastLine.length > maxChars ? `${lastLine.slice(0, maxChars - 3)}...` : lastLine
}

export function longestCommonSubstringLength(a: string, b: string): number {
  if (!a || !b) return 0
  const rows = a.length + 1
  const cols = b.length + 1
  let longest = 0
  const lengths = Array.from({ length: rows }, () => new Array<number>(cols).fill(0))
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      if (a[i - 1] === b[j - 1]) {
        lengths[i]![j] = (lengths[i - 1]![j - 1] ?? 0) + 1
        longest = Math.max(longest, lengths[i]![j]!)
      }
    }
  }
  return longest
}

export function countDialogueChars(text: string): number {
  let total = 0
  const patterns = [
    /“[^”]*”/g,
    /"[^"]*"/g,
    /「[^」]*」/g,
  ]
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      total += match[0]?.length ?? 0
    }
  }
  return total
}

export function endingSimilarity(a: string, b: string): number {
  const left = a.trim()
  const right = b.trim()
  if (!left || !right) return 0
  const minLen = Math.min(left.length, right.length)
  if (minLen === 0) return 0
  let same = 0
  for (let i = 0; i < minLen; i += 1) {
    if (left[left.length - minLen + i] === right[right.length - minLen + i]) same += 1
  }
  return same / minLen
}
