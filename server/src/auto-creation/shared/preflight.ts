import type {
  AutoCreationQualityConfig,
  ChapterProductionContext,
  QualityCheckResult,
  QualityIssue,
} from './types.js'
import { stripToPlainText as stripPlain } from './text-utils.js'

/** 硬规则（确定性检查，不依赖 LLM）：破折号 / 章内分隔符 / 日式引号 / 高疲劳词。 */
const HARD_RULE_DASH = /——/
const HARD_RULE_SEPARATOR = /(^|\n)\s*(?:-{3,}|\*{3,}|#{1,6}\s|\[第?[一二三四五六七八九十百千0-9]+[章幕部]\]|\*\*\s*)/m
const HARD_RULE_JAPANESE_QUOTE = /「[^」]*」/
const FATIGUE_WORDS = /(冷笑|瞳孔骤缩|轰然炸裂|倒吸一口凉气|蝼蚁|虎躯一震|邪魅一笑|嘴角勾起一抹)/

/**
 * 确定性硬规则检查（与 LLM 审查互补，不重复其维度）。
 * 只查可客观定位的规则：字数越界、破折号、章内分隔符、日式引号、高疲劳词。
 * 返回的 issue 与 LLM 审查合并后统一走 gate；重复类别由调用方去重。
 */
export function evaluateDeterministicHardRules(
  content: string,
  input: { targetWordCount?: number; wordTolerancePercent?: number },
): QualityIssue[] {
  const plain = stripPlain(content)
  const issues: QualityIssue[] = []
  const len = plain.length

  const target = Number(input.targetWordCount ?? 0)
  const tolerance = Number.isFinite(input.wordTolerancePercent) ? Number(input.wordTolerancePercent) : 20
  if (target > 0 && len > 0) {
    const min = Math.round(target * (1 - tolerance / 100))
    const max = Math.round(target * (1 + tolerance / 100))
    if (len < min || len > max) {
      issues.push({
        severity: 'critical',
        category: 'word-count',
        ref: `正文 ${len} 字，超出目标 ${target}±${tolerance}%（${min}–${max}）`,
        hint: len < min ? '扩写到目标字数区间' : '精简到目标字数区间',
        repairAction: len < min ? '补充场景细节、对白或动作节拍，使字数达标' : '删减冗余描写与重复对白，使字数达标',
      })
    }
  }

  if (HARD_RULE_DASH.test(plain)) {
    issues.push({
      severity: 'critical',
      category: 'hard-rule',
      ref: '正文包含破折号（——）',
      hint: '改用句号、逗号或冒号重断句',
      repairAction: '把所有“——”改为自然停顿或明确标点',
    })
  }
  if (HARD_RULE_SEPARATOR.test(plain)) {
    issues.push({
      severity: 'critical',
      category: 'hard-rule',
      ref: '正文包含章内分隔符（---、***、#、【第X章】等）',
      hint: '删除分隔符，用场景自然过渡衔接',
      repairAction: '去掉分隔符，改为时间/地点/动作过渡句',
    })
  }
  if (HARD_RULE_JAPANESE_QUOTE.test(plain)) {
    issues.push({
      severity: 'warning',
      category: 'hard-rule',
      ref: '对白使用日式引号「……」，应为中文直角引号“……”',
      hint: '把「」替换为“”',
      repairAction: '统一对白引号为中文直角双引号',
    })
  }
  const fatigue = plain.match(FATIGUE_WORDS)
  if (fatigue) {
    issues.push({
      severity: 'hint',
      category: 'hard-rule',
      ref: `出现高疲劳表达：${fatigue[0]}`,
      hint: '换成更具体、克制的动作或神态描写',
      repairAction: `将“${fatigue[0]}”改写为更具体的身体反应或环境反应`,
    })
  }
  return issues
}
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
