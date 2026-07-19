import { randomUUID } from 'node:crypto'
import {
  CONTINUATION_BREAKPOINT_SOURCE_LABEL,
  CONTINUATION_DEFAULT_VOLUME_TITLE,
  ensureEditorHtmlContent,
  type ContinuationBreakpoint,
  type ParsedChapterCandidate,
} from '../../../electron/shared/continuation/index.js'
import {
  createEmptyProjectWorkspace,
  newProjectId,
  type WorkspacePayload,
} from '../workspace/json-store.js'

export type ContinuationSeedChapterInput = {
  title: string
  plainText: string
  isPartial?: boolean
}

export type ContinuationSeedInput = {
  title: string
  genre?: string
  wordCount?: string
  chapters: ContinuationSeedChapterInput[]
  markLastAsPartial?: boolean
  sourceSummary?: string
}

export type ContinuationSeedResult = {
  projectId: string
  volumeId: string
  chapterIds: string[]
  breakpoint: ContinuationBreakpoint
  chapterCount: number
  totalChars: number
}

function nowIso(): string {
  return new Date().toISOString()
}

function newId(prefix: string): string {
  return `${prefix}-${Date.now()}-${randomUUID().slice(0, 8)}`
}

export function buildContinuationSeed(
  workspace: WorkspacePayload,
  input: ContinuationSeedInput,
): { workspace: WorkspacePayload; result: ContinuationSeedResult } {
  const chapters = input.chapters
    .map((chapter) => ({
      title: chapter.title.trim(),
      plainText: chapter.plainText.replace(/\r\n/g, '\n').trim(),
      isPartial: Boolean(chapter.isPartial),
    }))
    .filter((chapter) => chapter.plainText.length > 0)

  if (chapters.length === 0) {
    throw new Error('empty_chapters')
  }

  const projectId = newProjectId()
  const volumeId = newId('volume')
  const outlineItemId = newId('outline')
  const now = nowIso()
  const markLastPartial = Boolean(input.markLastAsPartial)

  const chapterRows = chapters.map((chapter, index) => {
    const isLast = index === chapters.length - 1
    const partial = isLast && (markLastPartial || chapter.isPartial)
    return {
      id: newId('chapter'),
      outlineItemId,
      volumeId,
      title: chapter.title || `第${index + 1}章`,
      summary: partial ? '导入残稿（未完成）' : '导入章节',
      status: partial ? 'draft' : 'review',
      wordTarget: `约 ${chapter.plainText.replace(/\s+/g, '').length}字`,
      content: ensureEditorHtmlContent(chapter.plainText),
    }
  })

  const completedThroughIndex = markLastPartial && chapters.length > 0
    ? Math.max(0, chapters.length - 1)
    : chapters.length

  const lastCompleted =
    completedThroughIndex > 0 ? chapterRows[completedThroughIndex - 1] ?? null : null
  const nextChapter =
    completedThroughIndex < chapterRows.length
      ? chapterRows[completedThroughIndex] ?? null
      : null

  const totalChars = chapters.reduce(
    (sum, chapter) => sum + chapter.plainText.replace(/\s+/g, '').length,
    0,
  )
  const sourceSummary =
    input.sourceSummary?.trim()
    || `${chapterRows.length} 章 · 约 ${Math.round(totalChars / 10000) || '<1'} 万字 · 原稿导入`

  const breakpoint: ContinuationBreakpoint = {
    projectId,
    volumeId,
    completedThroughIndex,
    lastCompletedChapterId: lastCompleted?.id ?? null,
    nextChapterId: nextChapter?.id ?? null,
    lastChapterPartial: Boolean(nextChapter && (markLastPartial || chapters[chapters.length - 1]?.isPartial)),
    importedAt: now,
    sourceSummary,
  }

  const acceptanceDocs = chapterRows
    .slice(0, completedThroughIndex)
    .map((chapter) => ({
      id: newId('knowledge'),
      title: `导入验收 · ${chapter.title}`,
      sourceType: 'chapter-summary',
      sourceLabel: 'writing-journal',
      content: `导入章节已视为完成：${chapter.title}`,
      summary: 'continuation-import-acceptance',
      keywords: [chapter.title, 'writing-journal', 'continuation'],
      metadata: {
        chapterId: chapter.id,
        journalType: 'writing-journal',
        autoAcceptancePassed: true,
        imported: true,
      },
      createdAt: now,
      updatedAt: now,
    }))

  const breakpointDoc = {
    id: newId('knowledge'),
    title: '作品续写断点',
    sourceType: 'canon-fact',
    sourceLabel: CONTINUATION_BREAKPOINT_SOURCE_LABEL,
    content: JSON.stringify(breakpoint, null, 2),
    summary: sourceSummary,
    keywords: ['continuation', 'breakpoint'],
    metadata: {
      ...breakpoint,
      projectId,
    },
    createdAt: now,
    updatedAt: now,
  }

  const projectWs = createEmptyProjectWorkspace()
  projectWs.outlineVolumes = [
    {
      id: volumeId,
      title: CONTINUATION_DEFAULT_VOLUME_TITLE,
      wordTarget: '',
      summary: '由作品续写导入生成的默认分卷',
      sortOrder: 0,
    },
  ]
  const continueOutlineItemId = newId('outline')
  projectWs.outlineItems = [
    {
      id: outlineItemId,
      volumeId,
      title: '已导入正文',
      summary: `已从原稿导入 ${chapterRows.length} 章，可从断点后续写。`,
      // 勿写「N章」，避免自动创作按字数目标再物化空章
      wordTarget: '已导入',
      conflict: '',
      status: 'done',
      sortOrder: 0,
    },
    {
      id: continueOutlineItemId,
      volumeId,
      title: '续写（待写）',
      summary: '断点之后的自动创作占位；可按需改目标章数或拆成多个节点。',
      wordTarget: '3章',
      conflict: '',
      status: 'planned',
      sortOrder: 1,
    },
  ]
  projectWs.chapters = chapterRows
  projectWs.chapterVersions = []

  workspace.projects.push({
    id: projectId,
    title: input.title.trim() || '续写作品',
    genre: input.genre?.trim() || '',
    novelLength: 'long',
    wordCount: input.wordCount?.trim() || '',
    lastEdited: now,
    cover: '',
    targetPlatform: '',
    coverHistory: [],
    writingStylePresetId: 'cinematic-cool',
    writingStylePrompt: '',
    novelWorkflowStages: [],
    projectSkills: [],
    chapterAssistantTemplates: [],
    selectedReferenceWorkIds: [],
  })
  workspace.workspaces[projectId] = projectWs
  workspace.selectedProjectId = projectId
  workspace.knowledgeDocuments = [
    ...(Array.isArray(workspace.knowledgeDocuments) ? workspace.knowledgeDocuments : []),
    ...acceptanceDocs,
    breakpointDoc,
  ]

  return {
    workspace,
    result: {
      projectId,
      volumeId,
      chapterIds: chapterRows.map((chapter) => chapter.id),
      breakpoint,
      chapterCount: chapterRows.length,
      totalChars,
    },
  }
}

export function readContinuationBreakpoint(
  workspace: WorkspacePayload,
  projectId: string,
): ContinuationBreakpoint | null {
  const docs = Array.isArray(workspace.knowledgeDocuments) ? workspace.knowledgeDocuments : []
  for (const raw of docs) {
    if (!raw || typeof raw !== 'object') continue
    const doc = raw as { sourceLabel?: string; metadata?: Record<string, unknown>; content?: string }
    if (doc.sourceLabel !== CONTINUATION_BREAKPOINT_SOURCE_LABEL) continue
    const meta = doc.metadata ?? {}
    if (String(meta.projectId ?? '') !== projectId) continue
    if (
      typeof meta.volumeId === 'string'
      && typeof meta.completedThroughIndex === 'number'
    ) {
      return {
        projectId,
        volumeId: String(meta.volumeId),
        completedThroughIndex: Number(meta.completedThroughIndex),
        lastCompletedChapterId:
          meta.lastCompletedChapterId == null ? null : String(meta.lastCompletedChapterId),
        nextChapterId: meta.nextChapterId == null ? null : String(meta.nextChapterId),
        lastChapterPartial: Boolean(meta.lastChapterPartial),
        importedAt: String(meta.importedAt ?? ''),
        sourceSummary: String(meta.sourceSummary ?? ''),
      }
    }
    try {
      const parsed = JSON.parse(String(doc.content ?? '{}')) as ContinuationBreakpoint
      if (parsed?.projectId === projectId) return parsed
    } catch {
      /* ignore */
    }
  }
  return null
}

export function chaptersFromParsedCandidates(
  candidates: ParsedChapterCandidate[],
): ContinuationSeedChapterInput[] {
  return candidates.map((item) => ({
    title: item.title,
    plainText: item.plainText,
    isPartial: item.isPartial,
  }))
}
