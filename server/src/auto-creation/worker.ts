import { randomUUID } from 'node:crypto'
import { formatChapterDisplayTitle, countChaptersInVolume } from '../utils/chapter-title.js'

import {

  broadcastAutoCreationEvent,

  type AutoCreationWsEvent,

} from './ws-hub.js'

import {
  claimNextAutoCreationRun,
  getAutoCreationEffectiveTotal,
  getAutoCreationRun,
  updateAutoCreationRun,
  type AutoCreationRunRead,
} from '../services/auto-creation-runs.js'

import { readUserWorkspace, writeUserWorkspace, type WorkspacePayload } from '../workspace/json-store.js'
import { commitChapterEditJson } from '../workspace/chapter-json.js'

import { evaluateChapterAcceptanceSync } from './pipeline-helpers.js'
import { getTargetOutlineQueueLength } from './queue-limit.js'
import { relinkOrphanedWritingJournals, syncOutlineItemStatus, type KnowledgeDocLike } from './shared/index.js'

import { runServerChapterProductionPipeline, serverStreamTask } from './chapter-pipeline.js'



const WORKER_ID = `worker-${randomUUID().slice(0, 8)}`

let pollTimer: ReturnType<typeof setInterval> | null = null

let activeRunId: string | null = null

const abortControllers = new Map<string, AbortController>()



function emit(userId: string, runId: string, event: AutoCreationWsEvent): void {

  broadcastAutoCreationEvent(userId, runId, event)

}



type ChapterDraft = {

  id: string

  title?: string

  summary?: string

  content?: string

  volumeId?: string

  outlineItemId?: string

  status?: string

  wordTarget?: string

}



type OutlineItem = {
  id: string
  volumeId: string
  title: string
  sortOrder: number
  status?: string
  summary?: string
  conflict?: string
  wordTarget?: string
}

const OUTLINE_QUEUE_PREFIX = 'outline:'

function shouldSkipOutlineNodeForAutoCreation(item: { title?: string; wordTarget?: string }): boolean {
  const title = (item.title ?? '').trim()
  const wordTarget = (item.wordTarget ?? '').trim()
  if (/索引条|非单章|写作索引/.test(wordTarget)) return true
  if (/正史总览|写作索引|章级索引/.test(title)) return true
  return false
}

function parseOutlinePlannedChapterCount(value?: string | null): number {
  const raw = (value ?? '').trim()
  if (!raw) return 1
  const rangeChapter = raw.match(/(\d+)\s*[–\-~～—]\s*(\d+)\s*章/)
  if (rangeChapter) {
    const lo = Number.parseInt(rangeChapter[1]!, 10)
    const hi = Number.parseInt(rangeChapter[2]!, 10)
    if (hi >= lo) return Math.max(1, Math.round((lo + hi) / 2))
    return Math.max(1, lo)
  }
  const singleChapter = raw.match(/(\d+)\s*章/)
  if (singleChapter) return Math.max(1, Number.parseInt(singleChapter[1]!, 10))
  return 1
}

function createChapterFromOutlineItem(
  ws: Record<string, unknown>,
  item: OutlineItem,
  options?: { partIndex?: number; totalParts?: number },
): string {
  const chapters = (Array.isArray(ws.chapters) ? ws.chapters : []) as ChapterDraft[]
  const totalParts = Math.max(1, options?.totalParts ?? 1)
  const partIndex = Math.max(0, options?.partIndex ?? 0)
  const baseTitle = item.title?.trim() || '新章节'
  const volumeSequence = countChaptersInVolume(chapters, item.volumeId) + 1
  const title = formatChapterDisplayTitle({
    outlineTitle: baseTitle,
    volumeSequence,
    partIndex,
    totalParts,
  })
  const chapter: ChapterDraft = {
    id: `chapter-${Date.now()}-${randomUUID().slice(0, 8)}`,
    outlineItemId: item.id,
    volumeId: item.volumeId,
    title,
    summary: item.summary?.trim() || '待补充章节摘要',
    status: 'draft',
    wordTarget: item.wordTarget?.trim() || '预估 3000字',
    content: '',
  }
  ws.chapters = [...chapters, chapter]
  return chapter.id
}

function parseOutlineQueueEntry(entryId: string): { outlineItemId: string; partIndex: number } | null {
  if (!entryId.startsWith(OUTLINE_QUEUE_PREFIX)) return null
  const body = entryId.slice(OUTLINE_QUEUE_PREFIX.length)
  const [outlineItemId, partRaw] = body.split(':')
  if (!outlineItemId) return null
  const partIndex = partRaw ? Number.parseInt(partRaw, 10) : 0
  return { outlineItemId, partIndex: Number.isFinite(partIndex) ? partIndex : 0 }
}

function materializeQueueEntry(
  workspace: WorkspacePayload,
  projectId: string,
  entryId: string,
): string | null {
  const parsed = parseOutlineQueueEntry(entryId)
  if (!parsed) return entryId

  const ws = getProjectWorkspace(workspace, projectId)
  const outlineItems = (Array.isArray(ws.outlineItems) ? ws.outlineItems : []) as OutlineItem[]
  const item = outlineItems.find((row) => row.id === parsed.outlineItemId)
  if (!item) return null

  const chapters = (Array.isArray(ws.chapters) ? ws.chapters : []) as ChapterDraft[]
  const linked = chapters.filter((chapter) => chapter.outlineItemId === item.id)
  if (parsed.partIndex < linked.length) return linked[parsed.partIndex]!.id

  const plannedParts = parseOutlinePlannedChapterCount(item.wordTarget)
  while (
    ((Array.isArray(ws.chapters) ? ws.chapters : []) as ChapterDraft[]).filter(
      (chapter) => chapter.outlineItemId === item.id,
    ).length <= parsed.partIndex
  ) {
    const partIndex = ((Array.isArray(ws.chapters) ? ws.chapters : []) as ChapterDraft[]).filter(
      (chapter) => chapter.outlineItemId === item.id,
    ).length
    createChapterFromOutlineItem(ws, item, { partIndex, totalParts: plannedParts })
  }

  const refreshed = (Array.isArray(ws.chapters) ? ws.chapters : []) as ChapterDraft[]
  return refreshed.filter((chapter) => chapter.outlineItemId === item.id)[parsed.partIndex]?.id ?? null
}



function getProjectWorkspace(payload: WorkspacePayload, projectId: string): Record<string, unknown> {

  return payload.workspaces[projectId] ?? {}

}



export function buildVolumeChapterQueue(volumeId: string, payload: WorkspacePayload, projectId: string): string[] {

  const ws = getProjectWorkspace(payload, projectId)

  const chapters = (Array.isArray(ws.chapters) ? ws.chapters : []) as ChapterDraft[]

  const outlineItems = (Array.isArray(ws.outlineItems) ? ws.outlineItems : []) as OutlineItem[]

  const volumeItems = outlineItems

    .filter((item) => item.volumeId === volumeId)

    .sort((a, b) => a.sortOrder - b.sortOrder)

  const volumeChapters = chapters.filter((chapter) => chapter.volumeId === volumeId)

  const queued = new Set<string>()

  const queue: string[] = []



  for (const item of volumeItems) {
    if (shouldSkipOutlineNodeForAutoCreation(item)) continue
    const plannedParts = parseOutlinePlannedChapterCount(item.wordTarget)
    const linked = volumeChapters.filter(
      (chapter) =>
        chapter.outlineItemId === item.id
        || (!chapter.outlineItemId && chapter.volumeId === item.volumeId && chapter.title?.trim() === item.title.trim()),
    )

    for (const chapter of linked) {
      if (queued.has(chapter.id)) continue
      queued.add(chapter.id)
      queue.push(chapter.id)
    }

    for (let partIndex = linked.length; partIndex < plannedParts; partIndex += 1) {
      queue.push(`${OUTLINE_QUEUE_PREFIX}${item.id}:${partIndex}`)
    }
  }



  for (const chapter of volumeChapters) {

    if (!queued.has(chapter.id)) queue.push(chapter.id)

  }



  return queue

}



async function executeRun(run: AutoCreationRunRead): Promise<void> {

  const controller = new AbortController()

  abortControllers.set(run.id, controller)

  activeRunId = run.id



  try {

    emit(run.userId, run.id, { type: 'run-status', runId: run.id, status: 'running' })



    let workspace = await readUserWorkspace(run.userId)

    const project = workspace.projects.find((item) => item.id === run.projectId)

    if (!project) throw new Error('project_not_found')



    const ws = getProjectWorkspace(workspace, run.projectId)

    let chapters = (Array.isArray(ws.chapters) ? ws.chapters : []) as ChapterDraft[]

    const outlineItems = (Array.isArray(ws.outlineItems) ? ws.outlineItems : []) as OutlineItem[]

    const knowledgeDocuments = Array.isArray(workspace.knowledgeDocuments) ? [...workspace.knowledgeDocuments] as KnowledgeDocLike[] : []

    const initialRelink = relinkOrphanedWritingJournals(
      knowledgeDocuments,
      chapters,
      outlineItems,
    )
    if (initialRelink.changed > 0) {
      workspace = { ...workspace, knowledgeDocuments: initialRelink.documents as typeof knowledgeDocuments }
      knowledgeDocuments.splice(0, knowledgeDocuments.length, ...(initialRelink.documents as typeof knowledgeDocuments))
      await writeUserWorkspace(run.userId, workspace)
    }



    const chapterLimit = getAutoCreationEffectiveTotal({
      chapterQueueLength: run.chapterQueue.length,
      maxChapters: run.config.maxChapters,
      targetOutlineQueueLength: getTargetOutlineQueueLength(run.chapterQueue, {
        volumeId: run.volumeId,
        workspace,
        projectId: run.projectId,
        targetOutlineItemId: run.config.targetOutlineItemId,
      }),
    })
    const queue = run.chapterQueue.slice(run.currentIndex, chapterLimit)

    let completed = [...run.completedChapterIds]

    let skipped = [...run.skippedChapterIds]

    let index = run.currentIndex



    for (const queueEntry of queue) {

      const latest = await getAutoCreationRun(run.userId, run.id)

      if (!latest || latest.status === 'cancelled' || latest.status === 'paused') return

      let chapterId = queueEntry
      if (queueEntry.startsWith(OUTLINE_QUEUE_PREFIX)) {
        workspace = await readUserWorkspace(run.userId)
        const materialized = materializeQueueEntry(workspace, run.projectId, queueEntry)
        if (!materialized) {
          index += 1
          continue
        }
        await writeUserWorkspace(run.userId, workspace)
        chapterId = materialized
        const refreshedWs = getProjectWorkspace(workspace, run.projectId)
        chapters = (Array.isArray(refreshedWs.chapters) ? refreshedWs.chapters : []) as ChapterDraft[]
        const relinked = relinkOrphanedWritingJournals(
          knowledgeDocuments,
          chapters,
          outlineItems,
        )
        if (relinked.changed > 0) {
          workspace = { ...workspace, knowledgeDocuments: relinked.documents as typeof knowledgeDocuments }
          knowledgeDocuments.splice(0, knowledgeDocuments.length, ...(relinked.documents as typeof knowledgeDocuments))
          await writeUserWorkspace(run.userId, workspace)
        }
      }

      const chapter = chapters.find((item) => item.id === chapterId)

      if (!chapter) {

        index += 1

        continue

      }



      emit(run.userId, run.id, {

        type: 'chapter-start',

        runId: run.id,

        chapterId,

        index,

        total: chapterLimit,

      })



      await updateAutoCreationRun(run.id, { currentIndex: index, currentStep: 'acceptance-check' })

      const acceptance = evaluateChapterAcceptanceSync(chapter, knowledgeDocuments as never)

      if (acceptance.satisfied) {

        skipped = [...new Set([...skipped, chapterId])]

        index += 1

        await updateAutoCreationRun(run.id, { currentIndex: index, skippedChapterIds: skipped })

        emit(run.userId, run.id, { type: 'chapter-complete', runId: run.id, chapterId, skipped: true })

        continue

      }



      const mode = acceptance.hasBody ? 'quality-only' : 'full'



      const result = await runServerChapterProductionPipeline({

        userId: run.userId,

        workspace,

        projectId: run.projectId,

        chapterId,

        config: run.config,

        mode,

        signal: controller.signal,

        autoCreationRunId: run.id,

        onProgress: (progress) => {

          void updateAutoCreationRun(run.id, { currentStep: progress.step })

          emit(run.userId, run.id, {

            type: 'step-progress',

            runId: run.id,

            chapterId,

            step: progress.step,

            message: progress.label,

          })

        },

      })



      if (!result.ok) {

        if (result.error === 'canceled' || controller.signal.aborted) return

        // 失败章隔离：标记后不再进入后续章的相关上下文（relatedChapters / volumeChapterSummaries 等）
        try {
          const latestWorkspace = await readUserWorkspace(run.userId)
          const latestWs = getProjectWorkspace(latestWorkspace, run.projectId)
          const latestChapters = (Array.isArray(latestWs.chapters) ? latestWs.chapters : []) as ChapterDraft[]
          const failedChapter = latestChapters.find((item) => item.id === chapterId)
          if (failedChapter && failedChapter.status !== 'quarantine') {
            failedChapter.status = 'quarantine'
            latestWs.chapters = latestChapters
            latestWorkspace.workspaces[run.projectId] = latestWs
            await writeUserWorkspace(run.userId, latestWorkspace)
          }
        } catch {
          // 隔离标记失败不阻断暂停流程
        }

        await updateAutoCreationRun(run.id, {

          status: 'paused',

          pauseReason: 'api_error',

          pauseMessage: result.error ?? '章节处理失败',

          failedChapterId: chapterId,

          currentIndex: index,

        })

        emit(run.userId, run.id, {

          type: 'run-error',

          runId: run.id,

          chapterId,

          code: 'api_error',

          message: result.error ?? '章节处理失败',

        })

        emit(run.userId, run.id, {

          type: 'run-status',

          runId: run.id,

          status: 'paused',

          pauseReason: 'api_error',

          message: result.error ?? '章节处理失败',

        })

        return

      }



      const oldContent = String(chapter.content ?? '')
      const newContent = String(result.finalContent ?? chapter.content ?? '')

      // 版本快照：把旧正文存入 chapterVersions，自动创作可追溯/可回滚。
      // 用独立 JSON 事务提交，避免与下方批量写 workspace 冲突。
      try {
        await commitChapterEditJson(run.userId, run.projectId, chapterId, oldContent, newContent)
        // 重新读入，确保本次批量写不会覆盖刚提交的版本
        workspace = await readUserWorkspace(run.userId)
        const refreshed = getProjectWorkspace(workspace, run.projectId)
        chapters = (Array.isArray(refreshed.chapters) ? refreshed.chapters : []) as ChapterDraft[]
        ws.chapters = chapters
      } catch (snapshotError) {
        // 版本快照失败不应阻断主流程，但要留痕
        emit(run.userId, run.id, {
          type: 'run-warning',
          runId: run.id,
          chapterId,
          code: 'version_snapshot_failed',
          message: snapshotError instanceof Error ? snapshotError.message : '版本快照写入失败',
        })
      }

      // 未过审查/终检的章进隔离区：正文保留供追溯与重写，但不再作为后续章的参考上下文
      chapter.status = (result.auditPass === false || result.finalGatePass === false) ? 'quarantine' : 'review'

      ws.chapters = chapters

      workspace.workspaces[run.projectId] = ws



      if (result.knowledgeDocuments?.length) {

        workspace = {

          ...workspace,

          knowledgeDocuments: [...knowledgeDocuments, ...result.knowledgeDocuments],

        }

        knowledgeDocuments.push(...result.knowledgeDocuments)

      }



      const outlineItem = chapter.outlineItemId

        ? outlineItems.find((item) => item.id === chapter.outlineItemId)

        : undefined

      if (outlineItem) {
        outlineItem.status = syncOutlineItemStatus(outlineItem, chapters, knowledgeDocuments)
      }



      await writeUserWorkspace(run.userId, workspace)



      completed = [...new Set([...completed, chapterId])]

      index += 1

      await updateAutoCreationRun(run.id, {

        currentIndex: index,

        completedChapterIds: completed,

        currentStep: 'persist',

      })



      emit(run.userId, run.id, {
        type: 'chapter-complete',
        runId: run.id,
        chapterId,
        auditPass: result.auditPass,
        finalGatePass: result.finalGatePass,
        acceptanceRecorded: result.acceptanceRecorded,
      })

      // 跨章一致性检查：每写完 N 章，对这批章节做一次批次分析，发现 risk 时暂停 run。
      // 这是自动创作特有的风险——逐章过审不代表多章之间人物状态/伏笔/时间线自洽。
      const consistencyInterval = Number(run.config.consistencyCheckInterval ?? 0)
      if (consistencyInterval > 0 && completed.length > 0 && completed.length % consistencyInterval === 0) {
        emit(run.userId, run.id, { type: 'step-progress', runId: run.id, chapterId, step: 'consistency-check', message: `已完成 ${completed.length} 章，正在做跨章一致性检查...` })
        const batch = completed.slice(-consistencyInterval)
        const batchRisks: string[] = []
        for (const batchChapterId of batch) {
          try {
            const batchChapter = chapters.find((c) => c.id === batchChapterId)
            if (!batchChapter) continue
            const analysisStream = await serverStreamTask(
              run.userId,
              'chapter-analysis',
              {
                projectId: run.projectId,
                chapterId: batchChapterId,
                chapterTitle: batchChapter.title,
                chapterSummary: batchChapter.summary,
                chapterContent: batchChapter.content,
                projectTitle: project.title,
                projectGenre: project.genre,
                targetWordCount: run.config.targetWordCount,
              },
              controller.signal,
              { autoCreationRunId: run.id, projectId: run.projectId, chapterId: batchChapterId },
            )
            const risks = (analysisStream.result as { risks?: string[] } | undefined)?.risks ?? []
            batchRisks.push(...risks.filter(Boolean).map((r) => `《${batchChapter.title ?? batchChapterId}》: ${r}`))
          } catch {
            // 单章分析失败不阻断批次
          }
        }
        // 大纲张力边界核对：对照后续未写大纲节点，检查批次正文是否提前消耗关键节拍。
        // 单章 risks 看不到这类跨节点问题（如第 3 章暗示了第 5 节点的身世揭晓）。
        try {
          const volumeItems = outlineItems
            .filter((item) => item.volumeId === run.volumeId && !shouldSkipOutlineNodeForAutoCreation(item))
            .sort((a, b) => a.sortOrder - b.sortOrder)
          const currentChapter = chapters.find((c) => c.id === chapterId)
          const frontierItem = currentChapter?.outlineItemId
            ? volumeItems.find((item) => item.id === currentChapter.outlineItemId)
            : undefined
          const upcoming = (frontierItem
            ? volumeItems.filter((item) => item.sortOrder > frontierItem.sortOrder)
            : volumeItems.filter(
                (item) => !chapters.some((c) => c.outlineItemId === item.id && (c.content ?? '').trim().length > 0),
              )
          ).slice(0, 5)
          if (upcoming.length > 0) {
            const batchText = batch
              .map((batchChapterId) => {
                const c = chapters.find((item) => item.id === batchChapterId)
                if (!c) return ''
                return `《${c.title ?? batchChapterId}》\n${(c.content ?? '').slice(0, 4000)}`
              })
              .filter(Boolean)
              .join('\n\n---\n\n')
            const upcomingOutline = upcoming
              .map(
                (item, i) =>
                  `节点${i + 1}「${item.title}」摘要：${(item.summary ?? '').trim() || '无'}${(item.conflict ?? '').trim() ? ` 冲突：${(item.conflict ?? '').trim()}` : ''}`,
              )
              .join('\n')
            const volumeTitle = (
              (getProjectWorkspace(workspace, run.projectId) as { outlineVolumes?: Array<{ id: string; title?: string }> })
                .outlineVolumes ?? []
            ).find((volume) => volume.id === run.volumeId)?.title ?? ''
            const tensionStream = await serverStreamTask(
              run.userId,
              'outline-tension-check',
              {
                projectTitle: project.title,
                projectGenre: project.genre,
                chapterVolumeTitle: volumeTitle,
                batchText,
                upcomingOutline,
              },
              controller.signal,
              { autoCreationRunId: run.id, projectId: run.projectId },
            )
            const tensionRisks = (tensionStream.result as { risks?: string[] } | undefined)?.risks ?? []
            batchRisks.push(...tensionRisks.filter(Boolean).map((r) => `大纲张力: ${r}`))
          }
        } catch {
          // 边界核对失败不阻断批次
        }
        if (batchRisks.length > 0) {
          const riskSummary = batchRisks.slice(0, 5).join('；')
          emit(run.userId, run.id, {
            type: 'run-warning',
            runId: run.id,
            chapterId,
            code: 'consistency_check_failed',
            message: `跨章一致性检查发现 ${batchRisks.length} 条风险，已暂停：${riskSummary}`,
          })
          await updateAutoCreationRun(run.id, {
            status: 'paused',
            pauseReason: 'quality_limit',
            pauseMessage: `跨章一致性检查发现 ${batchRisks.length} 条风险：${riskSummary}`,
            currentIndex: index,
          })
          emit(run.userId, run.id, { type: 'run-status', runId: run.id, status: 'paused', pauseReason: 'quality_limit', message: `跨章一致性检查发现 ${batchRisks.length} 条风险` })
          return
        }
        emit(run.userId, run.id, { type: 'step-progress', runId: run.id, chapterId, step: 'consistency-check', message: `跨章一致性检查通过（${completed.length} 章）` })
      }
    }



    await updateAutoCreationRun(run.id, {

      status: 'completed',

      currentStep: null,

      finishedAt: new Date(),

    })

    emit(run.userId, run.id, {

      type: 'run-complete',

      runId: run.id,

      completedCount: completed.length,

      skippedCount: skipped.length,

    })

    emit(run.userId, run.id, { type: 'run-status', runId: run.id, status: 'completed' })

  } catch (error) {

    if (controller.signal.aborted) return

    const message = error instanceof Error ? error.message : 'auto_creation_failed'

    await updateAutoCreationRun(run.id, {

      status: 'paused',

      pauseReason: 'api_error',

      pauseMessage: message,

    })

    emit(run.userId, run.id, {

      type: 'run-error',

      runId: run.id,

      code: 'api_error',

      message,

    })

    emit(run.userId, run.id, {

      type: 'run-status',

      runId: run.id,

      status: 'paused',

      pauseReason: 'api_error',

      message,

    })

  } finally {

    abortControllers.delete(run.id)

    if (activeRunId === run.id) activeRunId = null

  }

}



async function pollRuns(): Promise<void> {

  if (activeRunId) return

  const claimed = await claimNextAutoCreationRun(WORKER_ID)

  if (!claimed) return

  await executeRun(claimed)

}



export function startAutoCreationWorker(): void {

  if (pollTimer) return

  pollTimer = setInterval(() => {

    void pollRuns().catch((err) => console.error('[auto-creation-worker]', err))

  }, 2000)

  console.log(`[auto-creation-worker] started ${WORKER_ID}`)

}



export function stopAutoCreationWorker(): void {

  if (pollTimer) {

    clearInterval(pollTimer)

    pollTimer = null

  }

}



export function abortAutoCreationRun(runId: string): void {

  abortControllers.get(runId)?.abort()

}



export async function buildRunChapterQueue(
  userId: string,
  projectId: string,
  volumeId: string,
): Promise<string[]> {
  const workspace = await readUserWorkspace(userId)
  // 仅规划队列，不在 HTTP 请求里批量建章（数百章会阻塞事件循环）
  return buildVolumeChapterQueue(volumeId, workspace, projectId)
}


