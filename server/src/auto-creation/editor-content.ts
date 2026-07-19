const HTML_TAG_PATTERN = /<\/?[a-z][\s\S]*>/i

const ENTITY_MAP: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  '#39': "'",
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function decodeHtmlEntities(value: string): string {
  return value.replace(/&([^;]+);/g, (match, entity) => ENTITY_MAP[entity] ?? match)
}

export function isRichTextDocument(content: string): boolean {
  return HTML_TAG_PATTERN.test(content)
}

export function serializePlainTextToHtml(content: string): string {
  const normalized = content.replace(/\r\n/g, '\n').trim()
  if (!normalized) return '<p></p>'
  return normalized
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, '<br />')}</p>`)
    .join('')
}

export function ensureEditorHtmlContent(content: string): string {
  const normalized = content.trim()
  if (!normalized) return '<p></p>'
  return isRichTextDocument(normalized) ? normalized : serializePlainTextToHtml(normalized)
}

export function getPlainTextFromEditorContent(content: string): string {
  const normalized = content.trim()
  if (!normalized) return ''
  if (!isRichTextDocument(normalized)) return normalized
  return decodeHtmlEntities(
    normalized
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|h[1-6]|blockquote)>/gi, '\n')
      .replace(/<li>/gi, '- ')
      .replace(/<\/li>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/\r/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function getChapterPreviewText(content: string, fallback = '章节尚未写入正文内容。'): string {
  const preview = getPlainTextFromEditorContent(content).replace(/\s+/g, ' ').trim()
  return preview || fallback
}
