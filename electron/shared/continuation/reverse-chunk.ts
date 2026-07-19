/** 续写反推：全书分块通读（非稀疏采样） */

import type { ReverseSampleChapter } from './reverse-sample.js'

export type ReverseCoverageChunk = {
  chunkIndex: number
  totalChunks: number
  chapterFrom: number
  chapterTo: number
  chapters: ReverseSampleChapter[]
  titleIndex: Array<{ index: number; title: string }>
}

export type ReverseCoverageOptions = {
  /** 每块正文包含的章数，默认 24 */
  chaptersPerChunk?: number
  /** 单章正文最大字符，默认 1800 */
  maxCharsPerChapter?: number
  /** 最多分块数（防极端长文 token 爆炸），默认 60 ≈ 1440 章 */
  maxChunks?: number
}

function clampPositive(value: number | undefined, fallback: number): number {
  if (value == null || !Number.isFinite(value)) return fallback
  return Math.max(1, Math.round(value))
}

/**
 * 按章序非重叠分块，覆盖全书每一章（正文截断，标题索引可附全书）。
 */
export function buildReverseCoverageChunks(
  chapters: ReverseSampleChapter[],
  options: ReverseCoverageOptions = {},
): { chunks: ReverseCoverageChunk[]; warnings: string[]; totalChapters: number } {
  const warnings: string[] = []
  const total = chapters.length
  if (total === 0) {
    return { chunks: [], warnings: ['没有可分块的章节'], totalChapters: 0 }
  }

  let perChunk = clampPositive(options.chaptersPerChunk, 24)
  const maxChunks = clampPositive(options.maxChunks, 60)
  const maxChars = clampPositive(options.maxCharsPerChapter, 1800)

  // 若章数过多，自动加大每块章数以不超过 maxChunks
  if (Math.ceil(total / perChunk) > maxChunks) {
    perChunk = Math.ceil(total / maxChunks)
    warnings.push(
      `全书 ${total} 章超过默认分块上限，已自动调整为每块 ${perChunk} 章（共 ${Math.ceil(total / perChunk)} 块）。`,
    )
  }

  const titleIndex = chapters.map((chapter) => ({ index: chapter.index, title: chapter.title }))
  const chunks: ReverseCoverageChunk[] = []
  const totalChunks = Math.ceil(total / perChunk)

  for (let i = 0; i < total; i += perChunk) {
    const slice = chapters.slice(i, i + perChunk).map((chapter) => ({
      ...chapter,
      plainText:
        chapter.plainText.length > maxChars
          ? `${chapter.plainText.slice(0, maxChars)}\n…（本章截断）`
          : chapter.plainText,
    }))
    const first = slice[0]!
    const last = slice[slice.length - 1]!
    chunks.push({
      chunkIndex: chunks.length + 1,
      totalChunks,
      chapterFrom: first.index,
      chapterTo: last.index,
      chapters: slice,
      titleIndex,
    })
  }

  warnings.push(
    `全书 ${total} 章将分 ${chunks.length} 块通读（每块约 ${perChunk} 章，单章正文≤${maxChars} 字），再合并设定。`,
  )

  return { chunks, warnings, totalChapters: total }
}

export function formatCoverageChunkForPrompt(
  chunk: ReverseCoverageChunk,
  options: { includeFullTitleIndex?: boolean; maxTitleLines?: number } = {},
): string {
  const includeTitles = options.includeFullTitleIndex !== false
  const maxTitleLines = options.maxTitleLines ?? 500
  let titleBlock = ''
  if (includeTitles && chunk.chunkIndex === 1) {
    const titles = chunk.titleIndex
    titleBlock =
      titles.length <= maxTitleLines
        ? titles.map((item) => `${item.index}. ${item.title}`).join('\n')
        : [
            ...titles.slice(0, Math.floor(maxTitleLines / 2)).map((item) => `${item.index}. ${item.title}`),
            `…（中间省略 ${titles.length - maxTitleLines} 条标题）…`,
            ...titles.slice(-Math.floor(maxTitleLines / 2)).map((item) => `${item.index}. ${item.title}`),
          ].join('\n')
    titleBlock = `== 全书章节标题索引（共 ${chunk.titleIndex.length} 章） ==\n${titleBlock}\n\n`
  } else {
    titleBlock = `== 本块章标 ==\n${chunk.chapters.map((c) => `${c.index}. ${c.title}`).join('\n')}\n\n`
  }

  const bodies = chunk.chapters
    .map((chapter) => `### 第${chapter.index}章 ${chapter.title}\n${chapter.plainText}`)
    .join('\n\n')

  return `${titleBlock}== 正文分块 ${chunk.chunkIndex}/${chunk.totalChunks}（第${chunk.chapterFrom}–${chunk.chapterTo}章） ==\n${bodies}`
}

export type ReverseExtractPartial = {
  worldviewEntries: Array<{ type: string; title: string; content: string }>
  characters: Array<{ name: string; role: string; description: string; tags: string[] }>
  characterRelationships: Array<{
    fromName: string
    toName: string
    type: string
    description: string
    intensity: number
  }>
  outlineVolumes: Array<{ title: string; summary: string; wordTarget?: string }>
  outlineItems: Array<{
    volumeTitle: string
    title: string
    wordTarget: string
    conflict: string
    summary: string
    chapterFrom?: number
    chapterTo?: number
  }>
  warnings: string[]
}

function isProtagonistRole(role: string): boolean {
  return /主角|主人公|男主|女主|主视角/.test(role)
}

function scoreCharacter(card: ReverseExtractPartial['characters'][number]): number {
  let score = card.description.length
  if (isProtagonistRole(card.role)) score += 10_000
  if (/配角|龙套|路人/.test(card.role)) score -= 50
  score += (card.tags?.length ?? 0) * 5
  return score
}

/**
 * 合并多块反推结果；同名角色取信息更丰富的一条，主角 role 优先保留。
 */
export function mergeReverseExtractPartials(
  partials: ReverseExtractPartial[],
  limits: {
    maxCharacters?: number
    maxOutlineItems?: number
    maxWorldview?: number
    maxRelations?: number
  } = {},
): ReverseExtractPartial {
  const maxCharacters = limits.maxCharacters ?? 24
  const maxOutlineItems = limits.maxOutlineItems ?? 30
  const maxWorldview = limits.maxWorldview ?? 16
  const maxRelations = limits.maxRelations ?? 60

  const charMap = new Map<string, ReverseExtractPartial['characters'][number]>()
  for (const partial of partials) {
    for (const card of partial.characters ?? []) {
      const name = card.name.trim()
      if (!name) continue
      if (/^(未指定|未知|无名|某人|路人|待定|角色\d*)/.test(name)) continue
      const prev = charMap.get(name)
      if (!prev || scoreCharacter(card) > scoreCharacter(prev)) {
        const mergedTags = [...new Set([...(prev?.tags ?? []), ...(card.tags ?? [])])].slice(0, 8)
        const role = isProtagonistRole(card.role)
          ? card.role
          : isProtagonistRole(prev?.role ?? '')
            ? prev!.role
            : card.role || prev?.role || '角色'
        const description =
          (card.description?.length ?? 0) >= (prev?.description?.length ?? 0)
            ? card.description
            : prev?.description ?? card.description
        charMap.set(name, { name, role, description, tags: mergedTags })
      } else if (prev && isProtagonistRole(card.role) && !isProtagonistRole(prev.role)) {
        charMap.set(name, { ...prev, role: card.role })
      }
    }
  }

  let characters = [...charMap.values()].sort((a, b) => scoreCharacter(b) - scoreCharacter(a))
  // 保证至少一名主角标记：若无，把排序第一标为主角
  if (characters.length > 0 && !characters.some((c) => isProtagonistRole(c.role))) {
    characters = characters.map((c, i) => (i === 0 ? { ...c, role: '主角' } : c))
  }
  characters = characters.slice(0, maxCharacters)
  const nameSet = new Set(characters.map((c) => c.name))

  const relKey = (r: ReverseExtractPartial['characterRelationships'][number]) =>
    `${r.fromName}::${r.toName}::${r.type}`
  const relMap = new Map<string, ReverseExtractPartial['characterRelationships'][number]>()
  for (const partial of partials) {
    for (const rel of partial.characterRelationships ?? []) {
      if (!nameSet.has(rel.fromName) || !nameSet.has(rel.toName)) continue
      if (rel.fromName === rel.toName) continue
      const key = relKey(rel)
      const prev = relMap.get(key)
      if (!prev || (rel.description?.length ?? 0) > (prev.description?.length ?? 0)) {
        relMap.set(key, rel)
      }
    }
  }
  const characterRelationships = [...relMap.values()].slice(0, maxRelations)

  const worldMap = new Map<string, ReverseExtractPartial['worldviewEntries'][number]>()
  for (const partial of partials) {
    for (const entry of partial.worldviewEntries ?? []) {
      const title = entry.title.trim()
      if (!title) continue
      const prev = worldMap.get(title)
      if (!prev || entry.content.length > prev.content.length) {
        worldMap.set(title, entry)
      }
    }
  }
  const worldviewEntries = [...worldMap.values()].slice(0, maxWorldview)

  const volumeMap = new Map<string, ReverseExtractPartial['outlineVolumes'][number]>()
  for (const partial of partials) {
    for (const volume of partial.outlineVolumes ?? []) {
      const title = volume.title.trim()
      if (!title) continue
      const prev = volumeMap.get(title)
      if (!prev || (volume.summary?.length ?? 0) > (prev.summary?.length ?? 0)) {
        volumeMap.set(title, volume)
      }
    }
  }
  let outlineVolumes = [...volumeMap.values()]
  if (outlineVolumes.length === 0) {
    outlineVolumes = [{ title: '第一卷', summary: '由正文分块反推合并' }]
  }

  const itemMap = new Map<string, ReverseExtractPartial['outlineItems'][number]>()
  for (const partial of partials) {
    for (const item of partial.outlineItems ?? []) {
      const title = item.title.trim()
      if (!title) continue
      const key = `${item.volumeTitle}::${title}`
      const prev = itemMap.get(key)
      if (!prev || (item.summary?.length ?? 0) > (prev.summary?.length ?? 0)) {
        itemMap.set(key, item)
      } else if (prev && item.chapterFrom != null) {
        itemMap.set(key, {
          ...prev,
          chapterFrom: Math.min(prev.chapterFrom ?? item.chapterFrom, item.chapterFrom),
          chapterTo: Math.max(prev.chapterTo ?? item.chapterTo ?? item.chapterFrom, item.chapterTo ?? item.chapterFrom),
        })
      }
    }
  }
  const outlineItems = [...itemMap.values()]
    .sort((a, b) => (a.chapterFrom ?? 99999) - (b.chapterFrom ?? 99999))
    .slice(0, maxOutlineItems)

  const warnings = partials.flatMap((p) => p.warnings ?? [])
  warnings.push(
    `合并完成：角色 ${characters.length} / 关系 ${characterRelationships.length} / 世界观 ${worldviewEntries.length} / 大纲 ${outlineItems.length}`,
  )

  return {
    worldviewEntries,
    characters,
    characterRelationships,
    outlineVolumes,
    outlineItems,
    warnings,
  }
}
