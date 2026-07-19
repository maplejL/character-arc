/** 将纯文本章节正文转为编辑器 HTML（与 renderer ensureEditorHtmlContent 对齐） */

const HTML_TAG_PATTERN = /<\/?[a-z][\s\S]*>/i

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
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
  return HTML_TAG_PATTERN.test(normalized) ? normalized : serializePlainTextToHtml(normalized)
}
