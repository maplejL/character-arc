import type { AutoCreationQualityConfig, ChapterProductionContext } from './types.js'
import { resolveQualityConfig } from './types.js'

export function buildDraftGuardsBlock(
  context: ChapterProductionContext,
  targetWordCount: number,
  tolerancePercent = 25,
  config?: AutoCreationQualityConfig,
): string {
  const quality = resolveQualityConfig(config)
  const lines: string[] = ['== 自动创作写作守卫（系统生成，必须遵守） ==', '']

  if (context.currentOutlineItem) {
    lines.push('【本章在大纲中的位置】')
    lines.push(`- 绑定节点：${context.currentOutlineItem.title ?? '未命名'}`)
    if (context.currentOutlineItem.summary?.trim()) {
      lines.push(`- 节点任务摘要：${context.currentOutlineItem.summary.trim().slice(0, 500)}`)
    }
    if (context.currentOutlineItem.conflict?.trim()) {
      lines.push(`- 节点冲突/禁忌：${context.currentOutlineItem.conflict.trim().slice(0, 300)}`)
    }
    lines.push('')
  }

  if (context.outlineChapterSplit && context.outlineChapterSplit.totalParts > 1) {
    const split = context.outlineChapterSplit
    lines.push('【拆章位置】')
    lines.push(`- 当前：第 ${split.currentPart} / ${split.totalParts} 部分`)
    if (split.previousParts.length > 0) {
      lines.push('- 前置同纲章已写内容：')
      for (const part of split.previousParts) {
        const preview = part.preview?.trim() || part.summary?.trim() || '（暂无摘要）'
        lines.push(`  · 《${part.title ?? '前置章'}》：${preview.slice(0, 180)}`)
      }
    }
    lines.push('- 本章只允许完成当前部分应独占的情节节拍，不得重写前置部分主场景')
    if (split.currentPart > 1) {
      lines.push('- 若当前部分 > 1：开篇须用新时间锚点或新动作起笔，不得复制前置章开篇节拍')
    }
    lines.push('')
  }

  if (context.referenceOpenings.length > 0 || context.previousChapterOpeningExcerpt) {
    lines.push('【跨章禁令】')
    lines.push(`- 不得与已列开篇摘录连续重复 ≥ ${quality.openingRecycleMinChars} 字`)
    for (const reference of context.referenceOpenings) {
      lines.push(`- 《${reference.chapterTitle}》开篇摘录：${reference.excerpt.slice(0, 240)}`)
    }
    if (context.previousChapterOpeningExcerpt) {
      lines.push(
        `- 《${context.previousChapterHandoff?.title ?? '上一章'}》开篇摘录：${context.previousChapterOpeningExcerpt.slice(0, 240)}`,
      )
    }
    if (context.recentEndingsTrail.length > 0) {
      lines.push('- 章末收束形式避免与下列末句高度雷同：')
      for (const trail of context.recentEndingsTrail) {
        lines.push(`  · 《${trail.chapterTitle ?? '前文'}》：${trail.endingLine}`)
      }
    }
    lines.push('')
  }

  lines.push('【结构下限】')
  if (quality.dialogueRatioMin > 0) {
    lines.push(`- 目标对白占比约 ≥ ${(quality.dialogueRatioMin * 100).toFixed(0)}%（有效引号对白字数 / 全文字数）`)
  }
  lines.push('- 每约 600 字须有一次可感知变化（信息 / 关系 / 决策 / 障碍）')
  lines.push('- 单句尽量 ≤ 45 字；技术段须拆句，禁止连续 3 句以上 ≥ 40 字无对白')
  lines.push('- 每约 300 字只释放 1 个新信息点；禁止连续短段信息倾泻（参数/数字/专名连发）')
  lines.push('- 禁止正文出现 Markdown 标记（加粗、标题符、分隔线）')
  lines.push('')
  lines.push('【可读性与文体】')
  lines.push('- 削减书面连接词（然而/因此/与此同时/换言之）与成语腔（不言而喻/毋庸置疑）')
  lines.push('- 少用抽象感慨（命运/文明/注定/象征着）；情绪外化为动作或对白，少用「感到/觉得/意识到」直述')
  lines.push('- 对白禁止纯说明腔（也就是说/简单来说/换句话说）；技术信息须裹进冲突或动作')
  lines.push('- 禁止列举腔（首先其次/一是二是）堆砌；禁止连续 4 句以「他/主角名」起笔')
  lines.push('')
  lines.push('【叙述边界】')
  lines.push('- 禁止全知旁白预告式收束（总结全书命运、替读者剧透后文）')
  lines.push('- 章末须落为具体未完成动作或可验证的新信息，非抽象感慨')
  lines.push('')
  lines.push('【剧情大纲与人设硬边界】')
  lines.push('- 只推进绑定大纲节点与本章摘要范围内的情节；禁止写穿后续节点主情节')
  lines.push('- 出场角色必须符合角色卡与关系网；禁止无铺垫 OOC、敌友互换、能力越界')
  lines.push('- 拆章时只写当前 part；禁止重写前置同纲主场景或预支后续 part')
  lines.push('- 可呼应未收伏笔，禁止擅自提前完结后续才应收的线')
  lines.push('')
  const metaphorCap = Math.max(6, Math.round(targetWordCount / 1000 * 3))
  lines.push('【意象与比喻（硬上限）】')
  lines.push(`- 「像/仿佛/好像/宛如」类比喻全章 ≤ ${metaphorCap} 次（按目标字数折算，约每千字 ≤3 次）`)
  lines.push('- 光影/日光灯/走廊脚步/沉默安静等模板意象，单类单章各 ≤ 2 次')
  lines.push('- 禁止章末用「光影+沉默」或「脚步远去+安静」叠收；须落到对白、动作或可验证信息')
  lines.push('- 抽象情绪须外化为行为或对白，避免连续两句以上纯景物/光影铺陈')
  lines.push('')
  lines.push(`【字数】目标 ${targetWordCount} 字，允许 ±${tolerancePercent}%`)

  return lines.join('\n').trim()
}
