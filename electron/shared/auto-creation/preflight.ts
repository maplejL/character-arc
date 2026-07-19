import type {
  AutoCreationQualityConfig,
  ChapterProductionContext,
  QualityCheckResult,
  QualityIssue,
} from './types.js'
import { resolveQualityConfig } from './types.js'
import {
  countDialogueChars,
  endingSimilarity,
  getEndingExcerpt,
  getOpeningExcerpt,
  longestCommonSubstringLength,
  stripToPlainText,
} from './text-utils.js'

const NARRATOR_TELEGRAPH_PATTERNS = [
  /没人知道/,
  /没有人知道/,
  /将改变一切/,
  /命运的齿轮/,
  /故事才刚刚开始/,
  /一切都将不同/,
]

const MARKDOWN_PATTERNS = [
  /\*\*[^*]+\*\*/,
  /^#{1,6}\s/m,
  /^---\s*$/m,
]

function checkOpeningRecycle(input: {
  opening: string
  referenceTitle: string
  referenceExcerpt: string
  minChars: number
  category: string
}): QualityIssue | null {
  const { opening, referenceExcerpt, minChars, referenceTitle, category } = input
  if (!opening || !referenceExcerpt) return null
  const overlap = longestCommonSubstringLength(opening, referenceExcerpt)
  if (overlap < minChars) return null
  return {
    severity: 'critical',
    category,
    ref: `本章开篇与《${referenceTitle}》开篇连续重复约 ${overlap} 字`,
    hint: `重写开篇，改用新动作/新信息起笔，避免复用《${referenceTitle}》的开篇节拍`,
    repairAction: `删除与《${referenceTitle}》重复的开篇段落，从本章独有事件或时间锚点重新起笔`,
  }
}

export function evaluateDraftPreflight(
  content: string,
  context: ChapterProductionContext,
  config?: AutoCreationQualityConfig,
): QualityCheckResult {
  const quality = resolveQualityConfig(config)
  const plain = stripToPlainText(content)
  const issues: QualityIssue[] = []
  const opening = getOpeningExcerpt(plain, 500)

  for (const reference of context.referenceOpenings) {
    const issue = checkOpeningRecycle({
      opening,
      referenceTitle: reference.chapterTitle,
      referenceExcerpt: reference.excerpt,
      minChars: quality.openingRecycleMinChars,
      category: 'opening-recycle',
    })
    if (issue) issues.push(issue)
  }

  if (context.previousChapterOpeningExcerpt) {
    const issue = checkOpeningRecycle({
      opening,
      referenceTitle: context.previousChapterHandoff?.title ?? '上一章',
      referenceExcerpt: context.previousChapterOpeningExcerpt,
      minChars: quality.openingRecycleMinChars,
      category: 'adjacent-opening-recycle',
    })
    if (issue) issues.push(issue)
  }

  if (quality.dialogueRatioMin > 0 && plain.length >= 800) {
    const ratio = countDialogueChars(plain) / plain.length
    const severity =
      context.outlineChapterSplit && context.outlineChapterSplit.totalParts > 1
        ? 'critical'
        : 'warning'
    if (ratio < quality.dialogueRatioMin) {
      issues.push({
        severity,
        category: 'dialogue-ratio-low',
        ref: `对白字数占比约 ${(ratio * 100).toFixed(1)}%，低于阈值 ${(quality.dialogueRatioMin * 100).toFixed(0)}%`,
        hint: '补充角色之间的有效对白，让对白同时推进信息与关系',
        repairAction: '在现有场景中插入至少两段双人来回对白，避免纯叙述说明',
      })
    }
  }

  for (const pattern of MARKDOWN_PATTERNS) {
    if (pattern.test(plain)) {
      issues.push({
        severity: 'critical',
        category: 'markdown-in-body',
        ref: '正文包含 Markdown 标记',
        hint: '移除加粗、标题符、分隔线等标记，只保留纯文本正文',
        repairAction: '删除正文中的 Markdown 格式符号，改为正常叙述或对白',
      })
      break
    }
  }

  if (quality.narratorTelegraphEnabled) {
    for (const pattern of NARRATOR_TELEGRAPH_PATTERNS) {
      const match = plain.match(pattern)
      if (match) {
        issues.push({
          severity: 'critical',
          category: 'narrator-intrusion',
          ref: `命中旁白预告表达：${match[0]}`,
          hint: '改为角色可感知的具体动作或信息，不要用全知旁白预告后文',
          repairAction: '删除或改写旁白预告句，换成章内可见的未完成动作或新信息',
        })
        break
      }
    }
  }

  const ending = getEndingExcerpt(plain, 120)
  for (const trail of context.recentEndingsTrail) {
    if (endingSimilarity(ending, trail.endingLine) >= 0.72) {
      issues.push({
        severity: 'warning',
        category: 'ending-pattern-repeat',
        ref: `章末与《${trail.chapterTitle ?? '前文'}》收束形式过于相似`,
        hint: '更换章末落点形式，避免连续多章同类悬念或同类环境收束',
        repairAction: '改写章末，使用不同的信息类型或动作类型留下钩子',
      })
      break
    }
  }

  return {
    pass: !issues.some((issue) => issue.severity === 'critical'),
    issues,
  }
}
