import { computed, ref, watch } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import { buildVolumeChapterQueue, getTargetOutlineQueueLength, type VolumeChapterQueueEntry } from '@/features/autoCreation/buildVolumeChapterQueue'
import { evaluateChapterAcceptanceSync } from '@/features/autoCreation/evaluateChapterAcceptance'
import { syncOutlineItemStatus } from '@/features/autoCreation/outlineAcceptance'
import {
  runChapterProductionPipeline,
  type ChapterProductionWorkspace
} from '@/features/autoCreation/chapterProductionPipeline'
import {
  clearPersistedAutoCreationLogs,
  clearPersistedAutoCreationRun,
  loadPersistedAutoCreationLogs,
  loadPersistedAutoCreationRun,
  persistAutoCreationLogs,
  persistAutoCreationRun,
} from '@/features/autoCreation/persistRun'
import {
  appendAutoCreationLog,
  progressToLogEntry,
  wsEventToLogEntry,
  type AutoCreationChapterContext,
  type AutoCreationLogEntry,
} from '@/features/autoCreation/logTypes'
import {
  DEFAULT_AUTO_CREATION_CONFIG,
  getAutoCreationEffectiveTotal,
  type AutoCreationConfig,
  type AutoCreationRun,
  type AutoCreationChapterStep,
  type AutoCreationRunStatus,
} from '@/features/autoCreation/types'
import { useAppStore } from '@/stores/app'
import type { OutlineItem } from '@/types/app'

const TASK_KEY_PREFIX = 'auto-creation:'
const TERMINAL_RUN_STATUSES = new Set<AutoCreationRunStatus>(['completed', 'failed'])

function createRunId(): string {
  return `auto-run-${Date.now()}`
}

function mapRemoteStatus(status: string): AutoCreationRunStatus {
  if (status === 'queued' || status === 'running') return 'running'
  if (status === 'cancelled') return 'paused'
  if (status === 'completed' || status === 'paused' || status === 'failed') return status
  return 'paused'
}

function isActiveRemoteStatus(status: string): boolean {
  return status === 'queued' || status === 'running'
}

type RemoteAutoCreationRun = {
  id: string
  projectId: string
  volumeId: string
  status: string
  pauseReason?: string
  pauseMessage?: string
  config: Record<string, unknown>
  chapterQueue: string[]
  currentIndex: number
  currentStep?: string
  completedChapterIds: string[]
  skippedChapterIds: string[]
  failedChapterId?: string
  startedAt?: string
  updatedAt: string
}

function resolveChapterLimit(run: AutoCreationRun, chapterQueueLength: number): number {
  return getAutoCreationEffectiveTotal({
    chapterQueueLength,
    maxChapters: run.config.maxChapters,
    targetOutlineQueueLength: getTargetOutlineQueueLength({
      volumeId: run.volumeId,
      chapters: useAppStore().chapters,
      outlineItems: useAppStore().outlineItems,
      targetOutlineItemId: run.config.targetOutlineItemId,
    }),
  })
}

function buildProgressLabel(run: AutoCreationRun): string {
  const queueLength = run.chapterQueue.length > 0
    ? run.chapterQueue.length
    : buildVolumeChapterQueue({
        volumeId: run.volumeId,
        chapters: useAppStore().chapters,
        outlineItems: useAppStore().outlineItems,
      }).length
  const total = resolveChapterLimit(run, queueLength) || undefined
  const index = run.currentIndex + 1
  const step = run.currentStep
  const completed = run.completedChapterIds.length
  if (run.status === 'completed') return '本分卷自动创作已完成，请 review'
  if (run.status === 'paused' && run.pauseMessage) return run.pauseMessage
  if (step) {
    const prefix = total ? `第 ${Math.min(index, total)}/${total} 章` : `已完成 ${completed} 章`
    return `${prefix} · ${step}`
  }
  if (total) return `第 ${Math.min(index, total)}/${total} 章 · 处理中...`
  return completed > 0 ? `已完成 ${completed} 章 · 处理中...` : '自动创作进行中...'
}

export function useAutoCreationRunner(): {
  activeRun: Ref<AutoCreationRun | null>
  progressLabel: Ref<string>
  logEntries: Ref<AutoCreationLogEntry[]>
  isRunning: Ref<boolean>
  showRunPanel: ComputedRef<boolean>
  canResume: ComputedRef<boolean>
  startVolumeAutoCreation: (
    volumeId: string,
    config?: Partial<AutoCreationConfig>,
    options?: { startFromChapterId?: string },
  ) => Promise<void>
  resumeRun: () => Promise<void>
  pauseRun: () => Promise<void>
  stopRun: () => Promise<void>
  clearRun: () => void
  hydrateFromStorage: () => Promise<void>
} {
  const appStore = useAppStore()
  const activeRun = ref<AutoCreationRun | null>(null)
  const progressLabel = ref('')
  const logEntries = ref<AutoCreationLogEntry[]>([])
  const isRunning = ref(false)
  let abortController: AbortController | null = null
  let unsubscribeWs: (() => void) | null = null
  const chapterContext = ref<AutoCreationChapterContext>({})

  const showRunPanel = computed(() => {
    const run = activeRun.value
    if (!run) return false
    if (!TERMINAL_RUN_STATUSES.has(run.status)) return true
    return logEntries.value.length > 0
  })

  const canResume = computed(() => {
    const run = activeRun.value
    return Boolean(run && run.status === 'paused' && !isRunning.value)
  })

  function buildWorkspace(): ChapterProductionWorkspace | null {
    const project = appStore.currentProject
    if (!project) return null
    return {
      appSettings: appStore.appSettings,
      project,
      chapters: appStore.chapters,
      outlineItems: appStore.outlineItems,
      outlineVolumes: appStore.outlineVolumes,
      worldviewEntries: appStore.worldviewEntries,
      characters: appStore.characters,
      organizations: appStore.organizations,
      characterRelationships: appStore.characterRelationships,
      organizationMemberships: appStore.organizationMemberships,
      inspirationEntries: appStore.inspirationEntries,
      plotThreads: appStore.plotThreads,
      knowledgeDocuments: appStore.knowledgeDocuments,
      projectConstraints: appStore.projectConstraints,
      referenceWorks: appStore.referenceWorks
    }
  }

  function persistLogs(): void {
    const run = activeRun.value
    if (!run) return
    persistAutoCreationLogs(run.id, logEntries.value)
  }

  function pushLog(entry: Omit<AutoCreationLogEntry, 'id' | 'at'> & { id?: string; at?: string }): void {
    logEntries.value = appendAutoCreationLog(logEntries.value, entry)
    persistLogs()
  }

  function touchRun(patch: Partial<AutoCreationRun>): void {
    if (!activeRun.value) return
    activeRun.value = {
      ...activeRun.value,
      ...patch,
      updatedAt: new Date().toISOString()
    }
    persistAutoCreationRun(activeRun.value)
    progressLabel.value = buildProgressLabel(activeRun.value)
  }

  function ingestWsEvent(event: Record<string, unknown>): void {
    const mapped = wsEventToLogEntry(event, chapterContext.value)
    if (!mapped) return
    if (event.type === 'chapter-start') {
      chapterContext.value = {
        chapterId: String(event.chapterId ?? ''),
        chapterTitle: String(event.chapterTitle ?? ''),
        chapterIndex: Number(event.index ?? 0) + 1,
        chapterTotal: Number(event.total ?? 0),
      }
    }
    logEntries.value = appendAutoCreationLog(logEntries.value, mapped)
    persistLogs()
    if (event.type === 'step-progress') {
      progressLabel.value = String(event.message ?? event.step ?? progressLabel.value)
    }
  }

  function detachWebSubscription(): void {
    unsubscribeWs?.()
    unsubscribeWs = null
  }

  function remoteToLocalRun(remote: RemoteAutoCreationRun): AutoCreationRun {
    return {
      id: remote.id,
      projectId: remote.projectId,
      volumeId: remote.volumeId,
      status: mapRemoteStatus(remote.status),
      pauseReason: remote.pauseReason as AutoCreationRun['pauseReason'],
      pauseMessage: remote.pauseMessage,
      config: { ...DEFAULT_AUTO_CREATION_CONFIG, ...(remote.config as Partial<AutoCreationConfig>) },
      chapterQueue: remote.chapterQueue,
      currentIndex: remote.currentIndex,
      currentStep: remote.currentStep as AutoCreationChapterStep | undefined,
      startedAt: remote.startedAt ?? remote.updatedAt,
      updatedAt: remote.updatedAt,
      completedChapterIds: remote.completedChapterIds,
      skippedChapterIds: remote.skippedChapterIds,
      failedChapterId: remote.failedChapterId,
    }
  }

  function applyServerRunState(remote: {
    status: string
    pauseReason?: string
    pauseMessage?: string
    currentIndex?: number
    currentStep?: string
    completedChapterIds?: string[]
    skippedChapterIds?: string[]
    failedChapterId?: string
    chapterQueue?: string[]
  }): void {
    if (!activeRun.value) return
    touchRun({
      status: mapRemoteStatus(remote.status),
      pauseReason: remote.pauseReason as AutoCreationRun['pauseReason'],
      pauseMessage: remote.pauseMessage,
      currentIndex: remote.currentIndex ?? activeRun.value.currentIndex,
      currentStep: remote.currentStep as AutoCreationChapterStep | undefined,
      completedChapterIds: remote.completedChapterIds ?? activeRun.value.completedChapterIds,
      skippedChapterIds: remote.skippedChapterIds ?? activeRun.value.skippedChapterIds,
      failedChapterId: remote.failedChapterId,
      chapterQueue: remote.chapterQueue ?? activeRun.value.chapterQueue,
    })
    isRunning.value = isActiveRemoteStatus(remote.status)
    if (TERMINAL_RUN_STATUSES.has(mapRemoteStatus(remote.status))) {
      isRunning.value = false
    }
  }

  function seedLogsFromRunState(run: AutoCreationRun): void {
    if (logEntries.value.length > 0) return
    const lines: AutoCreationLogEntry[] = []
    if (run.completedChapterIds.length > 0) {
      lines.push({
        id: `seed-completed-${run.id}`,
        at: run.updatedAt,
        level: 'info',
        title: `已恢复任务进度：已完成 ${run.completedChapterIds.length} 章`,
      })
    }
    if (run.currentStep) {
      lines.push({
        id: `seed-step-${run.id}`,
        at: run.updatedAt,
        step: run.currentStep,
        level: 'info',
        title: `当前步骤：${run.currentStep}`,
        detail: run.pauseMessage,
      })
    }
    if (lines.length) {
      logEntries.value = lines
      persistLogs()
    }
  }

  async function syncRunFromServer(projectId: string, runId: string): Promise<void> {
    const webAuto = window.characterArc?.platform === 'web' ? window.characterArc.autoCreation : undefined
    if (!webAuto?.fetchRun) return
    const remote = (await webAuto.fetchRun(projectId, runId)) as RemoteAutoCreationRun
    activeRun.value = remoteToLocalRun(remote)
    persistAutoCreationRun(activeRun.value)
    logEntries.value = loadPersistedAutoCreationLogs(runId)
    seedLogsFromRunState(activeRun.value)
    progressLabel.value = buildProgressLabel(activeRun.value)
    isRunning.value = isActiveRemoteStatus(remote.status)
  }

  function reloadWorkspaceFromServer(): void {
    if (window.characterArc?.platform !== 'web') return
    void appStore.initialize()
  }

  function attachWebRunSubscription(projectId: string, runId: string): void {
    const webAuto = window.characterArc?.platform === 'web' ? window.characterArc.autoCreation : undefined
    if (!webAuto) return
    detachWebSubscription()
    unsubscribeWs = webAuto.subscribeRun(projectId, runId, (event) => {
      ingestWsEvent(event as Record<string, unknown>)
      if (event.type === 'step-progress') {
        touchRun({ currentStep: String(event.step ?? '') as AutoCreationChapterStep })
      }
      if (event.type === 'chapter-start') {
        reloadWorkspaceFromServer()
      }
      if (event.type === 'chapter-complete' && event.chapterId) {
        touchRun({
          completedChapterIds: [...new Set([...(activeRun.value?.completedChapterIds ?? []), String(event.chapterId)])],
        })
        reloadWorkspaceFromServer()
      }
      if (event.type === 'run-status') {
        const status = String(event.status ?? '')
        applyServerRunState({
          status,
          pauseReason: String(event.pauseReason ?? ''),
          pauseMessage: String(event.message ?? ''),
        })
        if (status === 'completed' || status === 'cancelled' || status === 'paused' || status === 'failed') {
          detachWebSubscription()
          if (status === 'completed') {
            clearPersistedAutoCreationRun()
            clearPersistedAutoCreationLogs(runId)
          }
          void appStore.initialize()
        }
      }
      if (event.type === 'run-error') {
        applyServerRunState({
          status: 'paused',
          pauseReason: 'api_error',
          pauseMessage: String(event.message ?? '自动创作失败'),
        })
        detachWebSubscription()
        reloadWorkspaceFromServer()
      }
    })
  }

  function resolveOutlineItem(outlineItemId: string): OutlineItem | undefined {
    return appStore.outlineItems.find((item) => item.id === outlineItemId)
  }

  async function ensureChapterForQueueEntry(entry: VolumeChapterQueueEntry): Promise<string | null> {
    if (entry.kind === 'chapter') return entry.chapterId
    const item = resolveOutlineItem(entry.outlineItemId)
    if (!item) return null
    const linked = appStore.chapters
      .filter((chapter) => chapter.outlineItemId === item.id)
      .sort((a, b) => appStore.chapters.indexOf(a) - appStore.chapters.indexOf(b))
    if (entry.partIndex < linked.length) return linked[entry.partIndex]?.id ?? null
    while (appStore.chapters.filter((chapter) => chapter.outlineItemId === item.id).length <= entry.partIndex) {
      const partIndex = appStore.chapters.filter((chapter) => chapter.outlineItemId === item.id).length
      appStore.createChapterFromOutlineItem(item, {
        navigate: false,
        partIndex,
        totalParts: entry.totalParts,
      })
    }
    return (
      appStore.chapters
        .filter((chapter) => chapter.outlineItemId === item.id)
        .sort((a, b) => appStore.chapters.indexOf(a) - appStore.chapters.indexOf(b))[entry.partIndex]?.id ?? null
    )
  }

  async function processRun(): Promise<void> {
    const run = activeRun.value
    if (!run || run.status !== 'running') return

    const workspace = buildWorkspace()
    if (!workspace) {
      touchRun({ status: 'paused', pauseReason: 'config_error', pauseMessage: '项目不可用' })
      isRunning.value = false
      return
    }

    const queue = buildVolumeChapterQueue({
      volumeId: run.volumeId,
      chapters: appStore.chapters,
      outlineItems: appStore.outlineItems
    })

    const config = run.config
    const chapterLimit = resolveChapterLimit(run, queue.length)
    appStore.relinkOrphanedChapterJournals()

    for (let index = activeRun.value?.currentIndex ?? run.currentIndex; index < chapterLimit; index += 1) {
      if (abortController?.signal.aborted || activeRun.value?.status !== 'running') break

      touchRun({ currentIndex: index, currentStep: 'ensure-chapter' })
      const chapterId = await ensureChapterForQueueEntry(queue[index])
      appStore.relinkOrphanedChapterJournals()
      if (!chapterId) {
        touchRun({
          status: 'paused',
          pauseReason: 'config_error',
          pauseMessage: '无法创建章节',
          failedChapterId: undefined,
          currentIndex: index
        })
        isRunning.value = false
        return
      }

      const chapter = appStore.chapters.find((item) => item.id === chapterId)
      if (!chapter) continue

      touchRun({ currentStep: 'acceptance-check' })
      const acceptance = evaluateChapterAcceptanceSync(chapter, appStore.knowledgeDocuments)
      if (acceptance.satisfied) {
        const skipped = activeRun.value?.skippedChapterIds ?? []
        touchRun({
          skippedChapterIds: [...new Set([...skipped, chapterId])],
          currentIndex: index + 1
        })
        continue
      }

      const mode = acceptance.hasBody ? 'quality-only' : 'full'
      progressLabel.value = `第 ${index + 1}/${chapterLimit} 章 · ${chapter.title}`

      try {
        const result = await appStore.runTrackedAiTask(
          {
            key: `${TASK_KEY_PREFIX}${run.id}`,
            kind: 'chapter-draft',
            label: '自动创作',
            description: progressLabel.value,
            panel: 'outline',
            timeoutMs: 0,
            onCancel: () => void stopRun()
          },
          async () =>
            runChapterProductionPipeline({
              workspace: buildWorkspace()!,
              chapterId,
              config: run.config,
              mode,
              signal: abortController?.signal,
              onProgress: (progress) => {
                touchRun({ currentStep: progress.step as AutoCreationChapterStep })
                progressLabel.value = `第 ${index + 1}/${chapterLimit} 章 · ${progress.label}`
                pushLog(progressToLogEntry(progress, { chapterId, chapterTitle: chapter.title, chapterIndex: index + 1, chapterTotal: chapterLimit }))
              },
              updateChapterContent: (_id, content) => {
                appStore.updateChapter(chapterId, { content })
              },
              mergeKnowledgeDocuments: (documents) => {
                appStore.mergeKnowledgeDocuments(documents)
              }
            })
        )

        if (!result.ok) {
          if (result.error === 'canceled') break
          pushLog({
            level: 'error',
            title: '本章处理失败',
            detail: result.error ?? '章节处理失败',
          })
          touchRun({
            status: 'paused',
            pauseReason: 'api_error',
            pauseMessage: result.error ?? '章节处理失败',
            failedChapterId: chapterId,
            currentIndex: index
          })
          isRunning.value = false
          return
        }

        appStore.updateChapter(chapterId, { status: 'review' })
        const outlineItem = chapter.outlineItemId
          ? appStore.outlineItems.find((item) => item.id === chapter.outlineItemId)
          : undefined
        if (outlineItem) {
          appStore.updateOutlineItem(outlineItem.id, {
            status: syncOutlineItemStatus(
              outlineItem,
              appStore.chapters,
              appStore.knowledgeDocuments,
            ),
          })
        }
        pushLog({
          step: 'persist',
          level: result.acceptanceRecorded === false ? 'warn' : 'success',
          title: '本章完成',
          detail: [
            result.auditPass === false ? '审计：未通过' : '审计：通过',
            result.finalGatePass === false
              ? '终检：未完全通过（已保存草稿）'
              : result.acceptanceRecorded === false
                ? '终检：通过，但验收记录未写入'
                : '终检：通过',
          ].join('\n'),
        })
        touchRun({
          completedChapterIds: [...new Set([...(activeRun.value?.completedChapterIds ?? []), chapterId])],
          currentIndex: index + 1
        })
      } catch (error) {
        pushLog({
          level: 'error',
          title: '本章处理异常',
          detail: error instanceof Error ? error.message : '章节处理失败',
        })
        touchRun({
          status: 'paused',
          pauseReason: 'api_error',
          pauseMessage: error instanceof Error ? error.message : '章节处理失败',
          failedChapterId: chapterId,
          currentIndex: index
        })
        isRunning.value = false
        return
      }
    }

    touchRun({ status: 'completed', currentStep: undefined })
    isRunning.value = false
    progressLabel.value = '本分卷自动创作已完成，请 review'
    clearPersistedAutoCreationRun()
    if (activeRun.value) clearPersistedAutoCreationLogs(activeRun.value.id)
  }

  async function startVolumeAutoCreation(
    volumeId: string,
    config?: Partial<AutoCreationConfig>,
    options?: { startFromChapterId?: string },
  ): Promise<void> {
    if (isRunning.value) return
    const project = appStore.currentProject
    if (!project) return

    const webAuto = window.characterArc?.platform === 'web' ? window.characterArc.autoCreation : undefined
    if (webAuto) {
      isRunning.value = true
      progressLabel.value = '正在启动服务端自动创作...'
      logEntries.value = []
      chapterContext.value = {}
      try {
        const started = await webAuto.startRun(
          project.id,
          volumeId,
          config ?? {},
          options?.startFromChapterId ? { startFromChapterId: options.startFromChapterId } : undefined,
        )
        const run: AutoCreationRun = {
          id: started.runId,
          projectId: project.id,
          volumeId,
          status: 'running',
          config: { ...DEFAULT_AUTO_CREATION_CONFIG, ...config },
          chapterQueue: [],
          currentIndex: 0,
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          completedChapterIds: [],
          skippedChapterIds: [],
        }
        activeRun.value = run
        persistAutoCreationRun(run)
        pushLog({ level: 'info', title: '已提交服务端自动创作任务', detail: `runId: ${started.runId}` })
        attachWebRunSubscription(project.id, started.runId)
      } catch (error) {
        isRunning.value = false
        progressLabel.value = error instanceof Error ? error.message : '启动失败'
        pushLog({ level: 'error', title: '启动失败', detail: progressLabel.value })
      }
      return
    }

    const queue = buildVolumeChapterQueue({
      volumeId,
      chapters: appStore.chapters,
      outlineItems: appStore.outlineItems
    })
    const chapterIds = queue.map((entry) =>
      entry.kind === 'chapter' ? entry.chapterId : `${entry.outlineItemId}#${entry.partIndex}`,
    )
    const startIndex = options?.startFromChapterId
      ? Math.max(
          0,
          queue.findIndex((entry) => entry.kind === 'chapter' && entry.chapterId === options.startFromChapterId),
        )
      : 0

    logEntries.value = []
    chapterContext.value = {}

    const run: AutoCreationRun = {
      id: createRunId(),
      projectId: project.id,
      volumeId,
      status: 'running',
      config: { ...DEFAULT_AUTO_CREATION_CONFIG, ...config },
      chapterQueue: chapterIds,
      currentIndex: startIndex,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      completedChapterIds: [],
      skippedChapterIds: []
    }

    activeRun.value = run
    persistAutoCreationRun(run)
    abortController = new AbortController()
    isRunning.value = true
    await processRun()
  }

  async function resumeRun(): Promise<void> {
    if (!activeRun.value || isRunning.value) return
    const webAuto = window.characterArc?.platform === 'web' ? window.characterArc.autoCreation : undefined
    if (webAuto && activeRun.value) {
      const projectId = activeRun.value.projectId
      const runId = activeRun.value.id
      isRunning.value = true
      touchRun({ status: 'running', pauseReason: undefined, pauseMessage: undefined })
      pushLog({ level: 'info', title: '正在恢复自动创作...' })
      const result = await webAuto.resumeRun(projectId, runId)
      if (!result.ok) {
        isRunning.value = false
        touchRun({ status: 'paused', pauseMessage: result.message ?? '恢复失败' })
        pushLog({ level: 'error', title: '恢复失败', detail: result.message })
        return
      }
      await syncRunFromServer(projectId, runId)
      attachWebRunSubscription(projectId, runId)
      return
    }
    touchRun({ status: 'running', pauseReason: undefined, pauseMessage: undefined })
    abortController = new AbortController()
    isRunning.value = true
    await processRun()
  }

  async function pauseRun(): Promise<void> {
    const webAuto = window.characterArc?.platform === 'web' ? window.characterArc.autoCreation : undefined
    if (webAuto && activeRun.value) {
      const result = await webAuto.pauseRun(activeRun.value.projectId, activeRun.value.id)
      touchRun({ status: 'paused', pauseReason: 'user', pauseMessage: result.message })
      isRunning.value = false
      detachWebSubscription()
      pushLog({ level: 'warn', title: '已暂停自动创作' })
      reloadWorkspaceFromServer()
      return
    }
    abortController?.abort()
    touchRun({ status: 'paused', pauseReason: 'user' })
    isRunning.value = false
  }

  async function stopRun(): Promise<void> {
    const webAuto = window.characterArc?.platform === 'web' ? window.characterArc.autoCreation : undefined
    if (webAuto && activeRun.value) {
      await webAuto.cancelRun(activeRun.value.projectId, activeRun.value.id)
      touchRun({ status: 'paused', pauseReason: 'user', pauseMessage: '用户已停止' })
      isRunning.value = false
      detachWebSubscription()
      pushLog({ level: 'warn', title: '已停止自动创作' })
      return
    }
    abortController?.abort()
    touchRun({ status: 'paused', pauseReason: 'user', pauseMessage: '用户已停止' })
    isRunning.value = false
  }

  function clearRun(): void {
    const runId = activeRun.value?.id
    abortController?.abort()
    detachWebSubscription()
    activeRun.value = null
    isRunning.value = false
    progressLabel.value = ''
    logEntries.value = []
    chapterContext.value = {}
    clearPersistedAutoCreationRun()
    if (runId) clearPersistedAutoCreationLogs(runId)
  }

  async function hydrateFromStorage(): Promise<void> {
    const persisted = loadPersistedAutoCreationRun()
    if (!persisted) return
    if (persisted.projectId !== appStore.currentProject?.id) {
      clearPersistedAutoCreationRun()
      return
    }

    const webAuto = window.characterArc?.platform === 'web' ? window.characterArc.autoCreation : undefined
    if (webAuto?.fetchRun) {
      try {
        await syncRunFromServer(persisted.projectId, persisted.id)
        const run = activeRun.value
        if (!run) return
        if (run.status === 'running') {
          attachWebRunSubscription(persisted.projectId, persisted.id)
        } else if (run.status === 'paused' && !run.pauseMessage) {
          touchRun({ pauseMessage: '页面已刷新，可点击继续恢复任务' })
        }
        return
      } catch {
        /* fall through to local snapshot */
      }
    }

    activeRun.value = persisted
    logEntries.value = loadPersistedAutoCreationLogs(persisted.id)
    seedLogsFromRunState(persisted)
    progressLabel.value = buildProgressLabel(persisted)
    if (persisted.status === 'running') {
      activeRun.value = { ...persisted, status: 'paused', pauseReason: 'user', pauseMessage: '应用重启，请手动继续' }
      persistAutoCreationRun(activeRun.value)
      isRunning.value = false
    }
  }

  watch(isRunning, (running) => {
    window.characterArc?.session?.setAutoCreationActive?.(running)
  }, { immediate: true })

  return {
    activeRun,
    progressLabel,
    logEntries,
    isRunning,
    showRunPanel,
    canResume,
    startVolumeAutoCreation,
    resumeRun,
    pauseRun,
    stopRun,
    clearRun,
    hydrateFromStorage
  }
}
