import type { TaskHandler, PromptBuildInput } from './base'
import { extractJsonObject } from './base'
import type { AiTaskResult, OutlineTensionCheckResult } from '../shared-types'

/**
 * 批次间大纲张力检查：核对刚写完的批次章节是否提前消耗（明确写出或强烈暗示）
 * 后续大纲节点的关键节拍。单章 risks 看不到这类跨节点问题，必须对照后续大纲。
 */
const handler: TaskHandler = {
  name: 'outline-tension-check',
  outputType: 'json',
  defaultCapabilities: ['settings'],
  buildPrompt(input: PromptBuildInput) {
    const { context, capabilityPreamble } = input
    return {
      system: `${capabilityPreamble.system}\n\n你是小说大纲边界审查助手。请只返回 JSON 对象，不要返回 Markdown，不要解释。`,
      user: `${capabilityPreamble.user}\n\n以下是一批刚写完的章节正文，以及大纲中尚未写的后续节点。请检查这些章节是否提前消耗了属于后续大纲节点的关键节拍，例如：身世/底牌提前揭晓、反转提前泄底、关系或立场提前越级、后续冲突提前解决。\n\n项目题材：${String(context.projectGenre ?? '')}\n当前分卷：${String(context.chapterVolumeTitle ?? '')}\n\n刚写完的批次章节：\n${String(context.batchText ?? '')}\n\n尚未写的后续大纲节点：\n${String(context.upcomingOutline ?? '')}\n\n要求：\n1. 只报告高置信的提前消耗：正文明确写出，或让读者必然猜到后续节点的核心节拍\n2. 每条指出对应的章节与大纲节点\n3. 不报告文风、节奏或单章内部问题；与后续节点无关的内容一律不算问题\n4. 没有问题就返回空数组\n\n返回格式：{"risks":["《章节名》提前消耗了后续节点「节点标题」的节拍：具体说明"]}`
    }
  },
  normalize(raw: string): AiTaskResult {
    const parsed = extractJsonObject(raw) as Partial<OutlineTensionCheckResult>
    const risks = Array.isArray(parsed.risks)
      ? parsed.risks.map((item) => String(item).trim()).filter(Boolean).slice(0, 5)
      : []
    return { risks } as OutlineTensionCheckResult
  },
  validate(result: AiTaskResult): boolean {
    return Array.isArray((result as OutlineTensionCheckResult).risks)
  }
}
export default handler
