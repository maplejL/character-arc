/**
 * Headless E2E: auto-creation pipeline on local workspace.db
 *
 * Usage:
 *   pnpm test:auto-creation
 *   pnpm test:auto-creation:full
 *   pnpm run auto-creation:e2e -- --max-chapters 5 --list
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { initAssistantRuntimeSchema } from '../electron/main/ai/runtime-v2/conversation-manager'
import { normalizeSettings } from '../electron/main/ai/settings'
import type { AppSettings } from '../electron/main/ai/shared-types'
import {
  readWorkspaceSnapshot,
  writeWorkspaceSnapshot,
} from '../electron/main/workspace-store'
import type { WorkspacePayload } from '../electron/main/workspace-types'
import { buildVolumeChapterQueue } from '../renderer/src/features/autoCreation/buildVolumeChapterQueue'
import { evaluateChapterAcceptanceSync, hasChapterBody } from '../renderer/src/features/autoCreation/evaluateChapterAcceptance'
import {
  runChapterProductionPipeline,
  type ChapterProductionWorkspace,
} from '../renderer/src/features/autoCreation/chapterProductionPipeline'
import { DEFAULT_AUTO_CREATION_CONFIG } from '../renderer/src/features/autoCreation/types'
import { createHeadlessStreamTask } from './headless-stream-task'

function resolveDefaultDbPath(): string {
  const userData =
    process.env.CHARACTERARC_USER_DATA
    || join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'CharacterArc')
  return join(userData, 'data', 'workspace.db')
}

function parseArgs(argv: string[]) {
  let projectId = ''
  let volumeId = ''
  let maxChapters = Number(process.env.E2E_AUTO_CREATION_MAX_CHAPTERS ?? '1')
  let list = false
  let skipClear = false
  let dbPath = resolveDefaultDbPath()
  let modelOverride = process.env.E2E_AUTO_CREATION_MODEL ?? 'deepseek-chat'

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--list') list = true
    else if (arg === '--skip-clear') skipClear = true
    else if (arg === '--project-id') projectId = argv[++i] ?? ''
    else if (arg === '--volume-id') volumeId = argv[++i] ?? ''
    else if (arg === '--max-chapters') maxChapters = Number(argv[++i] ?? '1')
    else if (arg === '--db') dbPath = argv[++i] ?? dbPath
    else if (arg === '--model') modelOverride = argv[++i] ?? modelOverride
    else if (arg === '--help' || arg === '-h') {
      console.log(`Usage:
  pnpm test:auto-creation [-- --max-chapters 5]
  pnpm run auto-creation:e2e -- --list`)
      process.exit(0)
    }
  }

  return { projectId, volumeId, maxChapters, list, skipClear, dbPath, modelOverride }
}

function chapterIdsFromQueue(
  queue: ReturnType<typeof buildVolumeChapterQueue>,
  maxChapters: number,
): string[] {
  const ids: string[] = []
  for (const entry of queue) {
    if (entry.kind === 'chapter') ids.push(entry.chapterId)
    if (ids.length >= maxChapters) break
  }
  return ids
}

function clearChaptersForAutoCreation(
  snapshot: WorkspacePayload,
  projectId: string,
  chapterIds: string[],
): WorkspacePayload {
  const workspace = snapshot.workspaces[projectId]
  if (!workspace) throw new Error(`workspace missing for ${projectId}`)

  const idSet = new Set(chapterIds)
  workspace.chapters = workspace.chapters.map((chapter) =>
    idSet.has(chapter.id)
      ? { ...chapter, content: '', status: 'draft' as const }
      : chapter,
  )

  snapshot.knowledgeDocuments = snapshot.knowledgeDocuments.filter((document) => {
    if (document.sourceLabel !== 'writing-journal') return true
    const chapterId = String(document.metadata?.chapterId ?? '')
    return !idSet.has(chapterId)
  })

  return snapshot
}

function buildProductionWorkspace(
  snapshot: WorkspacePayload,
  projectId: string,
  modelOverride?: string,
): ChapterProductionWorkspace {
  const project = snapshot.projects.find((item) => item.id === projectId)
  const workspace = snapshot.workspaces[projectId]
  if (!project || !workspace) throw new Error('project workspace unavailable')

  const appSettingsRaw = snapshot.appSettings as Record<string, unknown> | undefined
  const appSettings = normalizeSettings({
    provider: String(appSettingsRaw?.provider ?? 'deepseek'),
    model: modelOverride || String(appSettingsRaw?.model ?? 'deepseek-chat'),
    apiKey: String(appSettingsRaw?.apiKey ?? ''),
    baseUrl: String(appSettingsRaw?.baseUrl ?? 'https://api.deepseek.com'),
    embeddingModel: String(appSettingsRaw?.embeddingModel ?? ''),
    imageModel: String(appSettingsRaw?.imageModel ?? ''),
    imageApiKey: String(appSettingsRaw?.imageApiKey ?? ''),
    imageBaseUrl: String(appSettingsRaw?.imageBaseUrl ?? ''),
  }) as AppSettings

  const projectConstraints = snapshot.knowledgeDocuments.filter(
    (document) => document.sourceType === 'canon-fact' && document.sourceLabel === 'global-constraint',
  )

  return {
    appSettings,
    project,
    chapters: workspace.chapters,
    outlineItems: workspace.outlineItems,
    outlineVolumes: workspace.outlineVolumes,
    worldviewEntries: workspace.worldviewEntries,
    characters: workspace.characters,
    organizations: workspace.organizations,
    characterRelationships: workspace.characterRelationships,
    organizationMemberships: workspace.organizationMemberships,
    inspirationEntries: workspace.inspirationEntries,
    plotThreads: workspace.plotThreads,
    knowledgeDocuments: snapshot.knowledgeDocuments,
    projectConstraints,
    referenceWorks: snapshot.referenceWorks,
  }
}

function persistWorkspaceChanges(
  snapshot: WorkspacePayload,
  projectId: string,
  production: ChapterProductionWorkspace,
): void {
  const workspace = snapshot.workspaces[projectId]
  if (!workspace) return
  workspace.chapters = production.chapters
  workspace.outlineItems = production.outlineItems
}

async function main(): Promise<void> {
  const { projectId, volumeId, maxChapters, list, skipClear, dbPath, modelOverride } = parseArgs(process.argv.slice(2))

  if (!existsSync(dbPath)) {
    throw new Error(`workspace.db not found: ${dbPath}`)
  }

  const db = new DatabaseSync(dbPath)
  initAssistantRuntimeSchema(db)
  let snapshot = readWorkspaceSnapshot(db)
  if (!snapshot || snapshot.projects.length === 0) {
    throw new Error('No projects in workspace.db')
  }

  const targetProjectId = projectId || snapshot.selectedProjectId || snapshot.projects[0]!.id
  const project = snapshot.projects.find((item) => item.id === targetProjectId)
  if (!project) throw new Error(`Project not found: ${targetProjectId}`)

  const workspace = snapshot.workspaces[targetProjectId]
  if (!workspace) throw new Error(`Workspace not found: ${targetProjectId}`)

  const volumes = [...workspace.outlineVolumes].sort((a, b) => a.sortOrder - b.sortOrder)
  const targetVolumeId = volumeId || volumes[0]?.id
  const volume = volumes.find((item) => item.id === targetVolumeId)
  if (!volume) throw new Error('No outline volume found')

  const queue = buildVolumeChapterQueue({
    volumeId: targetVolumeId,
    chapters: workspace.chapters,
    outlineItems: workspace.outlineItems,
  })

  if (list) {
    console.log(`Project: ${project.title} (${project.id})`)
    console.log(`Volume: ${volume.title} (${volume.id})`)
    queue.forEach((entry, index) => {
      if (entry.kind === 'chapter') {
        const chapter = workspace.chapters.find((item) => item.id === entry.chapterId)
        console.log(
          `${index + 1}. ${chapter?.title ?? entry.chapterId} | content=${chapter?.content?.length ?? 0}`,
        )
      } else {
        console.log(`${index + 1}. [pending outline] ${entry.outlineItemId}`)
      }
    })
    return
  }

  const chapterIds = chapterIdsFromQueue(queue, maxChapters)
  if (chapterIds.length === 0) throw new Error('No chapters in queue')

  console.log(`[auto-creation-e2e] project=${project.title}`)
  console.log(`[auto-creation-e2e] volume=${volume.title} chapters=${chapterIds.length}`)

  if (!skipClear) {
    snapshot = clearChaptersForAutoCreation(snapshot, targetProjectId, chapterIds)
    writeWorkspaceSnapshot(db, snapshot)
    console.log(`[auto-creation-e2e] cleared ${chapterIds.length} chapter(s) + writing journals`)
  }

  console.log(`[auto-creation-e2e] model=${modelOverride}`)

  const streamTask = createHeadlessStreamTask(
    buildProductionWorkspace(snapshot, targetProjectId, modelOverride).appSettings,
    () => readWorkspaceSnapshot(db),
  )

  const results: Array<{ chapterId: string; title: string; ok: boolean; error?: string }> = []

  for (let index = 0; index < chapterIds.length; index += 1) {
    const chapterId = chapterIds[index]!
    snapshot = readWorkspaceSnapshot(db)!
    const production = buildProductionWorkspace(snapshot, targetProjectId, modelOverride)
    const chapter = production.chapters.find((item) => item.id === chapterId)
    if (!chapter) continue

    console.log(`\n[${index + 1}/${chapterIds.length}] ${chapter.title}`)

    const acceptanceBefore = evaluateChapterAcceptanceSync(chapter, production.knowledgeDocuments)
    if (acceptanceBefore.satisfied) {
      console.log('  skip: already accepted')
      results.push({ chapterId, title: chapter.title, ok: true })
      continue
    }

    const pipelineResult = await runChapterProductionPipeline({
      workspace: production,
      chapterId,
      config: DEFAULT_AUTO_CREATION_CONFIG,
      mode: acceptanceBefore.hasBody ? 'quality-only' : 'full',
      streamTask,
      onProgress: (progress) => {
        console.log(`  · ${progress.step}: ${progress.label}`)
      },
      updateChapterContent: (id, content) => {
        const target = production.chapters.find((item) => item.id === id)
        if (target) target.content = content
      },
      mergeKnowledgeDocuments: (documents) => {
        for (const document of documents) {
          const existingIndex = snapshot!.knowledgeDocuments.findIndex((item) => item.id === document.id)
          if (existingIndex >= 0) snapshot!.knowledgeDocuments[existingIndex] = document
          else snapshot!.knowledgeDocuments.unshift(document)
        }
        production.knowledgeDocuments = snapshot!.knowledgeDocuments
      },
    })

    if (pipelineResult.ok) {
      const targetChapter = production.chapters.find((item) => item.id === chapterId)
      if (targetChapter) {
        targetChapter.status = 'review'
        const outlineItem = targetChapter.outlineItemId
          ? production.outlineItems.find((item) => item.id === targetChapter.outlineItemId)
          : undefined
        if (outlineItem) outlineItem.status = 'done'
      }
    }

    persistWorkspaceChanges(snapshot, targetProjectId, production)
    writeWorkspaceSnapshot(db, snapshot)

    const afterSnapshot = readWorkspaceSnapshot(db)!
    const afterWs = buildProductionWorkspace(afterSnapshot, targetProjectId, modelOverride)
    const afterChapter = afterWs.chapters.find((item) => item.id === chapterId)
    const acceptanceAfter = afterChapter
      ? evaluateChapterAcceptanceSync(afterChapter, afterWs.knowledgeDocuments)
      : { satisfied: false, hasBody: false }

    const hasBody = afterChapter ? hasChapterBody(afterChapter.content) : false
    const ok =
      pipelineResult.ok
      && hasBody
      && pipelineResult.auditPass !== false
      && pipelineResult.finalGatePass !== false
      && pipelineResult.acceptanceRecorded !== false

    results.push({
      chapterId,
      title: chapter.title,
      ok,
      error: ok
        ? undefined
        : pipelineResult.error
          ?? (acceptanceAfter.satisfied ? undefined : 'pipeline or acceptance failed'),
    })

    console.log(
      ok
        ? `  PASS (${afterChapter?.content?.length ?? 0} chars, audit=${pipelineResult.auditPass}, gate=${pipelineResult.finalGatePass})`
        : `  FAIL: ${pipelineResult.error ?? 'acceptance not satisfied'}`,
    )

    if (!ok) break
  }

  const passed = results.filter((item) => item.ok).length
  console.log(`\n[auto-creation-e2e] ${passed}/${results.length} chapters passed`)

  if (passed !== chapterIds.length) {
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
