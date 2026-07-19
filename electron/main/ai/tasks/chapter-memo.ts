import type { TaskHandler, PromptBuildInput } from './base'
import { extractJsonObject } from './base'
import type { AiTaskResult, ChapterMemoResult } from '../shared-types'
import {
  formatWorldviewEntries, formatCharacters,
  formatCharacterRelationships,
  formatCurrentOutlineItem, formatOutlineChapterSplit,
  formatOutlineItems, formatRelatedChapters,
  formatVolumeChapterSummaries, formatOpenPlotThreads
} from '../prompts/format-helpers'
import { coerceMemoStringArray, unwrapChapterMemoPayload } from './memo-array'
import { prependFrozenPhase } from '../prompts/frozen-prefix'

const CHAPTER_MEMO_MAX_TOKENS = 26000

function formatWritingJournals(journals: unknown): string {
  if (!Array.isArray(journals) || journals.length === 0) return ''
  const entries = journals
    .map((j) => {
      if (!j || typeof j !== 'object') return ''
      const item = j as Record<string, unknown>
      return `- ${String(item.title ?? '')}：${String(item.content ?? '')}`
    })
    .filter(Boolean)
  if (entries.length === 0) return ''
  return `\n\n近期写作日志（参考前几章的经验）：\n${entries.join('\n')}`
}

const handler: TaskHandler = {
  name: 'chapter-memo',
  outputType: 'json',
  defaultCapabilities: ['settings', 'chapters', 'worldview', 'characters', 'relations', 'outline'],
  buildPrompt(input: PromptBuildInput) {
    const { context, capabilityPreamble } = input
    const targetWordCount = String(context.targetWordCount ?? context.chapterWordTarget ?? '').trim()
    const frozenPrefix = String(context.frozenProductionPrefix ?? '').trim()

    const memoBody = `请为以下章节生成写作备忘。

项目题材：${String(context.projectGenre ?? '')}
当前分卷：${String(context.chapterVolumeTitle ?? '')}
当前分卷摘要：${String(context.chapterVolumeSummary ?? '')}
当前章节标题：${String(context.chapterTitle ?? '')}
当前章节摘要：${String(context.chapterSummary ?? '')}
目标字数：${targetWordCount}

当前绑定大纲：
${formatCurrentOutlineItem(context.currentOutlineItem) || '暂无'}

同一大纲拆章情况：
${formatOutlineChapterSplit(context.outlineChapterSplit) || '未拆分或暂无前置同纲章节'}

相邻章节参考：
${formatRelatedChapters(context.relatedChapters) || '暂无'}

本卷章节概览：
${formatVolumeChapterSummaries(context.volumeChapterSummaries) || '暂无'}

未收伏笔 / 活跃剧情线：
${formatOpenPlotThreads(context.plotThreads) || '暂无'}

相关世界观：
${formatWorldviewEntries(context.worldviewEntries) || '暂无'}

相关角色：
${formatCharacters(context.characters) || '暂无'}

角色关系：
${formatCharacterRelationships(context.characterRelationships, context.characters) || '暂无'}

相关大纲：
${formatOutlineItems(context.outlineItems) || '暂无'}${formatWritingJournals(context.recentWritingJournals)}

返回格式：{"memo":{"currentTask":"","readerExpectation":"","payoffs":[],"holds":[],"transitionFunctions":"","decisionChecks":[],"endingChanges":[],"doNotDo":[],"emotionArc":"","partScopedTask":"","mustDifferentiateFrom":[],"requiredStake":""}}`

    return {
      system: `${capabilityPreamble.system}\n\n你是小说写作的章节备忘规划师。任务：严格基于"当前章节摘要"，输出本章的"写作备忘"——这是后续 Writer 写正文的硬指令，不是泛泛的写作建议。

【重要约束】
- 你只负责规划"当前章节"这一章的内容，不要规划后续章节的内容。
- "当前章节摘要"是本章的唯一剧情边界，所有规划必须围绕这个摘要展开。
- 分卷摘要仅供了解整体方向，不要把分卷中其他章节的剧情写进本章备忘。
- 如果当前章节是第一章（没有相邻章节参考），就按开篇来规划。

只返回 JSON 对象，不要返回 markdown 或解释。每个字段都要具体可落地：写"林秋发现父亲的旧账本"而不是"推进调查线"。

字段语义：
- currentTask：本章必须完成的具体动作，1 句话，必须以动词开头
- readerExpectation：读者此刻最在等什么（1 句话，控制本章情绪缺口的兑现节奏）
- payoffs：本章必须兑现的具体内容（数组，0-3 条，每条 1 句具体动作或揭示）
- holds：本章必须压住不掀的底牌（数组，0-3 条）
- transitionFunctions：非冲突段落各自承担什么功能（1-3 句）
- decisionChecks：本章关键人物选择必须过的检查问题（数组，2-3 条）
- endingChanges：章尾必须发生的具体改变（数组，1-3 条，类型必须是 信息变化/关系变化/物理变化/权力变化 之一）
- doNotDo：本章红线（数组，2-5 条具体禁忌，**必填且不得为空**，不要写"避免 AI 味"这种泛泛的）。必须包含：①禁止写穿后续大纲节点的具体情节；②主要角色禁止的 OOC 行为；③关系/立场上禁止的越级变化；若偏技术/旁白可再加对白占比与句长约束。空 doNotDo 等于把全局约束从写作契约里删掉，下游审查与修复会失去具体红线。
- emotionArc：本章情绪轨迹（1 句话，格式"起点情绪→转折→终点情绪"，如"安逸→被突袭打碎→自我怀疑"）
- partScopedTask：若同一大纲拆成多章，本章（当前部分）独占要完成的一件事（动词开头，1 句）；非拆章可留空
- mustDifferentiateFrom：相对前置同纲章或上一章，本章必须在场景/冲突点上不同的 1-2 条（数组）；无可区分压力时可留空
- requiredStake：本章至少一次「选择带来代价」的具体描述（1 句）；若无决策戏可留空`,
      user: frozenPrefix
        ? prependFrozenPhase(frozenPrefix, 'chapter-memo', '请输出本章写作备忘 JSON。')
        : `${capabilityPreamble.user}\n\n${memoBody}`,
    }
  },
  normalize(raw: string): AiTaskResult {
    const parsed = extractJsonObject(raw)
    const memoRaw = unwrapChapterMemoPayload(parsed)
    const stringArray = coerceMemoStringArray
    return {
      memo: {
        currentTask: String(memoRaw.currentTask ?? '').trim(),
        readerExpectation: String(memoRaw.readerExpectation ?? '').trim(),
        payoffs: stringArray(memoRaw.payoffs),
        holds: stringArray(memoRaw.holds),
        transitionFunctions: String(memoRaw.transitionFunctions ?? '').trim(),
        decisionChecks: stringArray(memoRaw.decisionChecks),
        endingChanges: stringArray(memoRaw.endingChanges),
        doNotDo: stringArray(memoRaw.doNotDo),
        emotionArc: String((memoRaw as Record<string, unknown>).emotionArc ?? '').trim(),
        partScopedTask: String((memoRaw as Record<string, unknown>).partScopedTask ?? '').trim(),
        mustDifferentiateFrom: stringArray((memoRaw as Record<string, unknown>).mustDifferentiateFrom),
        requiredStake: String((memoRaw as Record<string, unknown>).requiredStake ?? '').trim(),
      }
    } as ChapterMemoResult
  },
  validate(result: AiTaskResult): boolean {
    const memo = (result as ChapterMemoResult).memo
    if (!memo) return false
    if (!memo.currentTask || memo.endingChanges.length === 0) return false
    // doNotDo 是"禁止写穿后续大纲 / 禁止 OOC / 禁止关系越级"的唯一章节级载体，
    // 空数组等于把全局约束从写作契约里删掉，下游审查与修复会失去具体红线。
    if (memo.doNotDo.length === 0) return false
    return true
  },
  describeValidationErrors(result: AiTaskResult): string[] {
    const memo = (result as ChapterMemoResult).memo
    const errors: string[] = []
    if (!memo) return ['memo 字段缺失']
    if (!memo.currentTask) errors.push('memo.currentTask 为空')
    if (memo.endingChanges.length === 0) errors.push('memo.endingChanges 为空数组')
    if (memo.doNotDo.length === 0) {
      errors.push(
        'memo.doNotDo 为空数组——本章必须包含至少一条禁止项'
        + '（如：禁止写穿后续大纲节点、禁止主角 OOC 行为、禁止关系/立场越级），'
        + '它是下游审查与修复的唯一具体红线依据',
      )
    }
    return errors.length > 0 ? errors : ['memo 结构不完整']
  },
  resolveMaxTokens(): number {
    return CHAPTER_MEMO_MAX_TOKENS
  }
}
export default handler
