import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { JwtUserPayload } from '../config.js'
import { cancelAiTask, fetchServerModels, runServerAiTask } from '../ai/run-task.js'
import { resolveUserAppSettings } from '../ai/settings.js'
import { importAiRuntime } from '../ai/register-electron-mock.js'
import { randomUUID } from 'node:crypto'
import { startServerAiStream } from '../ai/run-stream.js'
import { getStreamSession, subscribeStreamEvents, stopStreamSession } from '../ai/stream-session.js'

const taskSchema = z.object({
  task: z.string().min(1),
  context: z.record(z.string(), z.unknown()),
  clientKey: z.string().optional(),
  clientTaskId: z.string().optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
})

function writeSse(reply: import('fastify').FastifyReply, data: unknown): void {
  reply.raw.write(`data: ${JSON.stringify(data)}\n\n`)
}

export async function aiRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/api/character-arc/v1/ai/generate',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const parsed = taskSchema.safeParse(request.body)
      if (!parsed.success) {
        return reply.status(400).send({ code: 'validation_error', message: parsed.error.message })
      }

      const user = request.user as JwtUserPayload
      try {
        const result = await runServerAiTask(user.sub, parsed.data)
        if (!result.success) {
          return reply.status(503).send({ code: 'ai_failed', message: result.error ?? 'AI 调用失败' })
        }
        return { success: true, result: result.result, meta: result.meta }
      } catch (err) {
        const e = err as { statusCode?: number; code?: string; message?: string }
        return reply.status(e.statusCode ?? 503).send({
          code: e.code ?? 'ai_unavailable',
          message: e.message ?? 'AI 不可用',
        })
      }
    },
  )

  app.post(
    '/api/character-arc/v1/ai/stream/start',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const parsed = taskSchema.safeParse(request.body)
      if (!parsed.success) {
        return reply.status(400).send({ code: 'validation_error', message: parsed.error.message })
      }

      const user = request.user as JwtUserPayload
      try {
        const streamId = `stream-${randomUUID()}`
        startServerAiStream(user.sub, parsed.data, streamId)
        return { success: true, result: { streamId } }
      } catch (err) {
        const e = err as { message?: string }
        return reply.status(503).send({ code: 'ai_unavailable', message: e.message ?? '流式任务启动失败' })
      }
    },
  )

  app.get(
    '/api/character-arc/v1/ai/stream/:streamId/events',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const user = request.user as JwtUserPayload
      const streamId = String((request.params as { streamId?: string }).streamId ?? '')
      const session = getStreamSession(streamId)
      if (!session || session.userId !== user.sub) {
        return reply.status(404).send({ code: 'stream_not_found', message: '流不存在或无权访问' })
      }

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

      const unsubscribe = subscribeStreamEvents(streamId, user.sub, (event) => {
        writeSse(reply, event)
        const type = String(event.type ?? '')
        if (type === 'done' || type === 'error' || type === 'canceled') {
          finish()
        }
      })

      request.raw.on('close', finish)
    },
  )

  app.post(
    '/api/character-arc/v1/ai/stream/stop',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const body = request.body as { streamId?: string }
      const streamId = typeof body?.streamId === 'string' ? body.streamId : ''
      if (!streamId) {
        return reply.status(400).send({ code: 'validation_error', message: '缺少 streamId' })
      }
      const user = request.user as JwtUserPayload
      const ok = stopStreamSession(streamId, user.sub)
      return ok
        ? { success: true }
        : reply.status(404).send({ code: 'not_found', message: '当前没有可停止的生成任务' })
    },
  )

  app.post(
    '/api/character-arc/v1/ai/cancel',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const body = request.body as { clientTaskId?: string }
      const clientTaskId = typeof body?.clientTaskId === 'string' ? body.clientTaskId : ''
      if (!clientTaskId) {
        return reply.status(400).send({ code: 'validation_error', message: '缺少 clientTaskId' })
      }
      const ok = cancelAiTask(clientTaskId)
      return ok ? { success: true } : reply.status(404).send({ code: 'not_found', message: '未找到运行中任务' })
    },
  )

  app.get(
    '/api/character-arc/v1/ai/models',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const user = request.user as JwtUserPayload
      try {
        const models = await fetchServerModels(user.sub)
        return { success: true, result: models }
      } catch (err) {
        const e = err as { statusCode?: number; code?: string; message?: string }
        return reply.status(e.statusCode ?? 503).send({
          code: e.code ?? 'ai_unavailable',
          message: e.message ?? '获取模型列表失败',
        })
      }
    },
  )

  app.post(
    '/api/character-arc/v1/ai/test-connection',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const user = request.user as JwtUserPayload
      try {
        const { testAiConnection } = await importAiRuntime()
        const { normalizeSettings } = await import('../../../electron/main/ai/settings.js')
        const settings = await resolveUserAppSettings(user.sub)
        const ok = await testAiConnection(normalizeSettings(settings))
        return { ok: true, model: ok.model, latencyMs: 0, message: 'CONNECTED' }
      } catch (err) {
        const e = err as { message?: string }
        return reply.status(503).send({ code: 'ai_unavailable', message: e.message ?? '连接失败' })
      }
    },
  )
}
