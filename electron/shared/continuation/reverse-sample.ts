/** 续写反推：从全书章节中挑选送入模型的正文子集 */

export type ReverseSampleChapter = {
  id: string
  index: number
  title: string
  plainText: string
}

export type ReverseSampleOptions = {
  maxBodyChapters?: number
  head?: number
  tail?: number
}

export type ReverseSamplePlan = {
  titleIndex: Array<{ index: number; title: string }>
  bodyChapters: ReverseSampleChapter[]
  warnings: string[]
  totalChapters: number
  sampledBodyCount: number
}

function clampPositive(value: number | undefined, fallback: number): number {
  if (value == null || !Number.isFinite(value)) return fallback
  return Math.max(0, Math.round(value))
}

/**
 * 开篇连续 + 末尾连续 + 中段均匀抽样。
 * titleIndex 始终覆盖全书（仅标题），正文最多 maxBodyChapters 章。
 */
export function buildReverseSamplePlan(
  chapters: ReverseSampleChapter[],
  options: ReverseSampleOptions = {},
): ReverseSamplePlan {
  const warnings: string[] = []
  const total = chapters.length
  const titleIndex = chapters.map((chapter) => ({ index: chapter.index, title: chapter.title }))

  if (total === 0) {
    return {
      titleIndex: [],
      bodyChapters: [],
      warnings: ['没有可采样的章节'],
      totalChapters: 0,
      sampledBodyCount: 0,
    }
  }

  const maxBody = Math.max(1, clampPositive(options.maxBodyChapters, 24))
  const head = clampPositive(options.head, Math.min(8, maxBody))
  const tail = clampPositive(options.tail, Math.min(4, maxBody))

  if (total <= maxBody) {
    return {
      titleIndex,
      bodyChapters: [...chapters],
      warnings,
      totalChapters: total,
      sampledBodyCount: total,
    }
  }

  const selected = new Map<number, ReverseSampleChapter>()
  const take = (chapter: ReverseSampleChapter | undefined) => {
    if (!chapter) return
    selected.set(chapter.index, chapter)
  }

  for (let i = 0; i < head && i < total; i += 1) take(chapters[i])
  for (let i = 0; i < tail && i < total; i += 1) take(chapters[total - 1 - i])

  const midBudget = Math.max(0, maxBody - selected.size)
  if (midBudget > 0) {
    const start = head
    const end = Math.max(start, total - tail - 1)
    if (end >= start) {
      const span = end - start + 1
      for (let i = 0; i < midBudget; i += 1) {
        const offset = span <= 1 ? 0 : Math.floor((i * (span - 1)) / Math.max(1, midBudget - 1))
        take(chapters[start + offset])
        if (selected.size >= maxBody) break
      }
    }
  }

  const bodyChapters = [...selected.values()].sort((a, b) => a.index - b.index)
  warnings.push(
    `全书 ${total} 章，正文仅采样 ${bodyChapters.length} 章（开篇/中段/末段）；标题列表覆盖全书。`,
  )

  return {
    titleIndex,
    bodyChapters,
    warnings,
    totalChapters: total,
    sampledBodyCount: bodyChapters.length,
  }
}

export function formatSamplePlanForPrompt(plan: ReverseSamplePlan, maxTitleLines = 400): string {
  const titles = plan.titleIndex
  const titleBlock =
    titles.length <= maxTitleLines
      ? titles.map((item) => `${item.index}. ${item.title}`).join('\n')
      : [
          ...titles.slice(0, Math.floor(maxTitleLines / 2)).map((item) => `${item.index}. ${item.title}`),
          `…（中间省略 ${titles.length - maxTitleLines} 条标题）…`,
          ...titles.slice(-Math.floor(maxTitleLines / 2)).map((item) => `${item.index}. ${item.title}`),
        ].join('\n')

  const bodies = plan.bodyChapters
    .map((chapter) => {
      const body = chapter.plainText.length > 3500
        ? `${chapter.plainText.slice(0, 3500)}\n…（截断）`
        : chapter.plainText
      return `### 第${chapter.index}章 ${chapter.title}\n${body}`
    })
    .join('\n\n')

  return `== 全书章节标题索引（共 ${plan.totalChapters} 章） ==\n${titleBlock}\n\n== 正文采样（${plan.sampledBodyCount} 章） ==\n${bodies}`
}
