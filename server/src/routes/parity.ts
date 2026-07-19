import JSZip from 'jszip'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { JwtUserPayload } from '../config.js'
import { emitProgress, PROGRESS_CHANNELS, subscribeProgress } from '../events/progress-hub.js'
import {
  assistantSessionCreate,
  assistantSessionDelete,
  assistantSessionList,
  assistantSessionLoad,
  assistantSessionRename,
  assistantStageAccept,
  assistantStageBindTarget,
  assistantStageCommit,
  assistantStageList,
  assistantStageReject,
  assistantTurnCancel,
  assistantTurnSend,
  legacySessionDelete,
  legacySessionList,
  legacySessionLoad,
  legacySessionSave,
} from '../assistant/server-assistant.js'
import { runWithUserWorkspace } from '../ai/user-workspace-run.js'
import { prepareServerAiTask } from '../ai/prepare-ai-task.js'
import { importAiRuntime } from '../ai/register-electron-mock.js'
import { startServerAgentStream } from '../ai/run-agent-stream.js'
import { resolveUserAppSettings } from '../ai/settings.js'
import { readChapterVersionFromJsonWorkspace } from '../workspace/chapter-json.js'
import { exportCarcBuffer } from '../workspace/carc-export.js'
import { importReferenceNovelFromPath } from '../services/reference-import.js'

const spiralControllers = new Map<string, AbortController>()
const batchBookControllers = new Map<string, Map<string, AbortController>>()

function writeSse(reply: import('fastify').FastifyReply, data: unknown): void {
  reply.raw.write(`data: ${JSON.stringify(data)}\n\n`)
}

export async function parityRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/character-arc/v1/events/:channel',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const user = request.user as JwtUserPayload
      const channel = String((request.params as { channel?: string }).channel ?? '')

      reply.hijack()
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      })

      let closed = false
      const finish = (): void => {
        if (closed) return
        closed = true
        unsubscribe()
        reply.raw.end()
      }

      const unsubscribe = subscribeProgress(user.sub, channel, (event) => {
        writeSse(reply, event)
      })

      request.raw.on('close', finish)
    },
  )

  app.post('/api/character-arc/v1/assistant/session/list', { preHandler: [app.authenticate] }, async (request) => {
    const user = request.user as JwtUserPayload
    return assistantSessionList(user.sub, request.body as never)
  })

  app.post('/api/character-arc/v1/assistant/session/create', { preHandler: [app.authenticate] }, async (request) => {
    const user = request.user as JwtUserPayload
    return assistantSessionCreate(user.sub, request.body as never)
  })

  app.post('/api/character-arc/v1/assistant/session/delete', { preHandler: [app.authenticate] }, async (request) => {
    const user = request.user as JwtUserPayload
    return assistantSessionDelete(user.sub, request.body as never)
  })

  app.post('/api/character-arc/v1/assistant/session/load', { preHandler: [app.authenticate] }, async (request) => {
    const user = request.user as JwtUserPayload
    return assistantSessionLoad(user.sub, request.body as never)
  })

  app.post('/api/character-arc/v1/assistant/session/rename', { preHandler: [app.authenticate] }, async (request) => {
    const user = request.user as JwtUserPayload
    return assistantSessionRename(user.sub, request.body as never)
  })

  app.post('/api/character-arc/v1/assistant/turn/send', { preHandler: [app.authenticate] }, async (request, reply) => {
    const user = request.user as JwtUserPayload
    try {
      return await assistantTurnSend(user.sub, request.body as never)
    } catch (err) {
      return reply.status(503).send({
        code: 'assistant_failed',
        message: err instanceof Error ? err.message : '助手请求失败',
      })
    }
  })

  app.post('/api/character-arc/v1/assistant/turn/cancel', { preHandler: [app.authenticate] }, async (request) => {
    const user = request.user as JwtUserPayload
    return assistantTurnCancel(user.sub, request.body as never)
  })

  app.post('/api/character-arc/v1/assistant/stage/list', { preHandler: [app.authenticate] }, async (request) => {
    const user = request.user as JwtUserPayload
    return assistantStageList(user.sub, request.body as never)
  })

  app.post('/api/character-arc/v1/assistant/stage/accept', { preHandler: [app.authenticate] }, async (request) => {
    const user = request.user as JwtUserPayload
    return assistantStageAccept(user.sub, request.body as never)
  })

  app.post('/api/character-arc/v1/assistant/stage/reject', { preHandler: [app.authenticate] }, async (request) => {
    const user = request.user as JwtUserPayload
    return assistantStageReject(user.sub, request.body as never)
  })

  app.post('/api/character-arc/v1/assistant/stage/commit', { preHandler: [app.authenticate] }, async (request) => {
    const user = request.user as JwtUserPayload
    return assistantStageCommit(user.sub, request.body as never)
  })

  app.post('/api/character-arc/v1/assistant/stage/bind-target', { preHandler: [app.authenticate] }, async (request) => {
    const user = request.user as JwtUserPayload
    return assistantStageBindTarget(user.sub, request.body as never)
  })

  app.get('/api/character-arc/v1/sessions', { preHandler: [app.authenticate] }, async (request) => {
    const user = request.user as JwtUserPayload
    const projectId = String((request.query as { projectId?: string }).projectId ?? '')
    return legacySessionList(user.sub, projectId)
  })

  app.get('/api/character-arc/v1/sessions/:sessionId', { preHandler: [app.authenticate] }, async (request) => {
    const user = request.user as JwtUserPayload
    const sessionId = String((request.params as { sessionId?: string }).sessionId ?? '')
    return legacySessionLoad(user.sub, sessionId)
  })

  app.put('/api/character-arc/v1/sessions/:sessionId', { preHandler: [app.authenticate] }, async (request) => {
    const user = request.user as JwtUserPayload
    const sessionId = String((request.params as { sessionId?: string }).sessionId ?? '')
    const body = request.body as Record<string, unknown>
    return legacySessionSave(user.sub, { ...body, id: sessionId } as never)
  })

  app.delete('/api/character-arc/v1/sessions/:sessionId', { preHandler: [app.authenticate] }, async (request) => {
    const user = request.user as JwtUserPayload
    const sessionId = String((request.params as { sessionId?: string }).sessionId ?? '')
    return legacySessionDelete(user.sub, sessionId)
  })

  app.get(
    '/api/character-arc/v1/projects/:projectId/chapters/versions/:versionId',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const user = request.user as JwtUserPayload
      const projectId = String((request.params as { projectId?: string }).projectId ?? '')
      const versionId = String((request.params as { versionId?: string }).versionId ?? '')
      const { readUserWorkspace } = await import('../workspace/json-store.js')
      const payload = await readUserWorkspace(user.sub)
      const result = readChapterVersionFromJsonWorkspace(payload, projectId, versionId)
      if (!result) {
        return reply.status(404).send({ code: 'not_found', message: '版本不存在' })
      }
      return { success: true, result }
    },
  )

  app.post('/api/character-arc/v1/ai/agent-stream/start', { preHandler: [app.authenticate] }, async (request) => {
    const user = request.user as JwtUserPayload
    const streamId = `agent-${randomUUID()}`
    startServerAgentStream(user.sub, request.body as never, streamId)
    return { success: true, result: { streamId } }
  })

  app.get('/api/character-arc/v1/ai/image-models', { preHandler: [app.authenticate] }, async (request) => {
    const user = request.user as JwtUserPayload
    const settings = await resolveUserAppSettings(user.sub)
    const { fetchImageModels } = await import('../../../electron/main/ai/transport/models.js')
    const result = await fetchImageModels(settings as never)
    return { success: true, result }
  })

  app.post('/api/character-arc/v1/ai/generate-image', { preHandler: [app.authenticate] }, async (request) => {
    const user = request.user as JwtUserPayload
    const body = request.body as { prompt?: string; projectId?: string }
    const settings = await resolveUserAppSettings(user.sub)
    const { generateImage } = await import('../../../electron/main/ai/transport/images.js')
    try {
      const prompt = String(body.prompt ?? '').trim()
      if (!prompt) throw new Error('图片生成提示词不能为空。')
      const result = await generateImage(settings as never, prompt)
      return { success: true, result }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : '图片生成失败' }
    }
  })

  app.get(
    '/api/character-arc/v1/projects/:projectId/story-state',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const user = request.user as JwtUserPayload
      const projectId = String((request.params as { projectId?: string }).projectId ?? '')
      try {
        const result = await runWithUserWorkspace(user.sub, async (ctx) => {
          const { buildStoryStateContext } = await import('../../../electron/main/story-state-store.js')
          return buildStoryStateContext(ctx.db, projectId, [])
        })
        return { success: true, result }
      } catch (err) {
        return reply.status(503).send({
          code: 'story_state_failed',
          message: err instanceof Error ? err.message : '读取世界状态失败',
        })
      }
    },
  )

  app.post('/api/character-arc/v1/ai/spiral-bootstrap', { preHandler: [app.authenticate] }, async (request) => {
    const user = request.user as JwtUserPayload
    const controller = new AbortController()
    spiralControllers.set(user.sub, controller)
    try {
      const body = request.body as Record<string, unknown>
      const settings = await resolveUserAppSettings(user.sub)
      const { runSpiralBootstrap } = await import('../../../electron/main/ai/spiral/pipeline.js')
      const input = {
        settings: { ...settings, ...(body.settings as object) },
        projectTitle: String(body.projectTitle ?? ''),
        projectGenre: String(body.projectGenre ?? ''),
        projectNovelLength: body.projectNovelLength === 'short' ? 'short' : 'long',
        projectPremise: String(body.projectPremise ?? ''),
        projectId: body.projectId,
        projectSkills: body.projectSkills,
      } as never
      const result = await runSpiralBootstrap(
        input,
        (progressEvent) => emitProgress(user.sub, PROGRESS_CHANNELS.spiral, progressEvent),
        controller.signal,
      )
      return { success: true, result }
    } catch (err) {
      if (controller.signal.aborted) return { success: false, error: '螺旋生成已取消' }
      return { success: false, error: err instanceof Error ? err.message : '螺旋生成失败' }
    } finally {
      spiralControllers.delete(user.sub)
    }
  })

  app.post('/api/character-arc/v1/ai/spiral-cancel', { preHandler: [app.authenticate] }, async (request) => {
    const user = request.user as JwtUserPayload
    const controller = spiralControllers.get(user.sub)
    if (!controller) return { success: false, error: '没有正在进行的螺旋生成任务' }
    controller.abort()
    return { success: true }
  })

  app.post('/api/character-arc/v1/ai/backfill-state', { preHandler: [app.authenticate] }, async (request, reply) => {
    const user = request.user as JwtUserPayload
    const body = request.body as { projectId?: string }
    const projectId = String(body.projectId ?? '').trim()
    if (!projectId) {
      return reply.status(400).send({ code: 'validation_error', message: '缺少 projectId' })
    }
    try {
      const settings = await resolveUserAppSettings(user.sub)
      const result = await runWithUserWorkspace(
        user.sub,
        async () => {
          const { backfillProjectStateFromChapters } = await import('../../../electron/main/ai/state-backfill.js')
          return backfillProjectStateFromChapters(
            settings as never,
            projectId,
            (progress) => emitProgress(user.sub, PROGRESS_CHANNELS.backfillState, progress),
          )
        },
        { persist: true },
      )
      return { success: true, result }
    } catch (err) {
      return reply.status(503).send({
        code: 'backfill_failed',
        message: err instanceof Error ? err.message : '状态补录失败',
      })
    }
  })

  app.post(
    '/api/character-arc/v1/projects/:projectId/export-archive',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const user = request.user as JwtUserPayload
      const projectId = String((request.params as { projectId?: string }).projectId ?? '')
      const { readUserWorkspace } = await import('../workspace/json-store.js')
      const workspace = await readUserWorkspace(user.sub)
      const project = workspace.projects.find((item) => item.id === projectId)
      if (!project) {
        return reply.status(404).send({ code: 'not_found', message: '项目不存在' })
      }
      const buffer = await exportCarcBuffer(workspace, projectId)
      const filename = `${project.title || 'project'}.carc`
      return reply
        .header('Content-Type', 'application/zip')
        .header('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`)
        .send(buffer)
    },
  )

  app.post('/api/character-arc/v1/reference-novels/import', { preHandler: [app.authenticate] }, async (request, reply) => {
    const user = request.user as JwtUserPayload
    const data = await request.file()
    if (!data) {
      return reply.status(400).send({ code: 'validation_error', message: '请上传参考小说文件' })
    }
    const buffer = await data.toBuffer()
    const tempDir = join(tmpdir(), `carc-ref-${randomUUID()}`)
    await mkdir(tempDir, { recursive: true })
    const tempPath = join(tempDir, data.filename || 'novel.txt')
    await writeFile(tempPath, buffer)

    const fields = data.fields as Record<string, { value?: string }>
    const metaRaw = fields.meta?.value
    const meta = metaRaw ? (JSON.parse(metaRaw) as Record<string, unknown>) : {}

    try {
      const result = await importReferenceNovelFromPath(user.sub, tempPath, meta, (event) => {
        emitProgress(user.sub, PROGRESS_CHANNELS.referenceImport, event)
      })
      return result
    } catch (err) {
      return reply.status(503).send({
        code: 'reference_import_failed',
        message: err instanceof Error ? err.message : '参考作品拆书失败',
      })
    }
  })

  app.post('/api/character-arc/v1/reference-novels/import-batch', { preHandler: [app.authenticate] }, async (request, reply) => {
    const user = request.user as JwtUserPayload
    const parts = request.parts()
    const filePaths: string[] = []
    const tempDir = join(tmpdir(), `carc-ref-batch-${randomUUID()}`)
    await mkdir(tempDir, { recursive: true })
    let meta: Record<string, unknown> = {}

    for await (const part of parts) {
      if (part.type === 'file') {
        const buffer = await part.toBuffer()
        const path = join(tempDir, part.filename || `book-${filePaths.length}.txt`)
        await writeFile(path, buffer)
        filePaths.push(path)
      } else if (part.fieldname === 'meta') {
        meta = JSON.parse(String(part.value)) as Record<string, unknown>
      }
    }

    if (filePaths.length === 0) {
      return reply.status(400).send({ code: 'validation_error', message: '请上传参考小说文件' })
    }

    const bookControllers = new Map<string, AbortController>()
    batchBookControllers.set(user.sub, bookControllers)
    const results: Array<Record<string, unknown>> = []
    const concurrency = Math.max(1, Math.min(8, Math.floor(Number(meta.concurrency ?? 3))))

    try {
      let index = 0
      async function worker(): Promise<void> {
        while (index < filePaths.length) {
          const current = index
          index += 1
          const filePath = filePaths[current]
          const bookId = `book-${current}`
          const controller = new AbortController()
          bookControllers.set(bookId, controller)
          try {
            const result = await importReferenceNovelFromPath(user.sub, filePath, meta, (event) => {
              emitProgress(user.sub, PROGRESS_CHANNELS.referenceImport, { ...event, bookId, bookIndex: current })
            })
            results.push({ bookId, success: true, fileName: filePath.split(/[/\\]/).pop(), result })
          } catch (err) {
            results.push({
              bookId,
              success: false,
              fileName: filePath.split(/[/\\]/).pop(),
              error: err instanceof Error ? err.message : '拆书失败',
            })
          } finally {
            bookControllers.delete(bookId)
          }
        }
      }

      await Promise.all(Array.from({ length: concurrency }, () => worker()))
      return { success: true, results }
    } finally {
      batchBookControllers.delete(user.sub)
    }
  })

  app.post('/api/character-arc/v1/reference-novels/cancel-book', { preHandler: [app.authenticate] }, async (request) => {
    const user = request.user as JwtUserPayload
    const body = request.body as { bookId?: string }
    const bookId = String(body.bookId ?? '')
    const controllers = batchBookControllers.get(user.sub)
    controllers?.get(bookId)?.abort()
    return { success: true }
  })

  app.get('/api/character-arc/v1/fanqie-trends', { preHandler: [app.authenticate] }, async (request) => {
    const path = String((request.query as { path?: string }).path ?? '')
    const force = (request.query as { force?: string }).force === 'true'
    const { fetchFanqieTrends } = await import('../../../electron/main/fanqie-trends.js')
    return fetchFanqieTrends(path, force)
  })

  app.post('/api/character-arc/v1/workspace/import-json', { preHandler: [app.authenticate] }, async (request, reply) => {
    const body = request.body as { payload?: unknown }
    if (!body.payload || typeof body.payload !== 'object') {
      return reply.status(400).send({ code: 'validation_error', message: '缺少 payload' })
    }
    const { normalizeWorkspacePayload } = await import('../../../electron/main/workspace-types.js')
    try {
      const payload = normalizeWorkspacePayload(body.payload as never)
      return { success: true, canceled: false, payload, meta: { projectCount: payload.projects.length } }
    } catch (err) {
      return reply.status(400).send({
        code: 'validation_error',
        message: err instanceof Error ? err.message : 'JSON 格式无效',
      })
    }
  })
}
