import type { TaskHandler, PromptBuildInput } from './base'
import { normalizeAssistantText } from './base'
import type { AiTaskResult, ChapterAssistantResult } from '../shared-types'

const TOKEN_PER_CHAR_GENEROUS = 0.8
const MAX_TOKENS_FLOOR = 4000
const MAX_TOKENS_CEIL = 12000

function formatPolishHints(hints: unknown): string {
  if (!Array.isArray(hints) || hints.length === 0) return '（无额外体检提示，按通用去 AI 味规则处理）'
  return hints
    .map((item, index) => `${index + 1}. ${String(item ?? '').trim()}`)
    .filter((line) => line.length > 2)
    .join('\n')
}

const handler: TaskHandler = {
  name: 'chapter-final-polish',
  outputType: 'text',
  defaultCapabilities: ['settings', 'chapters', 'writing-style', 'project-skills'],
  buildPrompt(input: PromptBuildInput) {
    const { context, capabilityPreamble, skillsBlock } = input
    const draftText = String(context.draftText ?? context.chapterContent ?? '').trim()
    const targetWordCount = Number(context.targetWordCount ?? 0)
    const writingStyleLabel = String(context.writingStyleLabel ?? '未指定')
    const writingStylePrompt = String(context.writingStylePrompt ?? '暂无')
    const polishHints = formatPolishHints(context.polishHints)

    return {
      system: `${capabilityPreamble.system}\n\n你是网文章节终稿润色编辑。契约审计已通过，只做轻量抛光，不大改剧情、不增删主要情节。\n\n【必须做】\n- 去 AI 腔：删「感到/觉得/意识到」直述、总结式收尾、模板光影沉默叠收\n- 对白节奏：略增有效对白，让说明性旁白变成带冲突的对话\n- 句式：拆过长句（单句≤45字），削减书面连接词\n- 章末：强化可追踪的未完成动作或新信息（若体检有提示则优先）\n- 禁止破折号（——）\n\n【禁止做】\n- 不改 payoffs / endingChanges 的实质兑现\n- 不引入新设定或新角色\n- 不输出解释、诊断或 markdown\n\n项目风格：${writingStyleLabel}；${writingStylePrompt}\n\n直接输出润色后的完整章节正文。`,
      user: `${capabilityPreamble.user}\n\n章节标题：${String(context.chapterTitle ?? '')}\n目标字数：约 ${targetWordCount} 字（±20%，润色后勿大幅偏离）\n\n网文体检提示（参考，非硬性删改清单）：\n${polishHints}\n\n当前项目启用 skills：\n${skillsBlock || '暂无'}\n\n## 待润色正文\n\n${draftText}\n\n输出润色后的完整正文（纯文本，从第一句开始）。`,
    }
  },
  normalize(raw: string): AiTaskResult {
    return normalizeAssistantText(raw) as AiTaskResult
  },
  validate(result: AiTaskResult): boolean {
    return Boolean((result as ChapterAssistantResult).content?.trim())
  },
  resolveMaxTokens(input: PromptBuildInput): number {
    const draftLength = String(input.context.draftText ?? input.context.chapterContent ?? '').length
    const target = draftLength > 0 ? draftLength : Number(input.context.targetWordCount ?? 0)
    if (target <= 0) return MAX_TOKENS_FLOOR
    const cap = Math.ceil(target * 1.2 / TOKEN_PER_CHAR_GENEROUS)
    return Math.min(Math.max(cap, MAX_TOKENS_FLOOR), MAX_TOKENS_CEIL)
  },
}

export default handler
