import { randomUUID } from 'node:crypto'
import {
  buildReverseCoverageChunks,
  formatCoverageChunkForPrompt,
  mergeReverseExtractPartials,
  type ReverseExtractPartial,
  type ReverseSampleChapter,
} from '../../../electron/shared/continuation/index.js'
import type { ContinuationReverseExtractResult } from '../../../electron/main/ai/shared-types.js'
import type { WorkspacePayload } from '../workspace/json-store.js'
import { runServerAiTaskDirect } from '../ai/run-task.js'

export type ReverseExtractOptions = {
  /** @deprecated 稀疏采样上限；现改为 chaptersPerChunk 分块通读 */
  maxBodyChapters?: number
  /** 每块通读章数，默认 20 */
  chaptersPerChunk?: number
  /** 单章正文最大字数，默认 1600 */
  maxCharsPerChapter?: number
  /** 最多分块，默认 50 */
  maxChunks?: number
  maxCharacters?: number
  maxOutlineItems?: number
  maxWorldview?: number
  maxRelations?: number
  rebuildImportedOutline?: boolean
}

export type ReverseExtractApplyResult = {
  projectId: string
  sample: {
    totalChapters: number
    sampledBodyCount: number
    chunkCount: number
    warnings: string[]
  }
  counts: {
    worldview: number
    characters: number
    relationships: number
    volumes: number
    outlineItems: number
  }
  warnings: string[]
  extract: ContinuationReverseExtractResult
}

function newId(prefix: string): string {
  return `${prefix}-${Date.now()}-${randomUUID().slice(0, 8)}`
}

function nowIso(): string {
  return new Date().toISOString()
}

function stripHtml(content: string): string {
  return content
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim()
}

function isContinuePlaceholder(title: string): boolean {
  return /续写|待写|后续/.test(title)
}

function isImportedPlaceholder(title: string): boolean {
  return /已导入正文|原稿导入/.test(title)
}

function readProjectChapters(workspace: WorkspacePayload, projectId: string): ReverseSampleChapter[] {
  const pws = workspace.workspaces[projectId] ?? {}
  const chapters = Array.isArray(pws.chapters) ? (pws.chapters as Array<Record<string, unknown>>) : []
  return chapters.map((chapter, index) => ({
    id: String(chapter.id ?? `chapter-${index + 1}`),
    index: index + 1,
    title: String(chapter.title ?? `第${index + 1}章`),
    plainText: stripHtml(String(chapter.content ?? '')),
  })).filter((chapter) => chapter.plainText.length >= 20)
}

function emptyPartial(): ReverseExtractPartial {
  return {
    worldviewEntries: [],
    characters: [],
    characterRelationships: [],
    outlineVolumes: [],
    outlineItems: [],
    warnings: [],
  }
}

export function applyReverseExtractToWorkspace(
  workspace: WorkspacePayload,
  projectId: string,
  extract: ContinuationReverseExtractResult,
  options: ReverseExtractOptions = {},
): WorkspacePayload {
  const project = workspace.projects.find((item) => item.id === projectId)
  if (!project) throw new Error('project_not_found')
  const pws = { ...(workspace.workspaces[projectId] ?? {}) }
  const now = nowIso()
  const rebuild = Boolean(options.rebuildImportedOutline)

  const existingCharacters = Array.isArray(pws.characters)
    ? [...(pws.characters as Array<Record<string, unknown>>)]
    : []
  const nameToId = new Map<string, string>()
  for (const character of existingCharacters) {
    const name = String(character.name ?? '').trim()
    if (name) nameToId.set(name, String(character.id))
  }

  for (const card of extract.characters) {
    const name = card.name.trim()
    if (!name) continue
    const existingId = nameToId.get(name)
    if (existingId) {
      const idx = existingCharacters.findIndex((item) => String(item.id) === existingId)
      if (idx >= 0) {
        const prev = existingCharacters[idx]!
        const prevDesc = String(prev.description ?? '')
        existingCharacters[idx] = {
          ...prev,
          role: card.role || prev.role,
          description: card.description.length >= prevDesc.length ? card.description : prevDesc,
          tags: (card.tags?.length ? card.tags : (prev.tags as string[] | undefined) ?? []).map((label) =>
            typeof label === 'string' ? { label } : label,
          ),
        }
      }
      continue
    }
    const id = newId('character')
    nameToId.set(name, id)
    existingCharacters.push({
      id,
      name,
      role: card.role || '角色',
      description: card.description,
      avatar: '',
      tags: (card.tags ?? []).map((label) => ({ label })),
    })
  }
  pws.characters = existingCharacters

  const existingRels = Array.isArray(pws.characterRelationships)
    ? [...(pws.characterRelationships as Array<Record<string, unknown>>)]
    : []
  const relKey = (from: string, to: string, type: string) => `${from}::${to}::${type}`
  const existingRelKeys = new Set(
    existingRels.map((rel) =>
      relKey(String(rel.fromCharacterId), String(rel.toCharacterId), String(rel.type ?? '')),
    ),
  )
  for (const rel of extract.characterRelationships) {
    const fromId = nameToId.get(rel.fromName.trim())
    const toId = nameToId.get(rel.toName.trim())
    if (!fromId || !toId || fromId === toId) continue
    const key = relKey(fromId, toId, rel.type)
    if (existingRelKeys.has(key)) continue
    existingRelKeys.add(key)
    existingRels.push({
      id: newId('relationship'),
      fromCharacterId: fromId,
      toCharacterId: toId,
      type: rel.type || '关系',
      description: rel.description || '',
      intensity: Math.max(0, Math.min(100, Math.round(rel.intensity ?? 50))),
      createdAt: now,
      updatedAt: now,
    })
  }
  pws.characterRelationships = existingRels

  const existingWorld = Array.isArray(pws.worldviewEntries)
    ? [...(pws.worldviewEntries as Array<Record<string, unknown>>)]
    : []
  const worldTitles = new Set(existingWorld.map((item) => String(item.title ?? '').trim()))
  let worldSort = existingWorld.length
  for (const entry of extract.worldviewEntries) {
    const title = entry.title.trim()
    if (!title || worldTitles.has(title)) continue
    worldTitles.add(title)
    existingWorld.push({
      id: newId('worldview'),
      type: entry.type || '法则',
      title,
      content: entry.content,
      sortOrder: worldSort,
      createdAt: now,
      updatedAt: now,
    })
    worldSort += 1
  }
  pws.worldviewEntries = existingWorld

  const oldVolumes = Array.isArray(pws.outlineVolumes)
    ? [...(pws.outlineVolumes as Array<Record<string, unknown>>)]
    : []
  const oldItems = Array.isArray(pws.outlineItems)
    ? [...(pws.outlineItems as Array<Record<string, unknown>>)]
    : []
  const continueItems = oldItems.filter((item) => isContinuePlaceholder(String(item.title ?? '')))

  let volumes = oldVolumes
  let items = oldItems

  if (rebuild || oldItems.every((item) => isImportedPlaceholder(String(item.title ?? '')) || isContinuePlaceholder(String(item.title ?? '')))) {
    const volumeTitleToId = new Map<string, string>()
    volumes = extract.outlineVolumes.map((volume, index) => {
      const id = newId('volume')
      volumeTitleToId.set(volume.title, id)
      return {
        id,
        title: volume.title,
        summary: volume.summary || '',
        wordTarget: volume.wordTarget ?? '',
        sortOrder: index,
      }
    })
    if (volumes.length === 0) {
      const id = newId('volume')
      volumes = [{ id, title: '第一卷', summary: '反推默认分卷', wordTarget: '', sortOrder: 0 }]
      volumeTitleToId.set('第一卷', id)
    }
    const defaultVolumeId = String((volumes[0] as { id: string }).id)
    items = extract.outlineItems.map((item, index) => ({
      id: newId('outline'),
      volumeId: volumeTitleToId.get(item.volumeTitle) ?? defaultVolumeId,
      title: item.title,
      wordTarget: item.wordTarget || '已发生',
      conflict: item.conflict || '',
      summary: [
        item.summary,
        item.chapterFrom != null || item.chapterTo != null
          ? `（对应约第${item.chapterFrom ?? '?'}–${item.chapterTo ?? '?'}章）`
          : '',
      ].filter(Boolean).join(''),
      status: 'done',
      sortOrder: index,
    }))
    const lastVolumeId = String((volumes[volumes.length - 1] as { id: string }).id)
    if (continueItems.length === 0) {
      items.push({
        id: newId('outline'),
        volumeId: lastVolumeId,
        title: '续写（待写）',
        wordTarget: '3章',
        conflict: '',
        summary: '断点之后的自动创作占位',
        status: 'planned',
        sortOrder: items.length,
      })
    } else {
      for (const item of continueItems) {
        items.push({
          ...item,
          volumeId: lastVolumeId,
          sortOrder: items.length,
        })
      }
    }
  } else {
    const firstVolumeId = String(
      (oldVolumes[0] as { id?: string } | undefined)?.id ?? newId('volume'),
    )
    if (oldVolumes.length === 0) {
      volumes = [{ id: firstVolumeId, title: '第一卷', summary: '', wordTarget: '', sortOrder: 0 }]
    }
    const existingTitles = new Set(oldItems.map((item) => String(item.title ?? '')))
    items = [...oldItems]
    for (const item of extract.outlineItems) {
      if (existingTitles.has(item.title)) continue
      items.push({
        id: newId('outline'),
        volumeId: firstVolumeId,
        title: item.title,
        wordTarget: item.wordTarget || '已发生',
        conflict: item.conflict || '',
        summary: item.summary,
        status: 'done',
        sortOrder: items.length,
      })
    }
  }

  pws.outlineVolumes = volumes
  pws.outlineItems = items
  workspace.workspaces[projectId] = pws
  project.lastEdited = now

  const docs = Array.isArray(workspace.knowledgeDocuments) ? [...workspace.knowledgeDocuments] : []
  docs.push({
    id: newId('knowledge'),
    title: '续写反推设定记录',
    sourceType: 'canon-fact',
    sourceLabel: 'continuation-reverse-extract',
    content: JSON.stringify({
      projectId,
      at: now,
      characters: extract.characters.map((item) => item.name),
      outlineItemCount: extract.outlineItems.length,
      warnings: extract.warnings,
    }),
    summary: `反推 ${extract.characters.length} 角色 / ${extract.outlineItems.length} 大纲节点`,
    keywords: ['continuation', 'reverse-extract'],
    metadata: { projectId, reverseExtractedAt: now },
    createdAt: now,
    updatedAt: now,
  })
  workspace.knowledgeDocuments = docs

  return workspace
}

async function extractOneChunk(input: {
  userId: string
  projectId: string
  projectTitle: string
  projectGenre: string
  totalChapters: number
  sampleBlock: string
  chunkIndex: number
  totalChunks: number
  chapterFrom: number
  chapterTo: number
  chapterCount: number
  maxCharacters: number
  maxOutlineItems: number
  maxWorldview: number
  maxRelations: number
}): Promise<ReverseExtractPartial> {
  const ai = await runServerAiTaskDirect(input.userId, {
    task: 'continuation-reverse-extract',
    context: {
      projectId: input.projectId,
      projectTitle: input.projectTitle,
      projectGenre: input.projectGenre,
      totalChapters: input.totalChapters,
      sampledBodyCount: `分块 ${input.chunkIndex}/${input.totalChunks} · 本块 ${input.chapterCount} 章（第${input.chapterFrom}–${input.chapterTo}章）`,
      sampleBlock: input.sampleBlock,
      chunkIndex: input.chunkIndex,
      totalChunks: input.totalChunks,
      chapterFrom: input.chapterFrom,
      chapterTo: input.chapterTo,
      maxCharacters: input.maxCharacters,
      maxOutlineItems: input.maxOutlineItems,
      maxWorldview: input.maxWorldview,
      maxRelations: input.maxRelations,
    },
  })
  if (!ai.success || !ai.result) {
    return {
      ...emptyPartial(),
      warnings: [`分块 ${input.chunkIndex} 失败：${ai.error || 'reverse_extract_failed'}`],
    }
  }
  return ai.result as ContinuationReverseExtractResult
}

export async function runContinuationReverseExtract(input: {
  userId: string
  workspace: WorkspacePayload
  projectId: string
  options?: ReverseExtractOptions
}): Promise<{ workspace: WorkspacePayload; result: ReverseExtractApplyResult }> {
  const { userId, workspace, projectId } = input
  const options = input.options ?? {}
  const project = workspace.projects.find((item) => item.id === projectId)
  if (!project) throw new Error('project_not_found')

  const chapters = readProjectChapters(workspace, projectId)
  if (chapters.length === 0) throw new Error('empty_chapters')

  // 兼容旧参数 maxBodyChapters：若仍传入，当作每块章数
  const chaptersPerChunk = options.chaptersPerChunk
    ?? options.maxBodyChapters
    ?? 20

  const coverage = buildReverseCoverageChunks(chapters, {
    chaptersPerChunk,
    maxCharsPerChapter: options.maxCharsPerChapter ?? 1600,
    maxChunks: options.maxChunks ?? 50,
  })
  if (coverage.chunks.length === 0) throw new Error('empty_chapters')

  const maxCharacters = options.maxCharacters ?? 24
  const maxOutlineItems = options.maxOutlineItems ?? 30
  const maxWorldview = options.maxWorldview ?? 16
  const maxRelations = options.maxRelations ?? 60

  // 单块内给模型的输出上限略小，合并后再裁
  const perChunkCharacters = Math.min(12, maxCharacters)
  const perChunkOutline = Math.min(8, maxOutlineItems)
  const perChunkWorld = Math.min(8, maxWorldview)
  const perChunkRels = Math.min(20, maxRelations)

  const partials: ReverseExtractPartial[] = []
  for (const chunk of coverage.chunks) {
    const sampleBlock = formatCoverageChunkForPrompt(chunk, {
      includeFullTitleIndex: chunk.chunkIndex === 1,
    })
    const chunkStarted = Date.now()
    console.log(
      `[continuation-reverse] chunk ${chunk.chunkIndex}/${chunk.totalChunks} ch ${chunk.chapterFrom}-${chunk.chapterTo} start`,
    )
    const partial = await extractOneChunk({
      userId,
      projectId,
      projectTitle: project.title,
      projectGenre: project.genre ?? '',
      totalChapters: coverage.totalChapters,
      sampleBlock,
      chunkIndex: chunk.chunkIndex,
      totalChunks: chunk.totalChunks,
      chapterFrom: chunk.chapterFrom,
      chapterTo: chunk.chapterTo,
      chapterCount: chunk.chapters.length,
      maxCharacters: perChunkCharacters,
      maxOutlineItems: perChunkOutline,
      maxWorldview: perChunkWorld,
      maxRelations: perChunkRels,
    })
    const charNames = (partial.characters ?? []).map((c) => c.name).slice(0, 8).join(',')
    console.log(
      `[continuation-reverse] chunk ${chunk.chunkIndex}/${chunk.totalChunks} done ${Date.now() - chunkStarted}ms chars=${partial.characters?.length ?? 0} outline=${partial.outlineItems?.length ?? 0} names=${charNames}`,
    )
    partials.push(partial)
  }

  const succeeded = partials.filter((p) => (p.characters?.length ?? 0) > 0)
  if (succeeded.length === 0) {
    const failMsg = partials.flatMap((p) => p.warnings).join('；') || 'reverse_extract_failed'
    throw new Error(failMsg)
  }

  const merged = mergeReverseExtractPartials(partials, {
    maxCharacters,
    maxOutlineItems,
    maxWorldview,
    maxRelations,
  })

  const extract: ContinuationReverseExtractResult = {
    worldviewEntries: merged.worldviewEntries,
    characters: merged.characters,
    characterRelationships: merged.characterRelationships,
    outlineVolumes: merged.outlineVolumes.length > 0
      ? merged.outlineVolumes
      : [{ title: '第一卷', summary: '分块反推合并' }],
    outlineItems: merged.outlineItems,
    warnings: [...coverage.warnings, ...merged.warnings],
  }

  const next = applyReverseExtractToWorkspace(
    structuredClone(workspace),
    projectId,
    extract,
    options,
  )

  return {
    workspace: next,
    result: {
      projectId,
      sample: {
        totalChapters: coverage.totalChapters,
        sampledBodyCount: chapters.length,
        chunkCount: coverage.chunks.length,
        warnings: coverage.warnings,
      },
      counts: {
        worldview: extract.worldviewEntries?.length ?? 0,
        characters: extract.characters?.length ?? 0,
        relationships: extract.characterRelationships?.length ?? 0,
        volumes: extract.outlineVolumes?.length ?? 0,
        outlineItems: extract.outlineItems?.length ?? 0,
      },
      warnings: extract.warnings,
      extract,
    },
  }
}
