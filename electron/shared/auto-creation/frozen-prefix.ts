/**
 * Byte-stable prefix for auto-creation LLM calls within one chapter run.
 * Caller supplies pre-formatted blocks in deterministic order.
 */
export type FrozenProductionPrefixInput = {
  capabilityUserRules: string
  projectTitle: string
  projectGenre: string
  writingStyleBlock: string
  worldviewBlock: string
  charactersBlock: string
  relationshipsBlock: string
  outlineBlock: string
  skillsBlock: string
  chapterTitle: string
  chapterSummary: string
  volumeTitle: string
  volumeSummary: string
  targetWordCount: number
  outlineItemBlock: string
  outlineSplitBlock: string
  relatedChaptersBlock: string
  handoffBlock: string
  chapterMemoBlock: string
  /** 未收伏笔 / 活跃剧情线（可选，用于禁止提前完结） */
  plotThreadsBlock?: string
}

export function buildFrozenProductionPrefix(input: FrozenProductionPrefixInput): string {
  const lines: string[] = [
    '== 自动创作项目上下文（本章内冻结，请勿改写） ==',
    input.capabilityUserRules.trim(),
    `项目：${input.projectTitle} / 题材：${input.projectGenre}`,
    input.writingStyleBlock.trim(),
    `分卷：${input.volumeTitle}\n${input.volumeSummary}`.trim(),
    `本章：${input.chapterTitle}\n摘要：${input.chapterSummary}\n目标字数：${input.targetWordCount}`,
    input.outlineItemBlock.trim(),
    input.outlineSplitBlock.trim(),
    input.relatedChaptersBlock.trim(),
    input.handoffBlock.trim(),
    (input.plotThreadsBlock ?? '').trim(),
    input.worldviewBlock.trim(),
    input.charactersBlock.trim(),
    input.relationshipsBlock.trim(),
    input.outlineBlock.trim(),
    input.skillsBlock.trim(),
    input.chapterMemoBlock.trim(),
  ]
  return lines.filter((line) => line.length > 0).join('\n\n')
}

export function prependFrozenPhase(
  frozenPrefix: string | undefined,
  phase: string,
  body: string,
): string {
  const frozen = String(frozenPrefix ?? '').trim()
  const trimmedBody = body.trim()
  if (!frozen) return trimmedBody
  return `${frozen}\n\n【阶段】${phase}\n\n${trimmedBody}`
}
