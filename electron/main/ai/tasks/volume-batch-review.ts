import type { TaskHandler, PromptBuildInput } from './base'
import { extractJsonObject } from './base'
import type { AiTaskResult, VolumeBatchReviewResult } from '../shared-types'

/**
 * 整卷复盘：run 完成后对本批章节做一次阶段摘要 + 批次级 risks。
 * 只看跨章层面问题（伏笔遗忘、状态冲突、主线失焦、节奏塌陷），不看单章文风。
 */
const handler: TaskHandler = {
  name: 'volume-batch-review',
  outputType: 'json',
  defaultCapabilities: ['settings'],
  buildPrompt(input: PromptBuildInput) {
    const { context, capabilityPreamble } = input
    return {
      system: `${capabilityPreamble.system}\n\n你是小说分卷复盘助手。请只返回 JSON 对象，不要返回 Markdown，不要解释。`,
      user: `${capabilityPreamble.user}\n\n以下是一个分卷刚写完的一批章节（标题 + 摘要 + 节选）。请做一次整卷阶段复盘。\n\n项目题材：${String(context.projectGenre ?? '')}\n分卷：${String(context.chapterVolumeTitle ?? '')}\n\n批次章节：\n${String(context.batchReviewText ?? '')}\n\n要求：\n1. stageSummary：阶段摘要（3-5 句话）：本批章节推进到哪里、主要矛盾当前状态、主角处境与关系的变化\n2. risks：批次级风险（数组，0-4 条）：只看跨章层面——伏笔遗忘、时间线/状态冲突、主线失焦、节奏塌陷；不报告单章文风问题；没有就返回空数组\n\n返回格式：{"stageSummary":"","risks":[""]}`
    }
  },
  normalize(raw: string): AiTaskResult {
    const parsed = extractJsonObject(raw) as Partial<VolumeBatchReviewResult>
    return {
      stageSummary: String(parsed.stageSummary ?? '').trim(),
      risks: Array.isArray(parsed.risks)
        ? parsed.risks.map((item) => String(item).trim()).filter(Boolean).slice(0, 4)
        : [],
    } as VolumeBatchReviewResult
  },
  validate(result: AiTaskResult): boolean {
    return Boolean((result as VolumeBatchReviewResult).stageSummary?.trim())
  }
}
export default handler
