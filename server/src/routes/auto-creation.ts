import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { JwtUserPayload } from '../config.js'
import { abortAutoCreationRun, buildRunChapterQueue } from '../auto-creation/worker.js'
import { subscribeAutoCreationRun } from '../auto-creation/ws-hub.js'
import {
  cancelAutoCreationRun,
  createAutoCreationRun,
  getAutoCreationRun,
  pauseAutoCreationRun,
  resumeAutoCreationRun,
} from '../services/auto-creation-runs.js'
import { readUserWorkspace } from '../workspace/json-store.js'

const createRunSchema = z.object({
  volumeId: z.string().min(1),
  /** 从分卷队列该下标起跑（用于作品续写断点后继续） */
  startFromIndex: z.number().int().min(0).optional(),
  /** 从指定章节 ID 起跑（优先于 startFromIndex） */
  startFromChapterId: z.string().min(1).optional(),
  config: z
    .object({
      targetWordCount: z.number().optional(),
      forcedWordCountMin: z.number().int().min(500).max(10000).optional(),
      forcedWordCountMax: z.number().int().min(500).max(10000).optional(),
      maxChapters: z.number().int().min(1).optional(),
      targetOutlineItemId: z.string().min(1).optional(),
      selectedReferenceWorkIds: z.array(z.string()).optional(),
      enabledSkillIds: z.array(z.string()).optional(),
      userPrompt: z.string().optional(),
      maxAuditRepairRounds: z.number().int().min(0).max(30).optional(),
      maxFinalGateRounds: z.number().int().min(0).max(30).optional(),
      maxRepairRounds: z.number().int().min(0).max(30).optional(),
      openingRecycleMinChars: z.number().int().min(10).max(200).optional(),
      dialogueRatioMin: z.number().min(0).max(1).optional(),
      qualityReviewMaxWarnings: z.number().int().min(0).max(10).optional(),
      qualityReviewEnabled: z.boolean().optional(),
      narratorTelegraphEnabled: z.boolean().optional(),
      chapterBriefEnabled: z.boolean().optional(),
      finalPolishEnabled: z.boolean().optional(),
      draftProfileId: z.string().min(1).optional(),
      repairProfileId: z.string().min(1).optional(),
      auditProfileId: z.string().min(1).optional(),
    })
    .optional(),
})

export async function autoCreationRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/api/character-arc/v1/projects/:projectId/auto-creation/runs',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const user = request.user as JwtUserPayload
      const projectId = String((request.params as { projectId?: string }).projectId ?? '')
      const parsed = createRunSchema.safeParse(request.body)
      if (!parsed.success) {
        return reply.status(400).send({ code: 'validation_error', message: parsed.error.message })
      }

      const workspace = await readUserWorkspace(user.sub)
      const project = workspace.projects.find((item) => item.id === projectId)
      if (!project) {
        return reply.status(404).send({ code: 'not_found', message: '项目不存在' })
      }

      const ws = workspace.workspaces[projectId]
      const volumes = Array.isArray((ws as { outlineVolumes?: unknown[] })?.outlineVolumes)
        ? ((ws as { outlineVolumes: Array<{ id: string }> }).outlineVolumes)
        : []
      if (!volumes.some((volume) => volume.id === parsed.data.volumeId)) {
        return reply.status(404).send({ code: 'not_found', message: '分卷不存在' })
      }

      let chapterQueue = await buildRunChapterQueue(user.sub, projectId, parsed.data.volumeId)
      if (chapterQueue.length === 0) {
        return reply.status(400).send({ code: 'empty_queue', message: '分卷没有可处理的章节' })
      }

      if (parsed.data.startFromChapterId) {
        const idx = chapterQueue.indexOf(parsed.data.startFromChapterId)
        if (idx >= 0) chapterQueue = chapterQueue.slice(idx)
      } else if (parsed.data.startFromIndex != null && parsed.data.startFromIndex > 0) {
        chapterQueue = chapterQueue.slice(Math.min(parsed.data.startFromIndex, chapterQueue.length))
      }

      if (chapterQueue.length === 0) {
        return reply.status(400).send({ code: 'empty_queue', message: '断点之后没有可处理的章节' })
      }

      const run = await createAutoCreationRun({
        userId: user.sub,
        projectId,
        volumeId: parsed.data.volumeId,
        config: parsed.data.config ?? {},
        chapterQueue,
      })

      return { success: true, result: { runId: run.id, status: run.status } }
    },
  )

  app.get(
    '/api/character-arc/v1/projects/:projectId/auto-creation/runs/:runId',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const user = request.user as JwtUserPayload
      const runId = String((request.params as { runId?: string }).runId ?? '')
      const run = await getAutoCreationRun(user.sub, runId)
      if (!run) {
        return reply.status(404).send({ code: 'not_found', message: '任务不存在' })
      }
      return { success: true, result: run }
    },
  )

  app.post(
    '/api/character-arc/v1/projects/:projectId/auto-creation/runs/:runId/pause',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const user = request.user as JwtUserPayload
      const runId = String((request.params as { runId?: string }).runId ?? '')
      abortAutoCreationRun(runId)
      const run = await pauseAutoCreationRun(user.sub, runId)
      if (!run) {
        return reply.status(404).send({ code: 'not_found', message: '无法暂停该任务' })
      }
      return { success: true, result: run }
    },
  )

  app.post(
    '/api/character-arc/v1/projects/:projectId/auto-creation/runs/:runId/resume',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const user = request.user as JwtUserPayload
      const runId = String((request.params as { runId?: string }).runId ?? '')
      const run = await resumeAutoCreationRun(user.sub, runId)
      if (!run) {
        return reply.status(404).send({ code: 'not_found', message: '无法恢复该任务' })
      }
      return { success: true, result: run }
    },
  )

  app.post(
    '/api/character-arc/v1/projects/:projectId/auto-creation/runs/:runId/cancel',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const user = request.user as JwtUserPayload
      const runId = String((request.params as { runId?: string }).runId ?? '')
      abortAutoCreationRun(runId)
      const run = await cancelAutoCreationRun(user.sub, runId)
      if (!run) {
        return reply.status(404).send({ code: 'not_found', message: '无法取消该任务' })
      }
      return { success: true, result: run }
    },
  )

  app.get(
    '/ws/character-arc/auto-creation',
    { websocket: true },
    (socket, request) => {
      void (async () => {
        const token = (request.query as { token?: string }).token?.trim()
        if (!token) {
          socket.close(4401, 'unauthorized')
          return
        }

        let user: JwtUserPayload
        try {
          user = await app.jwt.verify<JwtUserPayload>(token)
        } catch {
          socket.close(4401, 'unauthorized')
          return
        }

        const { registerAutoCreationClient } = await import('../auto-creation/ws-hub.js')
        const unregister = registerAutoCreationClient(user.sub, socket)

        socket.on('message', (raw: Buffer | string) => {
          void (async () => {
            try {
              const message = JSON.parse(String(raw)) as { type?: string; runId?: string }
              if (message.type === 'subscribe' && message.runId) {
                subscribeAutoCreationRun(user.sub, socket, message.runId)
                socket.send(JSON.stringify({ type: 'subscribed', runId: message.runId }))
                const run = await getAutoCreationRun(user.sub, message.runId)
                if (run) {
                  socket.send(
                    JSON.stringify({
                      type: 'run-status',
                      runId: run.id,
                      status: run.status,
                      pauseReason: run.pauseReason,
                      message: run.pauseMessage ?? '',
                    }),
                  )
                  if (run.currentStep) {
                    socket.send(
                      JSON.stringify({
                        type: 'step-progress',
                        runId: run.id,
                        chapterId: run.failedChapterId ?? run.chapterQueue[run.currentIndex] ?? '',
                        step: run.currentStep,
                        message: `恢复订阅 · 当前步骤 ${run.currentStep}`,
                      }),
                    )
                  }
                }
              }
            } catch {
              /* ignore malformed */
            }
          })()
        })

        socket.on('close', unregister)
      })()
    },
  )
}
