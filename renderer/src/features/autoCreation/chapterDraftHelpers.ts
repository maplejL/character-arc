import type { ReferenceStyleAnalysis, KnowledgeDocument, ReferenceWorkItem } from '@/types/app'

import { normalizeChapterMemo } from '@/features/autoCreation/finalGate'

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

function formatReferenceWorkStyle(
  work: { title: string; analysis?: ReferenceStyleAnalysis },
  summaryDoc?: { summary?: string; content: string }
): string {
  const analysis = work.analysis
  const lines: string[] = []
  if (analysis?.overview) lines.push(`风格总述：${analysis.overview}`)
  if (analysis?.sentenceStyle) lines.push(`句式特征：${analysis.sentenceStyle}`)
  if (analysis?.dialogueRatio) lines.push(`对白策略：${analysis.dialogueRatio}`)
  if (analysis?.pacingControl) lines.push(`节奏控制：${analysis.pacingControl}`)
  if (analysis?.emotionExpression) lines.push(`情绪表达：${analysis.emotionExpression}`)
  if (analysis?.narrativePerspective) lines.push(`叙事视角：${analysis.narrativePerspective}`)
  if (analysis?.styleRules?.length) lines.push(`风格规则：${analysis.styleRules.join('；')}`)
  if (analysis?.reusableStylePrompt) lines.push(`仿写模板：${analysis.reusableStylePrompt}`)
  if (analysis?.avoidRules?.length) lines.push(`避免照搬：${analysis.avoidRules.join('；')}`)
  if (!lines.length && summaryDoc) {
    const snippet = (summaryDoc.summary || summaryDoc.content || '').slice(0, 600).trim()
    if (snippet) lines.push(snippet)
  }
  if (!lines.length) return ''
  return `【${work.title}】\n${lines.join('\n')}`
}

export function buildReferenceStyleContext(
  selectedRefIds: string[],
  referenceWorks: ReferenceWorkItem[],
  knowledgeDocuments: KnowledgeDocument[]
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
  const MAX_TOTAL_CHARS = 1800
  let totalChars = 0
  const parts: string[] = []
  for (const work of selectedWorks.slice(0, 3)) {
    const block = formatReferenceWorkStyle(work, summaryByTitle.get(work.title))
    if (!block) continue
    if (totalChars + block.length > MAX_TOTAL_CHARS) break
    parts.push(block)
    totalChars += block.length
  }
  return parts.join('\n\n')
}

export function formatAuditIssuesForRepair(
  issues: Array<{ severity: string; category: string; ref: string; hint: string }>
): Array<{ severity: 'critical' | 'warning' | 'hint'; category: string; ref: string; hint: string }> {
  return issues.map((issue) => ({
    severity: (issue.severity === 'warning' || issue.severity === 'hint' ? issue.severity : 'critical') as 'critical' | 'warning' | 'hint',
    category: issue.category,
    ref: issue.ref,
    hint: issue.hint
  }))
}
