import type { TaskHandler, PromptBuildInput } from './base'
import { extractJsonObject } from './base'
import type { AiTaskResult, ChapterAuditResult } from '../shared-types'
import {
  formatCharacters,
  formatCharacterRelationships,
  formatCurrentOutlineItem,
  formatOpenPlotThreads,
  formatOutlineChapterSplit,
  formatOutlineItems,
  formatPreviousChapterHandoff,
  formatRelatedChapters,
  formatVolumeChapterSummaries,
  formatWorldviewEntries,
} from '../prompts/format-helpers'

const VALID_SEVERITIES = new Set(['critical', 'warning', 'hint'])
const CHAPTER_AUDIT_MAX_TOKENS = 28000

/** 契约级类别：未通过即应进入返修（与通用质检区分） */
export const OUTLINE_CONTRACT_CATEGORIES = [
  'payoff',
  'ending-change',
  'hold',
  'do-not-do',
  'outline-scope',
  'outline-miss',
  'plot-drift',
  'character-ooc',
  'relation-drift',
  'continuity',
  'forbidden-advance',
  'opening-hook',
  'ending-hook',
  'word-count',
  'hard-rule',
] as const

function recomputeAuditPass(
  issues: Array<{ severity: string }>,
  maxWarnings = 2,
): boolean {
  let critical = 0
  let warning = 0
  for (const issue of issues) {
    if (issue.severity === 'critical') critical += 1
    else if (issue.severity === 'warning') warning += 1
  }
  return critical === 0 && warning <= maxWarnings
}

function normalizeChinesePunctuation(value: string): string {
  return value
    .replace(/「\s+/g, '「')
    .replace(/\s+」/g, '」')
    .replace(/『\s+/g, '『')
    .replace(/\s+』/g, '』')
    .replace(/\s+([，。！？；：、])/g, '$1')
    .replace(/([（【《])\s+/g, '$1')
    .replace(/\s+([）】》])/g, '$1')
    .trim()
}

function asBlock(title: string, body: string): string {
  const text = body.trim()
  if (!text) return ''
  return `## ${title}\n\n${text}`
}

function buildStoryConstraintBlock(context: Record<string, unknown>): string {
  const parts = [
    asBlock('当前绑定大纲（剧情边界·最高优先级）', formatCurrentOutlineItem(context.currentOutlineItem)),
    asBlock('同一大纲拆章位置', formatOutlineChapterSplit(context.outlineChapterSplit)),
    asBlock('本卷相关大纲节点', formatOutlineItems(context.outlineItems)),
    asBlock('章节摘要（本章任务）', String(context.chapterSummary ?? '').trim()),
    asBlock('分卷摘要（仅背景，禁止越权写他章）', String(context.chapterVolumeSummary ?? '').trim()),
    asBlock('相邻章节', formatRelatedChapters(context.relatedChapters)),
    asBlock('本卷章节概览', formatVolumeChapterSummaries(context.volumeChapterSummaries)),
    asBlock('上一章接续', formatPreviousChapterHandoff(context.previousChapterHandoff)),
    asBlock('未收伏笔 / 活跃剧情线', formatOpenPlotThreads(context.plotThreads)),
    asBlock('相关角色卡（OOC 判定基准）', formatCharacters(context.characters)),
    asBlock(
      '角色关系（关系漂移判定基准）',
      formatCharacterRelationships(context.characterRelationships, context.characters),
    ),
    asBlock('相关世界观', formatWorldviewEntries(context.worldviewEntries)),
  ].filter(Boolean)

  if (parts.length === 0) {
    return '## 剧情约束上下文\n\n（未注入大纲/角色上下文；仅按写作备忘审计）'
  }
  return ['## 剧情约束上下文（通用大纲闸门）', '', ...parts].join('\n\n')
}

const handler: TaskHandler = {
  name: 'chapter-audit',
  outputType: 'json',
  defaultCapabilities: [
    'settings',
    'chapters',
    'analysis',
    'outline',
    'characters',
    'relations',
    'worldview',
  ],
  buildPrompt(input: PromptBuildInput) {
    const { context, capabilityPreamble } = input
    const draftText = String(context.draftText ?? '').trim()
    const memo = context.chapterMemo as Record<string, unknown> | undefined
    const targetWordCount = String(context.targetWordCount ?? '').trim()
    const memoBlock = formatMemoForAudit(memo)
    const storyBlock = buildStoryConstraintBlock(context as Record<string, unknown>)

    return {
      system: `${capabilityPreamble.system}

你是小说章节「剧情大纲约束审计师」。任务：对照写作备忘 + 大纲/角色/关系/接续上下文，找出初稿中所有会阻断保存的硬伤，确保角色不 OOC、剧情不走偏。只返回 JSON，不要 markdown。

【总原则】
- 大纲节点的 summary / conflict 与「当前章节摘要」是本章剧情边界；写穿后续节点、跳过本章节点任务、另起无关主线 = 跑偏。
- 角色卡 description / role 与关系网是人设与关系基准；言行动机与之矛盾 = OOC。
- 写作备忘 payoffs / endingChanges / holds / doNotDo 是本章硬契约，必须逐条核对。
- 没有证据不要硬找问题；但有证据的 critical 必须报出，禁止放水。
- ref 必须可定位：**优先引用正文原句（逐字摘自正文，或来自大纲/备忘原文）**，不得凭印象概括。
- 系统会校验 ref 是否真实存在于正文；编造的 ref 会被降级丢弃，反而导致漏判。

【审计维度（按顺序；1–8 为契约 hard gate）】
1. outline-scope：是否写穿大纲/分卷中「不属于本章」的主情节；拆章时是否侵占其他 part
2. outline-miss：绑定大纲/章节摘要要求的核心任务是否在正文有可定位兑现（不能只侧面提）
3. plot-drift：是否偏离当前节点冲突，插入无关主线、错误势力或未埋伏笔的重大设定跳变
4. character-ooc：出场角色是否违背角色卡（性格、能力边界、身份、说话方式、动机）
5. relation-drift：人物关系是否违背关系网（突然敌友互换、越级亲密/决裂且本章无过程）
6. continuity：与上一章接续、时间线、人物位置/状态是否矛盾
7. forbidden-advance：是否提前兑现后续大纲节点、holds 底牌，或触碰 doNotDo
8. 备忘契约：payoffs 兑现 / endingChanges 落地 / holds 守住 / doNotDo 红线
9. opening-hook：前 100 字是否有动作/对话/反差/信息冲击
10. ending-hook：章末是否有未完成动作或新信息（非总结升华）
11. word-count：字数是否在目标 ±20%
12. hard-rule：破折号（——）、高疲劳词（冷笑/瞳孔骤缩/轰然炸裂/倒吸一口凉气/蝼蚁等）、章节内分隔符（---、#）

issue 格式：
- severity: "critical"（大纲跑偏 / OOC / 关系硬伤 / 接续矛盾 / 备忘未兑现 / 触碰红线）/"warning"（钩子弱 / 字数偏离 / 轻度语气不稳）/"hint"（疲劳词 / 句式）
- category: 必须使用：
  "outline-scope" | "outline-miss" | "plot-drift" | "character-ooc" | "relation-drift" | "continuity" | "forbidden-advance" | "payoff" | "ending-change" | "hold" | "do-not-do" | "opening-hook" | "ending-hook" | "word-count" | "hard-rule"
- ref: 证据（正文片段或大纲/备忘原文）
- hint: 一句话可执行改法

返回格式：{"audit":{"pass":true|false,"wordCount":0,"issues":[{"severity":"","category":"","ref":"","hint":""}]}}

pass 判定（系统会复核）：critical == 0 且 warning <= 2 才 pass。
对 outline-scope / outline-miss / plot-drift / character-ooc / relation-drift / continuity / forbidden-advance / payoff / ending-change / do-not-do 的明确违规，severity 必须为 critical。`,
      user: `${capabilityPreamble.user}

请审计以下章节初稿。

${storyBlock}

${memoBlock}

目标字数：${targetWordCount || '未指定'}

## 章节正文

${draftText}

返回审计 JSON。`,
    }
  },
  normalize(raw: string, input?: PromptBuildInput): AiTaskResult {
    const parsed = extractJsonObject(raw) as { audit?: Partial<ChapterAuditResult['audit']> }
    const auditRaw = parsed.audit ?? {}
    const issuesRaw = Array.isArray(auditRaw.issues) ? auditRaw.issues : []
    const draftText = String(input?.context?.draftText ?? '')
    // 钩子/字数允许 warning；下列契约类明确违规一律抬升为 critical，防止模型放水后终检误过
    const forceCriticalCategories = new Set([
      'payoff',
      'ending-change',
      'hold',
      'do-not-do',
      'outline-scope',
      'outline-miss',
      'plot-drift',
      'character-ooc',
      'relation-drift',
      'continuity',
      'forbidden-advance',
      'hard-rule',
    ])
    const issues = issuesRaw
      .map((item) => {
        if (!item || typeof item !== 'object') return null
        const r = item as Record<string, unknown>
        let severity = String(r.severity ?? '').trim()
        if (!VALID_SEVERITIES.has(severity)) return null
        const category = normalizeChinesePunctuation(String(r.category ?? ''))
        if (
          forceCriticalCategories.has(category)
          && (severity === 'warning' || severity === 'hint')
        ) {
          severity = 'critical'
        }
        const ref = normalizeChinesePunctuation(String(r.ref ?? ''))
        // 证据可校验：ref 中引用的正文片段若不存在于 draftText，说明是模型编造的幻觉 issue。
        // 降级为 hint（不进返修），避免拿不存在的证据去乱改正文。
        let finalSeverity = severity
        if (ref && draftText) {
          const probe = ref.length > 60 ? ref.slice(0, 60) : ref
          const compact = probe.replace(/\s+/g, '')
          const haystack = draftText.replace(/\s+/g, '')
          if (compact.length >= 12 && !haystack.includes(compact)) {
            finalSeverity = 'hint'
          }
        }
        return {
          severity: finalSeverity as 'critical' | 'warning' | 'hint',
          category,
          ref,
          hint: normalizeChinesePunctuation(String(r.hint ?? '')),
        }
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)

    const wordCount = Number(auditRaw.wordCount ?? 0)
    return {
      audit: {
        pass: recomputeAuditPass(issues),
        wordCount: Number.isFinite(wordCount) ? wordCount : 0,
        issues,
      },
    } as ChapterAuditResult
  },
  validate(result: AiTaskResult): boolean {
    return Boolean((result as ChapterAuditResult).audit)
  },
  resolveMaxTokens(): number {
    return CHAPTER_AUDIT_MAX_TOKENS
  },
}

function formatMemoForAudit(memo: Record<string, unknown> | undefined): string {
  if (!memo) return '## 写作备忘\n\n（本章无写作备忘）'
  const list = (key: string): string => {
    const arr = memo[key]
    return Array.isArray(arr) && arr.length > 0
      ? arr.map((s) => `  - ${String(s)}`).join('\n')
      : '  - 无'
  }
  return [
    '## 写作备忘（审计基准）',
    `当前任务：${String(memo.currentTask ?? '未指定')}`,
    `读者期待：${String(memo.readerExpectation ?? '未指定')}`,
    '该兑现的（payoffs）：',
    list('payoffs'),
    '暂不掀的（holds）：',
    list('holds'),
    '章尾必须发生的改变（endingChanges）：',
    list('endingChanges'),
    '本章红线（doNotDo）：',
    list('doNotDo'),
  ].join('\n')
}

export default handler
