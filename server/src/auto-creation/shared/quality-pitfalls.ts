import type { QualityIssue } from './types.js'

/** 单章质量坑记录文档：把一章收敛过程中审查/修复发现的 issue 按 category 记入知识库 */
export type QualityIssueJournalDocument = {
  id: string
  projectId: string
  title: string
  sourceType: 'chapter-summary'
  sourceLabel: string
  content: string
  summary: string
  keywords: string[]
  metadata: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export type QualityPitfallBucket = {
  category: string
  count: number
  samples: string[]
}

export const QUALITY_ISSUE_JOURNAL_LABEL = 'quality-issue-journal'

const MAX_JOURNAL_ISSUES = 8
const MAX_PITFALL_BUCKETS = 5
const MAX_PITFALL_SAMPLES = 2

const SEVERITY_RANK: Record<string, number> = { critical: 0, warning: 1, hint: 2 }

function severityRank(severity: string | undefined): number {
  return SEVERITY_RANK[severity ?? ''] ?? 3
}

/**
 * 把一章的 audit/repair issue 聚合为一条 quality-issue-journal 文档。
 * 没有可记 issue 时返回 null（无问题章节不产生噪声文档）。
 */
export function buildQualityIssueJournal(input: {
  projectId: string
  chapter: { id: string; title?: string }
  issues: QualityIssue[]
  finalGatePass?: boolean
}): QualityIssueJournalDocument | null {
  const issues = (input.issues ?? [])
    .filter((issue) => issue && String(issue.category ?? '').trim() && String(issue.hint ?? '').trim())
    .sort((a, b) => severityRank(a.severity) - severityRank(b.severity))
    .slice(0, MAX_JOURNAL_ISSUES)
  if (issues.length === 0) return null

  const categories: Record<string, number> = {}
  for (const issue of issues) {
    const category = String(issue.category).trim()
    categories[category] = (categories[category] ?? 0) + 1
  }
  const now = new Date().toISOString()
  const lines = issues.map(
    (issue) => `- [${String(issue.severity ?? 'warning')}]【${String(issue.category).trim()}】${String(issue.hint).trim()}`,
  )
  return {
    id: `quality-issue-${input.chapter.id}-${Date.now()}`,
    projectId: input.projectId,
    title: `质量坑记录｜${input.chapter.title ?? input.chapter.id}`,
    sourceType: 'chapter-summary',
    sourceLabel: QUALITY_ISSUE_JOURNAL_LABEL,
    content: lines.join('\n'),
    summary: lines[0],
    keywords: [input.chapter.title ?? '', QUALITY_ISSUE_JOURNAL_LABEL],
    metadata: {
      chapterId: input.chapter.id,
      journalType: QUALITY_ISSUE_JOURNAL_LABEL,
      finalGatePass: input.finalGatePass ?? false,
      categories,
      issues: issues.map((issue) => ({
        category: String(issue.category).trim(),
        severity: issue.severity ?? 'warning',
        hint: String(issue.hint).trim(),
      })),
    },
    createdAt: now,
    updatedAt: now,
  }
}

/**
 * 聚合项目内所有 quality-issue-journal：按 category 计数（高频坑），
 * 每个 category 保留最近 MAX_PITFALL_SAMPLES 条样例 hint，按计数降序取 Top。
 */
export function aggregateQualityPitfalls(
  documents: Array<{ sourceLabel?: string; metadata?: Record<string, unknown>; createdAt?: string }>,
): QualityPitfallBucket[] {
  const journals = documents
    .filter((doc) => doc?.sourceLabel === QUALITY_ISSUE_JOURNAL_LABEL)
    .slice()
    .sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')))

  const buckets = new Map<string, { count: number; samples: string[] }>()
  for (const doc of journals) {
    const issues = Array.isArray(doc.metadata?.issues) ? (doc.metadata.issues as Array<Record<string, unknown>>) : []
    for (const issue of issues) {
      const category = String(issue.category ?? '').trim()
      if (!category) continue
      const bucket = buckets.get(category) ?? { count: 0, samples: [] }
      bucket.count += 1
      const hint = String(issue.hint ?? '').trim()
      if (hint) {
        bucket.samples.push(hint)
        if (bucket.samples.length > MAX_PITFALL_SAMPLES) bucket.samples.shift()
      }
      buckets.set(category, bucket)
    }
  }

  return [...buckets.entries()]
    .map(([category, bucket]) => ({ category, count: bucket.count, samples: bucket.samples }))
    .sort((a, b) => b.count - a.count)
    .slice(0, MAX_PITFALL_BUCKETS)
}
