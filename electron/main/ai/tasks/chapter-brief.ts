import type { TaskHandler, PromptBuildInput } from './base'
import { normalizeAssistantText } from './base'
import type { AiTaskResult, ChapterAssistantResult } from '../shared-types'

type ChapterMemoShape = {
  currentTask?: string
  readerExpectation?: string
  payoffs?: string[]
  holds?: string[]
  transitionFunctions?: string
  decisionChecks?: string[]
  endingChanges?: string[]
  doNotDo?: string[]
  emotionArc?: string
  partScopedTask?: string
  requiredStake?: string
}

function formatMemoJson(memo: unknown): string {
  if (!memo || typeof memo !== 'object') return '（无写作备忘）'
  return JSON.stringify(memo as ChapterMemoShape, null, 2)
}

const handler: TaskHandler = {
  name: 'chapter-brief',
  outputType: 'text',
  defaultCapabilities: ['settings', 'chapters', 'outline'],
  buildPrompt(input: PromptBuildInput) {
    const { context, capabilityPreamble } = input
    const targetWordCount = String(context.targetWordCount ?? '').trim()
    const memoJson = formatMemoJson(context.chapterMemo)

    return {
      system: `${capabilityPreamble.system}\n\n你是网文章节任务书撰写员。把 JSON 写作备忘渲染成 200～450 字、Writer 可直接执行的任务书（纯文本，不要 JSON/markdown）。\n\n任务书必须包含：\n1. 本章核心任务（动词开头）\n2. 读者情绪缺口 / 要兑现的爽点或推进（1～2 句）\n3. 章末必须留下的钩子或变化（1 句）\n4. 红线禁止（1～2 条，可执行）\n5. 情绪轨迹（起点→终点）\n\n禁止泛泛建议；每条必须可对照正文检查。`,
      user: `${capabilityPreamble.user}\n\n章节：${String(context.chapterTitle ?? '')}\n摘要：${String(context.chapterSummary ?? '')}\n目标字数：约 ${targetWordCount} 字\n\n写作备忘 JSON：\n${memoJson}\n\n请输出本章任务书（纯文本）。`,
    }
  },
  normalize(raw: string): AiTaskResult {
    return normalizeAssistantText(raw) as AiTaskResult
  },
  validate(result: AiTaskResult): boolean {
    return Boolean((result as ChapterAssistantResult).content?.trim())
  },
  resolveMaxTokens(): number {
    return 1200
  },
}

export default handler
