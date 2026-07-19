import { buildChapterFirstDraftContext, type ChapterFirstDraftContextInput } from '@/features/ai/chapterAssistantContext'
import type { FirstDraftConfig } from '@/components/chapterWorkspace/useChapterFirstDraft'
import {
  buildReferenceStyleContext,
} from '@/features/autoCreation/chapterDraftHelpers'
import {
  createChapterStreamTaskClient,
  type ChapterStreamTaskName,
  type ChapterStreamTaskResult
} from '@/features/autoCreation/chapterStreamClient'
import { buildProjectWritingStyleContext } from '@/features/writingStyles/presets'
import { normalizeChapterMemo, normalizeDraftForAutoCreation, fitDraftToWordBounds } from '@/features/autoCreation/finalGate'
import { runConvergenceLoop } from '@/features/autoCreation/convergenceLoop'
import { buildChapterProductionContext, buildDraftGuardsBlock, resolveMaxRepairRounds, resolveQualityConfig, aggregateQualityPitfalls, buildQualityIssueJournal } from '@shared/auto-creation/index'
import { pickPolishHints } from '@shared/auto-creation/convergence'
import { loadPreviousChapterAdvice } from '@/features/autoCreation/advice'
import type { AutoCreationConfig, ChapterPipelineMode, ChapterPipelineProgress, ChapterPipelineResult } from '@/features/autoCreation/types'
import {
  ensureEditorHtmlContent,
  getChapterPreviewText,
  getPlainTextFromEditorContent
} from '@/features/chapters/editorContent'
import { parseChapterWordTarget, resolveAutoCreationWordTarget } from '@/features/chapters/wordTarget'
import { loadEnabledProjectSkillsContext } from '@/features/projectSkills/context'
import type {
  AppSettings,
  ChapterDraft,
  KnowledgeDocument,
  OrganizationEntry,
  OrganizationMembership,
  OutlineItem,
  OutlineVolume,
  PlotThread,
  ProjectSummary,
  CharacterCard,
  CharacterRelationship,
  InspirationEntry,
  ReferenceWorkItem,
  WorldviewEntry
} from '@/types/app'

export interface ChapterProductionWorkspace {
  appSettings: AppSettings
  project: ProjectSummary
  chapters: ChapterDraft[]
  outlineItems: OutlineItem[]
  outlineVolumes: OutlineVolume[]
  worldviewEntries: WorldviewEntry[]
  characters: CharacterCard[]
  organizations: OrganizationEntry[]
  characterRelationships: CharacterRelationship[]
  organizationMemberships: OrganizationMembership[]
  inspirationEntries: InspirationEntry[]
  plotThreads: PlotThread[]
  knowledgeDocuments: KnowledgeDocument[]
  projectConstraints: KnowledgeDocument[]
  referenceWorks: ReferenceWorkItem[]
}

export interface ChapterProductionPipelineInput {
  workspace: ChapterProductionWorkspace
  chapterId: string
  config: AutoCreationConfig | FirstDraftConfig
  mode?: ChapterPipelineMode
  signal?: AbortSignal
  onProgress?: (progress: ChapterPipelineProgress) => void
  onStreamChunk?: (task: ChapterStreamTaskName, delta: string) => void
  updateChapterContent: (chapterId: string, content: string) => void
  mergeKnowledgeDocuments: (documents: KnowledgeDocument[]) => void
  /** Headless E2E / tests: bypass renderer IPC stream client */
  streamTask?: (
    task: ChapterStreamTaskName,
    context: Record<string, unknown>
  ) => Promise<ChapterStreamTaskResult>
}

function getChapterVolume(
  chapter: ChapterDraft,
  volumes: OutlineVolume[]
): OutlineVolume | undefined {
  return volumes.find((volume) => volume.id === chapter.volumeId)
}

function buildMemoBaseContext(input: {
  workspace: ChapterProductionWorkspace
  chapter: ChapterDraft
  chapterVolume: OutlineVolume
  targetWordCount: number
  previousChapterAdvice?: string
}): Record<string, unknown> {
  const { workspace, chapter, chapterVolume, targetWordCount, previousChapterAdvice } = input
  const currentChapterIndex = workspace.chapters.findIndex((item) => item.id === chapter.id)
  const precedingChapters = workspace.chapters
    .slice(0, currentChapterIndex)
    .filter((item) => item.status !== 'quarantine')
  const relatedChapters = precedingChapters.slice(-4).map((item) => ({
    title: item.title,
    summary: item.summary,
    preview: getChapterPreviewText(item.content ?? '').slice(0, 800)
  }))
  const relatedTitles = new Set(relatedChapters.map((entry) => entry.title))
  const volumeChapterSummaries = precedingChapters
    .filter((item) => item.volumeId === chapter.volumeId && !relatedTitles.has(item.title))
    .map((item) => ({ title: item.title, summary: item.summary }))
  const firstChapter = workspace.chapters.find((item) => item.status !== 'quarantine' || item.id === chapter.id)
  const novelOpenerSummary =
    firstChapter && firstChapter.id !== chapter.id && !relatedTitles.has(firstChapter.title)
      ? { title: firstChapter.title, summary: firstChapter.summary }
      : undefined

  const chaptersWithContent = precedingChapters.filter((item) =>
    Boolean(getPlainTextFromEditorContent(item.content ?? '').trim())
  )
  const handoffChapter = chaptersWithContent.at(-1)
  const previousChapterHandoff = handoffChapter
    ? {
        title: handoffChapter.title,
        endingText: getPlainTextFromEditorContent(handoffChapter.content ?? '').trim().slice(-800)
      }
    : undefined

  const recentEndingsTrail = chaptersWithContent
    .slice(0, handoffChapter ? -1 : undefined)
    .slice(-3)
    .map((item) => {
      const plain = getPlainTextFromEditorContent(item.content ?? '').trim()
      const lastLine = plain.split('\n').map((line) => line.trim()).filter(Boolean).at(-1) ?? ''
      return {
        chapterTitle: item.title,
        endingLine: lastLine.length > 80 ? `${lastLine.slice(0, 77)}...` : lastLine
      }
    })
    .filter((entry) => entry.endingLine)

  const volumeOutlineItems = workspace.outlineItems.filter((item) => item.volumeId === chapter.volumeId)
  const currentOutlineItem = chapter.outlineItemId
    ? volumeOutlineItems.find((item) => item.id === chapter.outlineItemId)
    : volumeOutlineItems.find((item) => item.title.trim() === chapter.title.trim())
  const currentChapterOutlineIndex = currentOutlineItem
    ? volumeOutlineItems.findIndex((item) => item.id === currentOutlineItem.id)
    : -1
  const outlineItemsForCurrentChapter = currentChapterOutlineIndex >= 0
    ? volumeOutlineItems.slice(Math.max(0, currentChapterOutlineIndex - 3), currentChapterOutlineIndex + 1)
    : volumeOutlineItems.slice(0, 6)
  const sameOutlineChapters = currentOutlineItem
    ? workspace.chapters.filter((item) =>
        (item.status !== 'quarantine' || item.id === chapter.id)
        && (item.outlineItemId === currentOutlineItem.id
          || (!item.outlineItemId && item.volumeId === currentOutlineItem.volumeId && item.title.trim() === currentOutlineItem.title.trim()))
      )
    : []
  const currentOutlineChapterIndex = sameOutlineChapters.findIndex((item) => item.id === chapter.id)
  const previousSameOutlineChapters = currentOutlineChapterIndex >= 0
    ? sameOutlineChapters.slice(0, currentOutlineChapterIndex)
    : []
  const outlineChapterSplit = currentOutlineItem
    ? {
        currentPart: currentOutlineChapterIndex >= 0 ? currentOutlineChapterIndex + 1 : 1,
        totalParts: Math.max(sameOutlineChapters.length, 1),
        previousParts: previousSameOutlineChapters.map((item) => ({
          title: item.title,
          summary: item.summary,
          preview: getChapterPreviewText(item.content ?? '').slice(0, 220)
        }))
      }
    : null

  const recentJournals = workspace.knowledgeDocuments
    .filter((document) => document.sourceLabel === 'writing-journal')
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
    .slice(0, 3)

  return {
    projectId: workspace.project.id,
    projectGenre: workspace.project.genre,
    chapterTitle: chapter.title,
    chapterSummary: chapter.summary,
    chapterVolumeTitle: chapterVolume.title,
    chapterVolumeSummary: chapterVolume.summary,
    chapterWordTarget: chapter.wordTarget,
    targetWordCount,
    relatedChapters,
    volumeChapterSummaries,
    novelOpenerSummary,
    previousChapterHandoff,
    recentEndingsTrail,
    plotThreads: workspace.plotThreads
      .filter((thread) => thread.status === 'open')
      .map((thread) => ({ title: thread.title, description: thread.description, status: thread.status })),
    worldviewEntries: workspace.worldviewEntries.map((entry) => ({ title: entry.title, content: entry.content })),
    characters: workspace.characters.map((character) => ({
      id: character.id,
      name: character.name,
      role: character.role,
      description: character.description
    })),
    characterRelationships: workspace.characterRelationships.map((relation) => ({
      fromCharacterId: relation.fromCharacterId,
      toCharacterId: relation.toCharacterId,
      type: relation.type,
      description: relation.description,
      intensity: relation.intensity
    })),
    currentOutlineItem: currentOutlineItem
      ? {
          title: currentOutlineItem.title,
          wordTarget: currentOutlineItem.wordTarget,
          conflict: currentOutlineItem.conflict,
          summary: currentOutlineItem.summary
        }
      : null,
    outlineChapterSplit,
    outlineItems: outlineItemsForCurrentChapter.map((item) => ({
      title: item.title,
      conflict: item.conflict,
      summary: item.summary,
      isCurrent: currentOutlineItem ? item.id === currentOutlineItem.id : false
    })),
    recentWritingJournals: recentJournals.map((journal) => ({
      title: journal.title,
      content: journal.content
    })),
    qualityPitfalls: aggregateQualityPitfalls(workspace.knowledgeDocuments),
    previousChapterAdvice: previousChapterAdvice?.trim() || undefined
  }
}

export async function runChapterProductionPipeline(
  input: ChapterProductionPipelineInput
): Promise<ChapterPipelineResult> {
  const mode = input.mode ?? 'full'
  const chapter = input.workspace.chapters.find((item) => item.id === input.chapterId)
  if (!chapter) return { ok: false, error: '未找到章节' }

  const chapterVolume = getChapterVolume(chapter, input.workspace.outlineVolumes)
  if (!chapterVolume) return { ok: false, error: '未找到章节所属分卷' }

  const config = input.config as AutoCreationConfig
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
  const siblingWordTargets = input.workspace.outlineItems
    .filter((item) => item.volumeId === chapter.volumeId && item.id !== chapter.outlineItemId)
    .map((item) => item.wordTarget)
  const targetWordCount = resolveAutoCreationWordTarget(config, chapter.wordTarget, {
    siblingWordTargets,
    defaultCount: 3000,
  })
  const previousChapterAdvice = loadPreviousChapterAdvice(
    input.workspace.chapters,
    input.workspace.knowledgeDocuments,
    chapter.id
  )

  const streamClient = input.streamTask
    ? null
    : createChapterStreamTaskClient({
        appSettings: input.workspace.appSettings,
        onEvent: (payload) => {
          if (payload.type === 'chunk') {
            input.onStreamChunk?.('chapter-first-draft', payload.delta)
          }
        }
      })
  const streamTask =
    input.streamTask
    ?? streamClient!.streamTask.bind(streamClient)

  try {
    if (input.signal?.aborted) throw new Error('canceled')

    let chapterMemo: ChapterFirstDraftContextInput['chapterMemo'] | undefined
    let content = getPlainTextFromEditorContent(chapter.content ?? '').trim()
      ? getPlainTextFromEditorContent(chapter.content ?? '')
      : ''

    if (mode === 'full') {
      input.onProgress?.({ step: 'load-advice', label: '读取上章下章建议...' })
      const memoBaseContext = buildMemoBaseContext({
        workspace: input.workspace,
        chapter,
        chapterVolume,
        targetWordCount,
        previousChapterAdvice
      })

      input.onProgress?.({ step: 'memo', label: '正在生成写作备忘...' })
      try {
        const memoStream = await streamTask('chapter-memo', memoBaseContext)
        const memoResult = memoStream.result as { memo?: ChapterFirstDraftContextInput['chapterMemo'] } | undefined
        chapterMemo = normalizeChapterMemo(memoResult?.memo as Record<string, unknown> | undefined) as typeof chapterMemo
      } catch {
        input.onProgress?.({ step: 'memo', label: '写作备忘失败，跳过直接写作...' })
      }

      let chapterBrief: string | undefined
      if (chapterMemo && qualityConfig.chapterBriefEnabled) {
        input.onProgress?.({ step: 'brief', label: '正在生成本章任务书...' })
        try {
          const briefStream = await streamTask('chapter-brief', {
            projectId: input.workspace.project.id,
            chapterTitle: chapter.title,
            chapterSummary: chapter.summary,
            targetWordCount,
            chapterMemo,
          })
          const briefText = briefStream.text.trim()
          if (briefText.length >= 80) chapterBrief = briefText
        } catch {
          input.onProgress?.({ step: 'brief', label: '任务书生成失败，改用备忘直接写作...' })
        }
      }

      const advicePrompt = previousChapterAdvice
        ? `\n\n上章下章建议（必须承接）：${previousChapterAdvice}`
        : ''
      const draftContext = buildChapterFirstDraftContext({
        project: input.workspace.project,
        chapter,
        chapterVolume,
        relatedChapters: memoBaseContext.relatedChapters as ChapterFirstDraftContextInput['relatedChapters'],
        volumeChapterSummaries: memoBaseContext.volumeChapterSummaries as ChapterFirstDraftContextInput['volumeChapterSummaries'],
        novelOpenerSummary: memoBaseContext.novelOpenerSummary as ChapterFirstDraftContextInput['novelOpenerSummary'],
        worldviewEntries: input.workspace.worldviewEntries,
        characters: input.workspace.characters,
        organizations: input.workspace.organizations,
        characterRelationships: input.workspace.characterRelationships,
        organizationMemberships: input.workspace.organizationMemberships,
        inspirationEntries: input.workspace.inspirationEntries,
        currentOutlineItem: memoBaseContext.currentOutlineItem as ChapterFirstDraftContextInput['currentOutlineItem'],
        outlineChapterSplit: memoBaseContext.outlineChapterSplit as ChapterFirstDraftContextInput['outlineChapterSplit'],
        outlineItems: memoBaseContext.outlineItems as ChapterFirstDraftContextInput['outlineItems'],
        plotThreads: input.workspace.plotThreads,
        knowledgeDocuments: input.workspace.projectConstraints,
        chapterContent: '',
        targetWordCount,
        userPrompt: `请生成这一章的完整初稿，目标字数约 ${targetWordCount} 字，全文不得超过 ${Math.round(targetWordCount * 1.25)} 字。优先保证情节完整，但超长会被系统裁切。如果当前正文为空，就从零起稿；如果当前正文不为空，也按整章重写处理，而不是续写。${advicePrompt}${config.userPrompt ? `\n\n补充要求：${config.userPrompt}` : ''}`,
        projectSkills: (await loadEnabledProjectSkillsContext(input.workspace.project, 'draft'))
          .filter((skill) => config.enabledSkillIds.includes(skill.id)),
        chapterMemo,
        chapterBrief,
        recentEndingsTrail: memoBaseContext.recentEndingsTrail as ChapterFirstDraftContextInput['recentEndingsTrail'],
        previousChapterHandoff: memoBaseContext.previousChapterHandoff as ChapterFirstDraftContextInput['previousChapterHandoff'],
        referenceStyleContext: buildReferenceStyleContext(
          config.selectedReferenceWorkIds,
          input.workspace.referenceWorks,
          input.workspace.knowledgeDocuments
        ),
        draftGuardsBlock: buildDraftGuardsBlock(
          buildChapterProductionContext({
            chapters: input.workspace.chapters,
            outlineItems: input.workspace.outlineItems,
            chapterId: chapter.id,
            volumeId: chapter.volumeId,
          }),
          targetWordCount,
          25,
          qualityConfig,
        ),
      })

      input.onProgress?.({ step: 'first-draft', label: `正在生成本章初稿（目标约 ${targetWordCount} 字）...` })
      const draftStream = await streamTask('chapter-first-draft', draftContext)
      content = normalizeDraftForAutoCreation(draftStream.text.trim())
      content = fitDraftToWordBounds(content, targetWordCount)
      if (!content) return { ok: false, mode, error: '初稿生成为空' }
      input.updateChapterContent(chapter.id, ensureEditorHtmlContent(content))
    } else {
      if (!content) return { ok: false, mode, error: '质检模式需要已有正文' }
      content = normalizeDraftForAutoCreation(content)
    }

    const memoBaseContext = buildMemoBaseContext({
      workspace: input.workspace,
      chapter,
      chapterVolume,
      targetWordCount,
      previousChapterAdvice,
    })
    const productionContext = buildChapterProductionContext({
      chapters: input.workspace.chapters,
      outlineItems: input.workspace.outlineItems,
      chapterId: chapter.id,
      volumeId: chapter.volumeId,
    })

    const gateResult = await runConvergenceLoop({
      content,
      targetWordCount,
      productionContext,
      chapterMemo: chapterMemo as Record<string, unknown> | undefined,
      maxRounds: maxRepairRounds,
      memoBaseContext,
      projectId: input.workspace.project.id,
      chapterId: chapter.id,
      chapterTitle: chapter.title,
      qualityConfig,
      repairContextBase: {
        ...memoBaseContext,
        projectId: input.workspace.project.id,
        chapterTitle: chapter.title,
        chapterSummary: chapter.summary,
        chapterContent: content,
        projectTitle: input.workspace.project.title,
        projectGenre: input.workspace.project.genre,
        writingStyleLabel: input.workspace.project.writingStylePresetId,
        writingStylePrompt: input.workspace.project.writingStylePrompt,
        targetWordCount,
        chapterMemoText: '',
        previousChapterHandoff: productionContext.previousChapterHandoff,
        currentOutlineItem: productionContext.currentOutlineItem,
        outlineChapterSplit: productionContext.outlineChapterSplit,
      },
      streamTask,
      onProgress: input.onProgress,
      onDraftRepaired: (repaired) => {
        input.updateChapterContent(chapter.id, ensureEditorHtmlContent(repaired))
      },
    })
    content = gateResult.content
    if (!gateResult.audit) {
      const reason =
        gateResult.abortReason === 'repair-error'
          ? '修复模型未返回有效内容，请检查修复模型或重试'
          : '审查模型未返回可解析结果，请检查审查模型或重试'
      return {
        ok: false,
        mode,
        finalContent: content,
        auditPass: false,
        error: reason,
      }
    }
    if (!gateResult.finalGatePass) {
      // 终检未过的章把本轮质量坑落库，供后续章 memo 聚合「高频坑」
      const issueJournal = buildQualityIssueJournal({
        projectId: input.workspace.project.id,
        chapter,
        issues: gateResult.qualityIssues ?? [],
        finalGatePass: false,
      })
      if (issueJournal) input.mergeKnowledgeDocuments([issueJournal as KnowledgeDocument])
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
        const writingStyle = buildProjectWritingStyleContext(input.workspace.project)
        const polishStream = await streamTask('chapter-final-polish', {
          projectId: input.workspace.project.id,
          chapterTitle: chapter.title,
          chapterSummary: chapter.summary,
          draftText: content,
          targetWordCount,
          polishHints,
          writingStyleLabel: writingStyle.label,
          writingStylePrompt: writingStyle.prompt,
          projectTitle: input.workspace.project.title,
          projectGenre: input.workspace.project.genre,
        })
        const polished = normalizeDraftForAutoCreation(polishStream.text.trim())
        if (polished && polished.length > content.length * 0.5) {
          content = fitDraftToWordBounds(polished, targetWordCount)
          input.updateChapterContent(chapter.id, ensureEditorHtmlContent(content))
        }
      } catch {
        input.onProgress?.({ step: 'final-polish', label: '终稿润色失败，保留契约通过稿...' })
      }
    }

    const endingSnippet = content.slice(-200)
    const auditSummary = gateResult.audit?.pass ? '通过' : '未通过'
    let acceptanceRecorded = false
    const SESSION_NOTE_MAX_ATTEMPTS = 3
    const SESSION_NOTE_RETRY_DELAY_MS = 1500

    for (let attempt = 1; attempt <= SESSION_NOTE_MAX_ATTEMPTS; attempt += 1) {
      if (input.signal?.aborted) break
      input.onProgress?.({
        step: 'session-note',
        label:
          attempt === 1
            ? '正在写入下章建议...'
            : `正在重试写入下章建议（${attempt}/${SESSION_NOTE_MAX_ATTEMPTS}）...`,
      })
      try {
        const noteStream = await streamTask('chapter-session-note', {
          projectId: input.workspace.project.id,
          chapterTitle: chapter.title,
          chapterSummary: chapter.summary,
          emotionArc: chapterMemo?.emotionArc ?? '',
          endingSnippet,
          auditSummary,
        })
        const noteResult = noteStream.result as {
          sessionNote?: { craftDecisions: string; effectiveReferences: string; nextChapterAdvice: string }
        } | undefined
        if (noteResult?.sessionNote) {
          const note = noteResult.sessionNote
          const now = new Date().toISOString()
          input.mergeKnowledgeDocuments([{
            id: `journal-${Date.now()}`,
            title: `写作日志｜${chapter.title}`,
            sourceType: 'chapter-summary',
            sourceLabel: 'writing-journal',
            content: `技法：${note.craftDecisions}\n参考：${note.effectiveReferences}\n下章建议：${note.nextChapterAdvice}`,
            summary: note.nextChapterAdvice,
            keywords: [chapter.title, 'writing-journal'],
            metadata: { chapterId: chapter.id, journalType: 'writing-journal', autoAcceptancePassed: true },
            createdAt: now,
            updatedAt: now,
          }])
          acceptanceRecorded = true
          break
        }
        console.warn(
          `[chapter-pipeline] session-note empty result for ${chapter.id} (attempt ${attempt}/${SESSION_NOTE_MAX_ATTEMPTS})`,
        )
      } catch (error) {
        console.error(
          `[chapter-pipeline] session-note failed for ${chapter.id} (attempt ${attempt}/${SESSION_NOTE_MAX_ATTEMPTS}):`,
          error,
        )
      }
      if (attempt < SESSION_NOTE_MAX_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, SESSION_NOTE_RETRY_DELAY_MS))
      }
    }

    if (!acceptanceRecorded) {
      console.error(
        `[chapter-pipeline] acceptance not recorded for ${chapter.id}: session-note failed after ${SESSION_NOTE_MAX_ATTEMPTS} attempts`,
      )
      input.onProgress?.({
        step: 'session-note',
        label: '下章建议写入失败，本章未记为验收通过',
      })
    }

    // 本章质量坑（审查/修复发现的 issue）按 category 落库，供后续章 memo 聚合「高频坑」
    const issueJournal = buildQualityIssueJournal({
      projectId: input.workspace.project.id,
      chapter,
      issues: gateResult.qualityIssues ?? [],
      finalGatePass: true,
    })
    if (issueJournal) input.mergeKnowledgeDocuments([issueJournal as KnowledgeDocument])

    input.onProgress?.({
      step: 'persist',
      label: acceptanceRecorded ? '章节处理完成' : '终检通过但验收记录未写入，已保存草稿',
    })
    return {
      ok: true,
      mode,
      finalContent: content,
      auditPass: true,
      finalGatePass: true,
      acceptanceRecorded,
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'canceled') {
      return { ok: false, mode, error: 'canceled' }
    }
    return {
      ok: false,
      mode,
      error: error instanceof Error ? error.message : '章节流水线失败'
    }
  } finally {
    await streamClient?.stop()
  }
}
