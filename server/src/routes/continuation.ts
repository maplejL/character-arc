import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { JwtUserPayload } from '../config.js'
import {
  chaptersFromParsedCandidates,
  buildContinuationSeed,
  readContinuationBreakpoint,
} from '../continuation/seed-project.js'
import { runContinuationReverseExtract } from '../continuation/reverse-extract.js'
import { parseManuscriptFromInputs } from '../../../electron/shared/continuation/index.js'
import { readUserWorkspace, writeUserWorkspace } from '../workspace/json-store.js'
import { upsertUserAppSettings } from '../services/user-app-settings.js'

const fileSchema = z.object({
  name: z.string().min(1),
  text: z.string(),
})

const parseSchema = z.object({
  files: z.array(fileSchema).min(1),
  mode: z.enum(['auto', 'force-single-book']).optional(),
})

const chapterSchema = z.object({
  title: z.string().min(1),
  plainText: z.string().min(1),
  isPartial: z.boolean().optional(),
})

const seedSchema = z.object({
  title: z.string().min(1),
  genre: z.string().optional(),
  wordCount: z.string().optional(),
  chapters: z.array(chapterSchema).min(1),
  markLastAsPartial: z.boolean().optional(),
  sourceSummary: z.string().optional(),
  /** 若传入 files，服务端可再解析；优先用 chapters */
  files: z.array(fileSchema).optional(),
  mode: z.enum(['auto', 'force-single-book']).optional(),
})

export async function continuationRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/api/character-arc/v1/continuation/parse',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const parsed = parseSchema.safeParse(request.body ?? {})
      if (!parsed.success) {
        return reply.status(400).send({ code: 'validation_error', message: parsed.error.message })
      }
      const result = parseManuscriptFromInputs(parsed.data.files, parsed.data.mode ?? 'auto')
      return { success: true, result }
    },
  )

  app.post(
    '/api/character-arc/v1/continuation/seed',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const parsed = seedSchema.safeParse(request.body ?? {})
      if (!parsed.success) {
        return reply.status(400).send({ code: 'validation_error', message: parsed.error.message })
      }

      let chapters = parsed.data.chapters
      if ((!chapters || chapters.length === 0) && parsed.data.files?.length) {
        const parseResult = parseManuscriptFromInputs(parsed.data.files, parsed.data.mode ?? 'auto')
        if (parseResult.chapters.length === 0) {
          return reply.status(400).send({
            code: 'empty_chapters',
            message: parseResult.warnings.join('；') || '没有识别到可读章节',
          })
        }
        chapters = chaptersFromParsedCandidates(parseResult.chapters)
      }

      if (!chapters?.length) {
        return reply.status(400).send({ code: 'empty_chapters', message: '请至少提供一章正文' })
      }

      const user = request.user as JwtUserPayload
      const workspace = await readUserWorkspace(user.sub)
      try {
        const { workspace: next, result } = buildContinuationSeed(workspace, {
          title: parsed.data.title,
          genre: parsed.data.genre,
          wordCount: parsed.data.wordCount,
          chapters,
          markLastAsPartial: parsed.data.markLastAsPartial,
          sourceSummary: parsed.data.sourceSummary,
        })
        await writeUserWorkspace(user.sub, next)
        await upsertUserAppSettings(user.sub, { selectedProjectId: result.projectId })
        return { success: true, result }
      } catch (error) {
        const message = error instanceof Error ? error.message : '创建续写项目失败'
        if (message === 'empty_chapters') {
          return reply.status(400).send({ code: 'empty_chapters', message: '请至少提供一章正文' })
        }
        return reply.status(500).send({ code: 'seed_failed', message })
      }
    },
  )

  app.get(
    '/api/character-arc/v1/projects/:projectId/continuation/breakpoint',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const user = request.user as JwtUserPayload
      const projectId = String((request.params as { projectId?: string }).projectId ?? '')
      const workspace = await readUserWorkspace(user.sub)
      if (!workspace.projects.some((project) => project.id === projectId)) {
        return reply.status(404).send({ code: 'not_found', message: '项目不存在' })
      }
      const breakpoint = readContinuationBreakpoint(workspace, projectId)
      return { success: true, result: breakpoint }
    },
  )

  const reverseExtractSchema = z.object({
    maxBodyChapters: z.number().int().min(1).max(120).optional(),
    chaptersPerChunk: z.number().int().min(4).max(60).optional(),
    maxCharsPerChapter: z.number().int().min(400).max(8000).optional(),
    maxChunks: z.number().int().min(1).max(80).optional(),
    maxCharacters: z.number().int().min(1).max(40).optional(),
    maxOutlineItems: z.number().int().min(1).max(80).optional(),
    maxWorldview: z.number().int().min(1).max(40).optional(),
    maxRelations: z.number().int().min(1).max(120).optional(),
    rebuildImportedOutline: z.boolean().optional(),
  })

  app.post(
    '/api/character-arc/v1/projects/:projectId/continuation/reverse-extract',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const user = request.user as JwtUserPayload
      const projectId = String((request.params as { projectId?: string }).projectId ?? '')
      const parsed = reverseExtractSchema.safeParse(request.body ?? {})
      if (!parsed.success) {
        return reply.status(400).send({ code: 'validation_error', message: parsed.error.message })
      }

      const workspace = await readUserWorkspace(user.sub)
      if (!workspace.projects.some((project) => project.id === projectId)) {
        return reply.status(404).send({ code: 'not_found', message: '项目不存在' })
      }

      try {
        const { workspace: next, result } = await runContinuationReverseExtract({
          userId: user.sub,
          workspace,
          projectId,
          options: {
            ...parsed.data,
            rebuildImportedOutline: parsed.data.rebuildImportedOutline ?? true,
          },
        })
        await writeUserWorkspace(user.sub, next)
        return { success: true, result }
      } catch (error) {
        const message = error instanceof Error ? error.message : '反推设定失败'
        if (message === 'empty_chapters') {
          return reply.status(400).send({ code: 'empty_chapters', message: '项目没有可反推的章节正文' })
        }
        if (message === 'project_not_found') {
          return reply.status(404).send({ code: 'not_found', message: '项目不存在' })
        }
        return reply.status(503).send({ code: 'reverse_extract_failed', message })
      }
    },
  )
}
