import { prepareServerAiTask, type PrepareServerAiTaskOptions } from '../ai/prepare-ai-task.js'
import { importAiRuntime } from '../ai/register-electron-mock.js'
import { userDataRoot } from '../ai/user-workspace-run.js'
import { normalizeSettings } from '../../../electron/main/ai/settings.js'
import { buildCapabilityContext, getDefaultCapabilities } from '../../../electron/main/ai/prompts/capability.js'
import type { AutoCreationConfig } from '../services/auto-creation-runs.js'
import { resolveUserProductionAiContext } from '../services/ai-production-config.js'
import {
  convergenceModelsDiffer,
  normalizeChapterProductionModels,
  type ChapterProductionModels,
} from '../../../electron/shared/ai/model-roles.js'
import type { WorkspacePayload } from '../workspace/json-store.js'
import {
  ensureEditorHtmlContent,
  getChapterPreviewText,
  getPlainTextFromEditorContent,
} from './editor-content.js'
import {
  buildChapterRepairContext,
  buildProjectWritingStyleContext,
  buildReferenceStyleContext,
  fitDraftToWordBounds,
  formatMemoForRepair,
  loadPreviousChapterAdvice,
  normalizeChapterMemo,
  normalizeDraftForAutoCreation,
  resolveAutoCreationWordTarget,
  type ChapterAuditPayload,
  type KnowledgeDocument,
} from './pipeline-helpers.js'
import {
  buildChapterProductionContext,
  buildDraftGuardsBlock,
  resolveMaxRepairRounds,
} from './shared/index.js'
import { ChapterConvergenceSession } from './shared/convergence-session.js'
import {
  CHAPTER_PRODUCTION_UNIFIED_SYSTEM,
  buildConvergenceDraftSeedUserTurn,
} from './shared/chapter-production-prompts.js'
import { buildFrozenChapterPrefix } from './frozen-chapter-context.js'
import { runConvergenceLoop } from './convergence-loop.js'
import { pickPolishHints } from './shared/convergence.js'
import { resolveQualityConfig } from './shared/types.js'

export type ChapterStreamTaskName =
  | 'chapter-first-draft'
  | 'chapter-memo'
  | 'chapter-brief'
  | 'chapter-audit'
  | 'chapter-quality-review'
  | 'chapter-repair'
  | 'chapter-final-polish'
  | 'chapter-session-note'
  | 'chapter-analysis'

type ConvergenceStreamPhase = 'chapter-quality-review' | 'chapter-audit' | 'chapter-repair'

export type ChapterPipelineProgress = { step: string; label: string }

export type ChapterPipelineResult = {
  ok: boolean
  mode?: 'full' | 'quality-only'
  finalContent?: string
  auditPass?: boolean
  finalGatePass?: boolean
  acceptanceRecorded?: boolean
  error?: string
  knowledgeDocuments?: KnowledgeDocument[]
}

type ChapterRow = {
  id: string
  title?: string
  summary?: string
  content?: string
  volumeId?: string
  outlineItemId?: string
  status?: string
  wordTarget?: string
}

type VolumeRow = { id: string; title: string; summary?: string }
type OutlineItemRow = {
  id: string
  volumeId: string
  title: string
  sortOrder?: number
  wordTarget?: string
  conflict?: string
  summary?: string
  status?: string
}

type ChapterMemo = {
  currentTask?: string
  emotionArc?: string
  payoffs?: string[]
  doNotDo?: string[]
}

const SESSION_NOTE_MAX_ATTEMPTS = 3
const SESSION_NOTE_RETRY_DELAY_MS = 1500

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function persistChapterSessionNote(input: {
  userId: string
  projectId: string
  chapter: ChapterRow
  chapterMemo?: ChapterMemo
  content: string
  auditPassed: boolean
  signal: AbortSignal
  aiLogContext?: Record<string, unknown>
  prepareOptions?: PrepareServerAiTaskOptions
  onProgress?: (progress: ChapterPipelineProgress) => void
}): Promise<KnowledgeDocument | null> {
  for (let attempt = 1; attempt <= SESSION_NOTE_MAX_ATTEMPTS; attempt += 1) {
    if (input.signal.aborted) return null

    const attemptLabel =
      attempt === 1 ? '正在写入下章建议...' : `正在重试写入下章建议（${attempt}/${SESSION_NOTE_MAX_ATTEMPTS}）...`
    input.onProgress?.({ step: 'session-note', label: attemptLabel })

    try {
      const noteStream = await serverStreamTask(
        input.userId,
        'chapter-session-note',
        {
          projectId: input.projectId,
          chapterTitle: input.chapter.title,
          chapterSummary: input.chapter.summary,
          emotionArc: input.chapterMemo?.emotionArc ?? '',
          endingSnippet: input.content.slice(-200),
          auditSummary: input.auditPassed ? '通过' : '未通过',
        },
        input.signal,
        input.aiLogContext,
        input.prepareOptions,
      )
      const noteResult = noteStream.result as {
        sessionNote?: { craftDecisions: string; effectiveReferences: string; nextChapterAdvice: string }
      } | undefined
      if (noteResult?.sessionNote) {
        const note = noteResult.sessionNote
        const now = new Date().toISOString()
        return {
          id: `journal-${Date.now()}`,
          projectId: input.projectId,
          title: `写作日志｜${input.chapter.title}`,
          sourceType: 'chapter-summary',
          sourceLabel: 'writing-journal',
          content: `技法：${note.craftDecisions}\n参考：${note.effectiveReferences}\n下章建议：${note.nextChapterAdvice}`,
          summary: note.nextChapterAdvice,
          keywords: [input.chapter.title ?? '', 'writing-journal'],
          metadata: {
            chapterId: input.chapter.id,
            journalType: 'writing-journal',
            autoAcceptancePassed: true,
          },
          createdAt: now,
          updatedAt: now,
        }
      }
      console.warn(
        `[chapter-pipeline] session-note empty result for ${input.chapter.id} (attempt ${attempt}/${SESSION_NOTE_MAX_ATTEMPTS})`,
      )
    } catch (error) {
      console.error(
        `[chapter-pipeline] session-note failed for ${input.chapter.id} (attempt ${attempt}/${SESSION_NOTE_MAX_ATTEMPTS}):`,
        error,
      )
    }

    if (attempt < SESSION_NOTE_MAX_ATTEMPTS) {
      await sleep(SESSION_NOTE_RETRY_DELAY_MS)
    }
  }

  return null
}

function runModelOverridesFromConfig(config: AutoCreationConfig): ChapterProductionModels {
  return normalizeChapterProductionModels({
    draftProfileId: config.draftProfileId,
    repairProfileId: config.repairProfileId,
    auditProfileId: config.auditProfileId,
  })
}

export async function serverStreamTask(
  userId: string,
  task: ChapterStreamTaskName,
  context: Record<string, unknown>,
  signal: AbortSignal,
  logContext?: Record<string, unknown>,
  prepareOptions?: PrepareServerAiTaskOptions,
): Promise<{ text: string; result?: unknown }> {
  const prepared = await prepareServerAiTask(
    userId,
    {
      task,
      context: { ...context, ...logContext },
      clientKey: task,
    },
    prepareOptions,
  )
  let streamedContent = ''
  const { streamAiTask } = await importAiRuntime()
  try {
    const response = await prepared.runWithWorkspaceDb(prepared.db, () =>
      streamAiTask(
        prepared.taskPayload,
        { onTextDelta: (delta: string) => { streamedContent += delta } },
        signal,
        prepared.knowledgeContext,
      ),
    )
    const content =
      (response.result as { content?: string } | undefined)?.content?.trim() || streamedContent.trim()
    return { text: content, result: response.result }
  } finally {
    try {
      prepared.db.close()
    } catch {
      /* ignore */
    }
  }
}

function resolveCapabilityUserRules(task: ChapterStreamTaskName): string {
  return buildCapabilityContext(task, getDefaultCapabilities(task)).user
}

async function serverStreamConvergencePhase(
  userId: string,
  phase: ConvergenceStreamPhase,
  session: ChapterConvergenceSession,
  userTurn: string,
  signal: AbortSignal,
  logContext?: Record<string, unknown>,
  prepareOptions?: PrepareServerAiTaskOptions,
): Promise<{ text: string; result?: unknown }> {
  const prepared = await prepareServerAiTask(
    userId,
    {
      task: phase,
      context: { ...logContext },
      clientKey: `convergence:${phase}`,
    },
    prepareOptions,
  )
  const settings = normalizeSettings(prepared.taskPayload.settings)
  const metaLines: string[] = []
  const modelRole = (prepared.taskPayload.settings as { modelRole?: string }).modelRole
  if (modelRole && modelRole !== 'default') metaLines.push(`模型角色: ${modelRole}`)
  const autoCreationRunId = String(logContext?.autoCreationRunId ?? '').trim()
  if (autoCreationRunId) metaLines.push(`自动创作 runId: ${autoCreationRunId}`)
  const chapterTitle = String(logContext?.chapterTitle ?? '').trim()
  if (chapterTitle) metaLines.push(`章节标题: ${chapterTitle}`)

  const { streamChapterConvergencePhase, normalizeConvergencePhaseResult } = await importAiRuntime()
  try {
    const generation = await prepared.runWithWorkspaceDb(prepared.db, () =>
      streamChapterConvergencePhase(
        settings,
        session,
        phase,
        userTurn,
        { onTextDelta: () => {} },
        signal,
        { taskLabel: phase, metaLines },
      ),
    )
    // 传 draftText 以便 chapter-audit 校验 ref 是否真实存在于正文
    const promptInput = {
      context: {
        ...(logContext ?? {}),
        draftText: String(logContext?.draftText ?? ''),
      },
    } as import('../../../../electron/main/ai/tasks/base.js').PromptBuildInput
    return normalizeConvergencePhaseResult(phase, generation.text, undefined, promptInput)
  } finally {
    try {
      prepared.db.close()
    } catch {
      /* ignore */
    }
  }
}

async function loadProjectSkillsContext(
  userId: string,
  projectId: string,
  enabledSkillIds: string[],
): Promise<Array<{ id: string; name: string; description: string; content: string }>> {
  if (enabledSkillIds.length === 0) return []
  const previous = process.env.CHARACTERARC_USER_DATA
  process.env.CHARACTERARC_USER_DATA = userDataRoot(userId)
  try {
    const { refreshRegistry, toContextEntries } = await import('../../../electron/main/ai/skills/index.js')
    await refreshRegistry(projectId)
    const enabled = new Set(enabledSkillIds)
    return toContextEntries(projectId)
      .filter((skill) => enabled.has(skill.id))
      .map((skill) => ({ ...skill, content: skill.content.trim().slice(0, 4000) }))
  } catch {
    return []
  } finally {
    if (previous === undefined) delete process.env.CHARACTERARC_USER_DATA
    else process.env.CHARACTERARC_USER_DATA = previous
  }
}

function buildMemoBaseContext(input: {
  workspace: WorkspacePayload
  projectId: string
  chapter: ChapterRow
  chapterVolume: VolumeRow
  targetWordCount: number
  previousChapterAdvice?: string
}): Record<string, unknown> {
  const ws = input.workspace.workspaces[input.projectId] ?? {}
  const chapters = (Array.isArray(ws.chapters) ? ws.chapters : []) as ChapterRow[]
  const outlineItems = (Array.isArray(ws.outlineItems) ? ws.outlineItems : []) as OutlineItemRow[]
  const plotThreads = (Array.isArray(ws.plotThreads) ? ws.plotThreads : []) as Array<{
    title: string
    description?: string
    status?: string
  }>
  const worldviewEntries = (Array.isArray(ws.worldviewEntries) ? ws.worldviewEntries : []) as Array<{
    title: string
    content: string
  }>
  const characters = (Array.isArray(ws.characters) ? ws.characters : []) as Array<{
    id: string
    name: string
    role?: string
    description?: string
  }>
  const characterRelationships = (Array.isArray(ws.characterRelationships) ? ws.characterRelationships : []) as Array<Record<string, unknown>>
  const knowledgeDocuments = (input.workspace.knowledgeDocuments ?? []) as KnowledgeDocument[]

  const currentChapterIndex = chapters.findIndex((item) => item.id === input.chapter.id)
  const precedingChapters = chapters.slice(0, currentChapterIndex)
  const relatedChapters = precedingChapters.slice(-4).map((item) => ({
    title: item.title,
    summary: item.summary,
    preview: getChapterPreviewText(item.content ?? '').slice(0, 800),
  }))
  const relatedTitles = new Set(relatedChapters.map((entry) => entry.title))
  const volumeChapterSummaries = precedingChapters
    .filter((item) => item.volumeId === input.chapter.volumeId && !relatedTitles.has(item.title ?? ''))
    .map((item) => ({ title: item.title, summary: item.summary }))
  const firstChapter = chapters[0]
  const novelOpenerSummary =
    firstChapter && firstChapter.id !== input.chapter.id && !relatedTitles.has(firstChapter.title ?? '')
      ? { title: firstChapter.title, summary: firstChapter.summary }
      : undefined

  const chaptersWithContent = precedingChapters.filter((item) =>
    Boolean(getPlainTextFromEditorContent(item.content ?? '').trim()),
  )
  const handoffChapter = chaptersWithContent.at(-1)
  const previousChapterHandoff = handoffChapter
    ? {
        title: handoffChapter.title,
        endingText: getPlainTextFromEditorContent(handoffChapter.content ?? '').trim().slice(-800),
      }
    : undefined

  const volumeOutlineItems = outlineItems.filter((item) => item.volumeId === input.chapter.volumeId)
  const currentOutlineItem = input.chapter.outlineItemId
    ? volumeOutlineItems.find((item) => item.id === input.chapter.outlineItemId)
    : volumeOutlineItems.find((item) => item.title?.trim() === input.chapter.title?.trim())

  const productionContext = buildChapterProductionContext({
    chapters,
    outlineItems,
    chapterId: input.chapter.id,
    volumeId: input.chapter.volumeId ?? '',
  })

  return {
    projectId: input.projectId,
    projectGenre: input.workspace.projects.find((p) => p.id === input.projectId)?.genre,
    chapterTitle: input.chapter.title,
    chapterSummary: input.chapter.summary,
    chapterVolumeTitle: input.chapterVolume.title,
    chapterVolumeSummary: input.chapterVolume.summary,
    chapterWordTarget: input.chapter.wordTarget,
    targetWordCount: input.targetWordCount,
    relatedChapters,
    volumeChapterSummaries,
    novelOpenerSummary,
    previousChapterHandoff,
    recentEndingsTrail: productionContext.recentEndingsTrail,
    outlineChapterSplit: productionContext.outlineChapterSplit,
    plotThreads: plotThreads.filter((thread) => thread.status === 'open'),
    worldviewEntries,
    characters: characters.map((character) => ({
      id: character.id,
      name: character.name,
      role: character.role,
      description: character.description,
    })),
    characterRelationships,
    currentOutlineItem: currentOutlineItem
      ? {
          title: currentOutlineItem.title,
          wordTarget: currentOutlineItem.wordTarget,
          conflict: currentOutlineItem.conflict,
          summary: currentOutlineItem.summary,
        }
      : null,
    outlineItems: volumeOutlineItems.slice(0, 6).map((item) => ({
      title: item.title,
      conflict: item.conflict,
      summary: item.summary,
      isCurrent: currentOutlineItem ? item.id === currentOutlineItem.id : false,
    })),
    recentWritingJournals: knowledgeDocuments
      .filter((document) => document.sourceLabel === 'writing-journal')
      .slice(0, 3)
      .map((journal) => ({ title: journal.title, content: journal.content })),
    previousChapterAdvice: input.previousChapterAdvice?.trim() || undefined,
  }
}

function buildChapterFirstDraftContext(input: {
  workspace: WorkspacePayload
  projectId: string
  chapter: ChapterRow
  chapterVolume: VolumeRow
  memoBaseContext: Record<string, unknown>
  targetWordCount: number
  userPrompt: string
  chapterMemo?: ChapterMemo
  chapterBrief?: string
  projectSkills: Array<{ id: string; name: string; description: string; content: string }>
  referenceStyleContext: string
  productionContext: ReturnType<typeof buildChapterProductionContext>
  qualityConfig?: import('./shared/types.js').AutoCreationQualityConfig
}): Record<string, unknown> {
  const project = input.workspace.projects.find((item) => item.id === input.projectId)
  const ws = input.workspace.workspaces[input.projectId] ?? {}
  const writingStyle = buildProjectWritingStyleContext(project ?? {})
  const inspirationEntries = (Array.isArray(ws.inspirationEntries) ? ws.inspirationEntries : [])
    .slice(0, 6)
    .map((entry: { type?: string; title?: string; content?: string; tags?: string[] }) => ({
      type: entry.type,
      title: entry.title,
      content: entry.content,
      tags: entry.tags,
    }))

  return {
    projectId: input.projectId,
    projectTitle: project?.title,
    projectGenre: project?.genre,
    writingStyleLabel: writingStyle.label,
    writingStylePrompt: writingStyle.prompt,
    chapterTitle: input.chapter.title,
    chapterSummary: input.chapter.summary,
    chapterStatus: input.chapter.status,
    chapterWordTarget: input.chapter.wordTarget,
    chapterContent: '',
    chapterHasExistingContent: false,
    targetWordCount: input.targetWordCount,
    chapterVolumeTitle: input.chapterVolume.title,
    chapterVolumeSummary: input.chapterVolume.summary,
    relatedChapters: input.memoBaseContext.relatedChapters,
    volumeChapterSummaries: input.memoBaseContext.volumeChapterSummaries,
    novelOpenerSummary: input.memoBaseContext.novelOpenerSummary ?? null,
    plotThreads: input.memoBaseContext.plotThreads,
    worldviewEntries: input.memoBaseContext.worldviewEntries,
    characters: (Array.isArray(ws.characters) ? ws.characters : []).map(
      (character: { id: string; name: string; role?: string; description?: string }) => ({
        id: character.id,
        name: character.name,
        role: character.role,
        description: character.description,
      }),
    ),
    organizations: ws.organizations ?? [],
    characterRelationships: ws.characterRelationships ?? [],
    organizationMemberships: ws.organizationMemberships ?? [],
    inspirationEntries,
    currentOutlineItem: input.memoBaseContext.currentOutlineItem,
    outlineChapterSplit: input.productionContext.outlineChapterSplit,
    outlineItems: input.memoBaseContext.outlineItems,
    knowledgeDocuments: ((input.workspace.knowledgeDocuments ?? []) as KnowledgeDocument[]).slice(0, 8),
    projectSkills: input.projectSkills,
    userPrompt: input.userPrompt,
    chapterMemo: input.chapterMemo ?? null,
    chapterBrief: input.chapterBrief?.trim() || undefined,
    recentEndingsTrail: input.productionContext.recentEndingsTrail,
    previousChapterHandoff: input.memoBaseContext.previousChapterHandoff ?? null,
    referenceStyleContext: input.referenceStyleContext,
    draftGuardsBlock: buildDraftGuardsBlock(
      input.productionContext,
      input.targetWordCount,
      25,
      input.qualityConfig,
    ),
  }
}

export async function runServerChapterProductionPipeline(input: {
  userId: string
  workspace: WorkspacePayload
  projectId: string
  chapterId: string
  config: AutoCreationConfig
  autoCreationRunId?: string
  mode?: 'full' | 'quality-only'
  signal?: AbortSignal
  onProgress?: (progress: ChapterPipelineProgress) => void
}): Promise<ChapterPipelineResult> {
  const mode = input.mode ?? 'full'
  const ws = input.workspace.workspaces[input.projectId] ?? {}
  const chapters = (Array.isArray(ws.chapters) ? ws.chapters : []) as ChapterRow[]
  const chapter = chapters.find((item) => item.id === input.chapterId)
  if (!chapter) return { ok: false, error: '未找到章节' }

  const volumes = (Array.isArray(ws.outlineVolumes) ? ws.outlineVolumes : []) as VolumeRow[]
  const chapterVolume = volumes.find((volume) => volume.id === chapter.volumeId)
  if (!chapterVolume) return { ok: false, error: '未找到章节所属分卷' }

  const project = input.workspace.projects.find((item) => item.id === input.projectId)
  if (!project) return { ok: false, error: '未找到项目' }

  const config = input.config
  const maxRepairRounds = resolveMaxRepairRounds(config)
  const qualityConfig = resolveQualityConfig({
    openingRecycleMinChars: config.openingRecycleMinChars,
    dialogueRatioMin: config.dialogueRatioMin,
    qualityReviewMaxWarnings: config.qualityReviewMaxWarnings,
    qualityReviewEnabled: config.qualityReviewEnabled,
    narratorTelegraphEnabled: config.narratorTelegraphEnabled,
    chapterBriefEnabled: config.chapterBriefEnabled,
    finalPolishEnabled: config.finalPolishEnabled,
  })
  const outlineItems = (Array.isArray(ws.outlineItems) ? ws.outlineItems : []) as OutlineItemRow[]
  const siblingWordTargets = outlineItems
    .filter((item) => item.volumeId === chapter.volumeId && item.id !== chapter.outlineItemId)
    .map((item) => item.wordTarget)
  const targetWordCount = resolveAutoCreationWordTarget(config, chapter.wordTarget, {
    siblingWordTargets,
    defaultCount: 3000,
  })
  const knowledgeDocuments = (input.workspace.knowledgeDocuments ?? []) as KnowledgeDocument[]
  const previousChapterAdvice = loadPreviousChapterAdvice(chapters, knowledgeDocuments, chapter.id)
  const signal = input.signal ?? new AbortController().signal
  const aiLogContext = {
    autoCreationRunId: input.autoCreationRunId,
    projectId: input.projectId,
    chapterId: input.chapterId,
    chapterTitle: chapter.title,
  }
  const runModelOverrides = runModelOverridesFromConfig(config)
  const prepareOptions: PrepareServerAiTaskOptions = { chapterProductionModels: runModelOverrides }
  const productionCtx = await resolveUserProductionAiContext(input.userId)
  const useConvergenceSession = !convergenceModelsDiffer(
    {
      provider: productionCtx.aiProfiles[0]?.provider ?? 'deepseek',
      model: productionCtx.aiProfiles[0]?.model ?? '',
      apiKey: productionCtx.aiProfiles[0]?.apiKey ?? '',
      baseUrl: productionCtx.aiProfiles[0]?.baseUrl ?? '',
      aiProfiles: productionCtx.aiProfiles,
      activeAiProfileId: productionCtx.activeAiProfileId,
      chapterProductionModels: {
        ...productionCtx.chapterProductionModels,
        ...runModelOverrides,
      },
    },
    runModelOverrides,
  )

  if (signal.aborted) return { ok: false, error: 'canceled' }

  let chapterMemo: ChapterMemo | undefined
  let content = getPlainTextFromEditorContent(chapter.content ?? '').trim()
  const newKnowledgeDocuments: KnowledgeDocument[] = []

  try {
    if (mode === 'full') {
      input.onProgress?.({ step: 'load-advice', label: '读取上章下章建议...' })
      const memoBaseContext = buildMemoBaseContext({
        workspace: input.workspace,
        projectId: input.projectId,
        chapter,
        chapterVolume,
        targetWordCount,
        previousChapterAdvice,
      })
      const writingStyle = buildProjectWritingStyleContext(project)
      const capabilityUserRules = resolveCapabilityUserRules('chapter-memo')
      let frozenProductionPrefix = buildFrozenChapterPrefix({
        capabilityUserRules,
        projectTitle: project.title,
        projectGenre: project.genre,
        writingStyleLabel: writingStyle.label,
        writingStylePrompt: writingStyle.prompt,
        chapterTitle: chapter.title,
        chapterSummary: chapter.summary,
        chapterVolumeTitle: chapterVolume.title,
        chapterVolumeSummary: chapterVolume.summary,
        targetWordCount,
        memoBaseContext,
      })

      input.onProgress?.({ step: 'memo', label: '正在生成写作备忘...' })
      try {
        const memoStream = await serverStreamTask(
          input.userId,
          'chapter-memo',
          { ...memoBaseContext, frozenProductionPrefix },
          signal,
          aiLogContext,
          prepareOptions,
        )
        chapterMemo = normalizeChapterMemo(
          (memoStream.result as { memo?: ChapterMemo } | undefined)?.memo as Record<string, unknown> | undefined,
        ) as ChapterMemo | undefined
      } catch {
        input.onProgress?.({ step: 'memo', label: '写作备忘失败，跳过直接写作...' })
      }

      let chapterBrief: string | undefined
      if (chapterMemo && qualityConfig.chapterBriefEnabled) {
        input.onProgress?.({ step: 'brief', label: '正在生成本章任务书...' })
        try {
          const briefStream = await serverStreamTask(
            input.userId,
            'chapter-brief',
            {
              projectId: input.projectId,
              chapterTitle: chapter.title,
              chapterSummary: chapter.summary,
              targetWordCount,
              chapterMemo,
            },
            signal,
            aiLogContext,
            prepareOptions,
          )
          const briefText = briefStream.text.trim()
          if (briefText.length >= 80) chapterBrief = briefText
        } catch {
          input.onProgress?.({ step: 'brief', label: '任务书生成失败，改用备忘直接写作...' })
        }
      }

      frozenProductionPrefix = buildFrozenChapterPrefix({
        capabilityUserRules,
        projectTitle: project.title,
        projectGenre: project.genre,
        writingStyleLabel: writingStyle.label,
        writingStylePrompt: writingStyle.prompt,
        chapterTitle: chapter.title,
        chapterSummary: chapter.summary,
        chapterVolumeTitle: chapterVolume.title,
        chapterVolumeSummary: chapterVolume.summary,
        targetWordCount,
        memoBaseContext,
        chapterMemo: chapterMemo as Record<string, unknown> | undefined,
      })

      const advicePrompt = previousChapterAdvice ? `\n\n上章下章建议（必须承接）：${previousChapterAdvice}` : ''
      const enabledSkillIds = config.enabledSkillIds ?? []
      const projectSkills = enabledSkillIds.length
        ? await loadProjectSkillsContext(input.userId, input.projectId, enabledSkillIds)
        : []
      const referenceStyleContext = buildReferenceStyleContext(
        config.selectedReferenceWorkIds ?? [],
        (input.workspace.referenceWorks ?? []) as Array<{ id: string; title: string; analysis?: Record<string, unknown> }>,
        knowledgeDocuments,
      )

      const productionContext = buildChapterProductionContext({
        chapters,
        outlineItems,
        chapterId: chapter.id,
        volumeId: chapter.volumeId ?? '',
      })

      const draftContext = buildChapterFirstDraftContext({
        workspace: input.workspace,
        projectId: input.projectId,
        chapter,
        chapterVolume,
        memoBaseContext,
        targetWordCount,
        chapterMemo,
        chapterBrief,
        projectSkills,
        referenceStyleContext,
        productionContext,
        qualityConfig,
        userPrompt: `请生成这一章的完整初稿，目标字数约 ${targetWordCount} 字，全文不得超过 ${Math.round(targetWordCount * 1.25)} 字。优先保证情节完整，但超长会被系统裁切。如果当前正文为空，就从零起稿；如果当前正文不为空，也按整章重写处理，而不是续写。${advicePrompt}${config.userPrompt ? `\n\n补充要求：${config.userPrompt}` : ''}`,
      })

      input.onProgress?.({ step: 'first-draft', label: `正在生成本章初稿（目标约 ${targetWordCount} 字）...` })
      const draftStream = await serverStreamTask(
        input.userId,
        'chapter-first-draft',
        { ...draftContext, frozenProductionPrefix },
        signal,
        aiLogContext,
        prepareOptions,
      )
      content = normalizeDraftForAutoCreation(draftStream.text.trim())
      content = fitDraftToWordBounds(content, targetWordCount)
      if (!content) return { ok: false, mode, error: '初稿生成为空' }
    } else if (!content) {
      return { ok: false, mode, error: '质检模式需要已有正文' }
    } else {
      content = normalizeDraftForAutoCreation(content)
    }

    const memoBaseContext = buildMemoBaseContext({
      workspace: input.workspace,
      projectId: input.projectId,
      chapter,
      chapterVolume,
      targetWordCount,
      previousChapterAdvice,
    })
    const productionContext = buildChapterProductionContext({
      chapters,
      outlineItems,
      chapterId: chapter.id,
      volumeId: chapter.volumeId ?? '',
    })

    const writingStyle = buildProjectWritingStyleContext(project)
    const convergenceFrozenPrefix = buildFrozenChapterPrefix({
      capabilityUserRules: resolveCapabilityUserRules('chapter-quality-review'),
      projectTitle: project.title,
      projectGenre: project.genre,
      writingStyleLabel: writingStyle.label,
      writingStylePrompt: writingStyle.prompt,
      chapterTitle: chapter.title,
      chapterSummary: chapter.summary,
      chapterVolumeTitle: chapterVolume.title,
      chapterVolumeSummary: chapterVolume.summary,
      targetWordCount,
      memoBaseContext,
      chapterMemo: chapterMemo as Record<string, unknown> | undefined,
    })
    const convergenceSession = new ChapterConvergenceSession(
      convergenceFrozenPrefix,
      CHAPTER_PRODUCTION_UNIFIED_SYSTEM,
    )
    convergenceSession.seedWithDraft(
      buildConvergenceDraftSeedUserTurn(convergenceFrozenPrefix, content),
      content,
    )

    const gateResult = await runConvergenceLoop({
      content,
      targetWordCount,
      productionContext,
      chapterMemo: chapterMemo as Record<string, unknown> | undefined,
      maxRounds: maxRepairRounds,
      memoBaseContext,
      projectId: input.projectId,
      chapterId: chapter.id,
      chapterTitle: chapter.title,
      qualityConfig,
      session: useConvergenceSession ? convergenceSession : undefined,
      repairContextBase: {
        ...memoBaseContext,
        projectId: input.projectId,
        chapterTitle: chapter.title,
        chapterSummary: chapter.summary,
        chapterContent: content,
        projectTitle: project.title,
        projectGenre: project.genre,
        writingStyleLabel: project.writingStylePresetId,
        writingStylePrompt: project.writingStylePrompt,
        targetWordCount,
        chapterMemoText: '',
        previousChapterHandoff: productionContext.previousChapterHandoff,
        currentOutlineItem: productionContext.currentOutlineItem,
        outlineChapterSplit: productionContext.outlineChapterSplit,
      },
      streamSessionPhase: useConvergenceSession
        ? async ({ phase, session, userTurn, draftText }) =>
            serverStreamConvergencePhase(
              input.userId,
              phase,
              session,
              userTurn,
              signal,
              { ...aiLogContext, draftText: draftText ?? '' },
              prepareOptions,
            )
        : undefined,
      onDraftRepaired: (repaired) => {
        convergenceSession.resetDraftHistory(
          buildConvergenceDraftSeedUserTurn(convergenceFrozenPrefix, repaired),
          repaired,
        )
      },
      streamTask: async (task, context) =>
        serverStreamTask(input.userId, task, context, signal, aiLogContext, prepareOptions),
      onProgress: (progress) => input.onProgress?.(progress as ChapterPipelineProgress),
    })
    content = fitDraftToWordBounds(gateResult.content, targetWordCount)
    if (!gateResult.audit) {
      // 审查/修复模型未返回可解析结果（模型错误），区别于"质量不达标"
      const reason =
        gateResult.abortReason === 'repair-error'
          ? '修复模型未返回有效内容，请检查修复模型或重试'
          : '审查模型未返回可解析结果，请检查审查模型或重试'
      return { ok: false, mode, finalContent: content, auditPass: false, error: reason }
    }
    if (!gateResult.finalGatePass) {
      input.onProgress?.({ step: 'persist', label: '终检未完全通过，保存草稿并继续...' })
      return {
        ok: true,
        mode,
        finalContent: content,
        auditPass: true,
        finalGatePass: false,
        acceptanceRecorded: false,
      }
    }

    if (qualityConfig.finalPolishEnabled) {
      const polishHints = pickPolishHints(gateResult.qualityIssues ?? [])
      input.onProgress?.({ step: 'final-polish', label: '正在进行终稿润色...' })
      try {
        const writingStyle = buildProjectWritingStyleContext(project)
        const polishStream = await serverStreamTask(
          input.userId,
          'chapter-final-polish',
          {
            projectId: input.projectId,
            chapterTitle: chapter.title,
            chapterSummary: chapter.summary,
            draftText: content,
            targetWordCount,
            polishHints,
            writingStyleLabel: writingStyle.label,
            writingStylePrompt: writingStyle.prompt,
            projectTitle: project.title,
            projectGenre: project.genre,
          },
          signal,
          aiLogContext,
          prepareOptions,
        )
        const polished = normalizeDraftForAutoCreation(polishStream.text.trim())
        if (polished && polished.length > content.length * 0.5) {
          content = fitDraftToWordBounds(polished, targetWordCount)
        }
      } catch {
        input.onProgress?.({ step: 'final-polish', label: '终稿润色失败，保留契约通过稿...' })
      }
    }

    const sessionJournal = await persistChapterSessionNote({
      userId: input.userId,
      projectId: input.projectId,
      chapter,
      chapterMemo,
      content,
      auditPassed: gateResult.audit?.pass === true,
      signal,
      aiLogContext,
      prepareOptions,
      onProgress: (progress) => input.onProgress?.(progress),
    })
    if (sessionJournal) {
      newKnowledgeDocuments.push(sessionJournal)
    } else {
      console.error(
        `[chapter-pipeline] acceptance not recorded for ${chapter.id}: session-note failed after ${SESSION_NOTE_MAX_ATTEMPTS} attempts`,
      )
      input.onProgress?.({
        step: 'session-note',
        label: '下章建议写入失败，本章未记为验收通过',
      })
    }

    const acceptanceRecorded = Boolean(sessionJournal)
    input.onProgress?.({
      step: 'persist',
      label: acceptanceRecorded ? '章节处理完成' : '终检通过但验收记录未写入，已保存草稿',
    })
    return {
      ok: true,
      mode,
      finalContent: ensureEditorHtmlContent(content),
      auditPass: true,
      finalGatePass: true,
      acceptanceRecorded,
      knowledgeDocuments: newKnowledgeDocuments,
    }
  } catch (error) {
    if (error instanceof Error && (error.message === 'canceled' || signal.aborted)) {
      return { ok: false, mode, error: 'canceled' }
    }
    return { ok: false, mode, error: error instanceof Error ? error.message : '章节流水线失败' }
  }
}
