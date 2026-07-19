import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { encryptSecret } from '../lib/crypto.js'
import {
  defaultBaseUrl,
  fetchModelsForCredentials,
  getUserAiConfig,
  resolveModelsFetchContext,
  testAiConnection,
  type AiProvider,
} from '../services/ai-config.js'
import {
  getUserProductionAiRow,
  publicProductionAiConfig,
  upsertUserProductionAiConfig,
} from '../services/ai-production-config.js'
import type { JwtUserPayload } from '../config.js'

const profileSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  provider: z.enum(['deepseek', 'openai-compatible']),
  model: z.string().min(1),
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
})

const productionModelsSchema = z.object({
  draftProfileId: z.string().optional(),
  draftModel: z.string().optional(),
  repairProfileId: z.string().optional(),
  repairModel: z.string().optional(),
  auditProfileId: z.string().optional(),
  auditModel: z.string().optional(),
})

const fetchModelsSchema = z.object({
  provider: z.enum(['deepseek', 'openai-compatible']).optional(),
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  profileId: z.string().optional(),
})

const putSchema = z.object({
  provider: z.enum(['deepseek', 'openai-compatible']),
  model: z.string().min(1),
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  aiProfiles: z.array(profileSchema).optional(),
  activeAiProfileId: z.string().optional(),
  chapterProductionModels: productionModelsSchema.optional(),
})

export async function aiConfigRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/character-arc/v1/users/me/ai-config',
    { preHandler: [app.authenticate] },
    async (request) => {
      const user = request.user as JwtUserPayload
      const row = await getUserProductionAiRow(user.sub)
      return publicProductionAiConfig(row)
    },
  )

  app.put(
    '/api/character-arc/v1/users/me/ai-config',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const parsed = putSchema.safeParse(request.body)
      if (!parsed.success) {
        return reply.status(400).send({ code: 'validation_error', message: parsed.error.message })
      }

      const user = request.user as JwtUserPayload
      const existing = await getUserAiConfig(user.sub)
      const provider = parsed.data.provider as AiProvider
      const baseUrl = parsed.data.baseUrl?.trim() || defaultBaseUrl(provider)
      const apiKeyEnc = parsed.data.apiKey
        ? encryptSecret(parsed.data.apiKey)
        : existing?.api_key_enc ?? ''

      await upsertUserProductionAiConfig(user.sub, {
        provider,
        model: parsed.data.model,
        baseUrl,
        apiKeyEnc,
        aiProfiles: parsed.data.aiProfiles,
        activeAiProfileId: parsed.data.activeAiProfileId,
        chapterProductionModels: parsed.data.chapterProductionModels,
      })

      const row = await getUserProductionAiRow(user.sub)
      return publicProductionAiConfig(row)
    },
  )

  app.post(
    '/api/character-arc/v1/users/me/ai-config/models',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const parsed = fetchModelsSchema.safeParse(request.body ?? {})
      if (!parsed.success) {
        return reply.status(400).send({ code: 'validation_error', message: parsed.error.message })
      }
      const user = request.user as JwtUserPayload
      let meta: { baseUrl: string; provider: string; profileId?: string } | undefined
      try {
        const ctx = await resolveModelsFetchContext(user.sub, parsed.data)
        meta = { baseUrl: ctx.baseUrl, provider: ctx.provider, profileId: ctx.profileId }
        const { models } = await fetchModelsForCredentials(user.sub, parsed.data)
        return { success: true, result: models, meta }
      } catch (err) {
        const e = err as { statusCode?: number; code?: string; message?: string }
        return reply.status(e.statusCode ?? 503).send({
          code: e.code ?? 'ai_unavailable',
          message: e.message ?? '获取模型列表失败',
          meta,
        })
      }
    },
  )

  app.post(
    '/api/character-arc/v1/users/me/ai-config/test',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const user = request.user as JwtUserPayload
      try {
        const result = await testAiConnection(user.sub)
        if (!result.ok) {
          return reply.status(503).send({ code: 'ai_unavailable', message: result.message ?? 'AI 不可用' })
        }
        return result
      } catch (err) {
        const e = err as { statusCode?: number; code?: string; message?: string }
        return reply.status(e.statusCode ?? 503).send({
          code: e.code ?? 'ai_unavailable',
          message: e.message ?? 'AI 不可用',
        })
      }
    },
  )
}
