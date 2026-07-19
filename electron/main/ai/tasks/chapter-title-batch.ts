import type { TaskHandler, PromptBuildInput } from './base'
import { extractJsonObject } from './base'
import type { AiTaskResult } from '../shared-types'
import { resolveWritingStyleInstruction } from '../prompts/shared'

export type ChapterTitleBatchResult = {
  suggestion: string
  entries: Array<{
    index: number
    title: string
  }>
}

const handler: TaskHandler = {
  name: 'chapter-title-batch',
  outputType: 'json',
  defaultCapabilities: ['settings', 'chapters', 'outline', 'writing-style'],
  buildPrompt(input: PromptBuildInput) {
    const { context, capabilityPreamble } = input
    const writingStyle = resolveWritingStyleInstruction(context)
    const startChapter = Number(context.startChapter ?? 1)
    const endChapter = Number(context.endChapter ?? startChapter)

    return {
      system: `${capabilityPreamble.system}\n\n你是小说章节标题编辑助手。任务：为指定范围内的章节生成统一、好读、适合连载目录的标题方案。\n\n标题原则：\n- 优先「第N章 副标题」或「第N章 副标题（拆分序号）」\n- 副标题来自剧情摘要/大纲语义，8-18 字为宜\n- 去掉冗长大纲节点前缀（如「破壳前中期⑨｜」这类阶段标签不要重复进标题）\n- 同一大纲节点拆分的多章：副标题相同，用（1）（2）或（1/3）区分，但不要同时堆叠阶段编号\n- 不要用 markdown，不要解释创作理由\n\n只返回 JSON。`,
      user: `${capabilityPreamble.user}\n\n请为以下分卷的章节生成标题修改方案。\n\n项目标题：${String(context.projectTitle ?? '')}\n项目题材：${String(context.projectGenre ?? '')}\n当前分卷：${String(context.volumeTitle ?? '')}\n分卷摘要：${String(context.volumeSummary ?? '')}\n\n需要处理的章节范围：第 ${startChapter} 章 至 第 ${endChapter} 章（含首尾，按分卷内顺序 1 起算）\n\n分卷全部章节（供上下文）：\n${String(context.chaptersJson ?? '[]')}\n\n要求：\n1. suggestion：2-4 句话说明命名规则与调整思路（给用户确认前阅读）\n2. entries：仅为范围内每一章返回一条，index 为分卷内 1-based 序号，title 为建议新标题\n3. 每条 title 必须具体、可读、彼此可区分\n4. ${writingStyle}\n\n返回格式：{"suggestion":"","entries":[{"index":1,"title":""}]}`
    }
  },
  normalize(raw: string): AiTaskResult {
    const parsed = extractJsonObject(raw) as Partial<ChapterTitleBatchResult>
    const entries = Array.isArray(parsed.entries)
      ? parsed.entries
          .map((entry) => ({
            index: Number((entry as { index?: number }).index ?? 0),
            title: String((entry as { title?: string }).title ?? '').trim()
          }))
          .filter((entry) => entry.index > 0 && entry.title)
      : []
    return {
      suggestion: String(parsed.suggestion ?? '').trim(),
      entries
    } as ChapterTitleBatchResult
  },
  validate(result: AiTaskResult): boolean {
    const payload = result as ChapterTitleBatchResult
    return Boolean(payload.suggestion && payload.entries.length > 0)
  }
}

export default handler
