import {
  buildFrozenProductionPrefix,
  type FrozenProductionPrefixInput,
} from './shared/frozen-prefix.js'
import {
  formatCharacters,
  formatCharacterRelationships,
  formatCurrentOutlineItem,
  formatOpenPlotThreads,
  formatOutlineChapterSplit,
  formatOutlineItems,
  formatPreviousChapterHandoff,
  formatRelatedChapters,
  formatWorldviewEntries,
} from '../../../electron/main/ai/prompts/format-helpers.js'
import { formatMemoForRepair } from './pipeline-helpers.js'

export function formatChapterMemoBlock(memo?: Record<string, unknown>): string {
  if (!memo) return ''
  const text = formatMemoForRepair(memo).trim()
  if (!text) return ''
  return text
}

export function buildFrozenChapterPrefix(input: {
  capabilityUserRules?: string
  projectTitle?: string
  projectGenre?: string
  writingStyleLabel?: string
  writingStylePrompt?: string
  chapterTitle?: string
  chapterSummary?: string
  chapterVolumeTitle?: string
  chapterVolumeSummary?: string
  targetWordCount: number
  memoBaseContext: Record<string, unknown>
  chapterMemo?: Record<string, unknown>
  skillsBlock?: string
}): string {
  const writingStyleBlock = [
    `写作风格：${String(input.writingStyleLabel ?? '未指定')}`,
    String(input.writingStylePrompt ?? '').trim(),
  ].filter(Boolean).join('\n')

  const prefixInput: FrozenProductionPrefixInput = {
    capabilityUserRules: String(input.capabilityUserRules ?? '').trim(),
    projectTitle: String(input.projectTitle ?? '').trim(),
    projectGenre: String(input.projectGenre ?? '').trim(),
    writingStyleBlock,
    worldviewBlock: formatWorldviewEntries(input.memoBaseContext.worldviewEntries) || '暂无',
    charactersBlock: formatCharacters(input.memoBaseContext.characters) || '暂无',
    relationshipsBlock:
      formatCharacterRelationships(
        input.memoBaseContext.characterRelationships,
        input.memoBaseContext.characters,
      ) || '暂无',
    outlineBlock: formatOutlineItems(input.memoBaseContext.outlineItems) || '暂无',
    skillsBlock: String(input.skillsBlock ?? '').trim() || '暂无',
    chapterTitle: String(input.chapterTitle ?? '').trim(),
    chapterSummary: String(input.chapterSummary ?? '').trim(),
    volumeTitle: String(input.chapterVolumeTitle ?? '').trim(),
    volumeSummary: String(input.chapterVolumeSummary ?? '').trim(),
    targetWordCount: input.targetWordCount,
    outlineItemBlock: formatCurrentOutlineItem(input.memoBaseContext.currentOutlineItem) || '暂无',
    outlineSplitBlock:
      formatOutlineChapterSplit(input.memoBaseContext.outlineChapterSplit) || '未拆分或暂无前置同纲章节',
    relatedChaptersBlock: formatRelatedChapters(input.memoBaseContext.relatedChapters) || '暂无',
    handoffBlock: formatPreviousChapterHandoff(input.memoBaseContext.previousChapterHandoff) || '',
    plotThreadsBlock: formatOpenPlotThreads(input.memoBaseContext.plotThreads)
      ? `未收伏笔 / 活跃剧情线：\n${formatOpenPlotThreads(input.memoBaseContext.plotThreads)}`
      : '',
    chapterMemoBlock: formatChapterMemoBlock(input.chapterMemo),
  }

  return buildFrozenProductionPrefix(prefixInput)
}
