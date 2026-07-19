import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { JwtUserPayload } from '../config.js'
import { bodyLimitBytes } from '../config.js'
import { getUserAppSettings, upsertUserAppSettings } from '../services/user-app-settings.js'
import {
  createEmptyProjectWorkspace,
  newProjectId,
  readUserWorkspace,
  writeUserWorkspace,
} from '../workspace/json-store.js'
import { importCarcAsNewProjectAsync, importCarcIntoProjectAsync, inspectCarcArchive } from '../workspace/carc-import.js'

const createProjectSchema = z.object({
  title: z.string().min(1),
  genre: z.string().default(''),
  wordCount: z.string().default(''),
})

const appSettingsSchema = z.object({
  theme: z.string().optional(),
  selectedProjectId: z.string().optional(),
  autoSaveInterval: z.string().optional(),
  uiScale: z.number().optional(),
  darkMode: z.boolean().optional(),
  darkModeStyle: z.string().optional(),
})

export async function workspaceRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/character-arc/v1/workspace',
    { preHandler: [app.authenticate] },
    async (request) => {
      const user = request.user as JwtUserPayload
      const [workspace, appSettings] = await Promise.all([
        readUserWorkspace(user.sub),
        getUserAppSettings(user.sub),
      ])
      return {
        ...workspace,
        theme: appSettings.theme,
        selectedProjectId: appSettings.selectedProjectId || workspace.selectedProjectId,
      }
    },
  )

  app.put(
    '/api/character-arc/v1/workspace',
    {
      preHandler: [app.authenticate],
      bodyLimit: bodyLimitBytes,
    },
    async (request, reply) => {
      const user = request.user as JwtUserPayload
      const body = request.body as Record<string, unknown>
      if (!body || typeof body !== 'object') {
        return reply.status(400).send({ code: 'validation_error', message: '无效的工作区数据' })
      }

      const theme = typeof body.theme === 'string' ? body.theme : undefined
      const selectedProjectId =
        typeof body.selectedProjectId === 'string' ? body.selectedProjectId : undefined

      await writeUserWorkspace(user.sub, body as Parameters<typeof writeUserWorkspace>[1])

      if (theme !== undefined || selectedProjectId !== undefined) {
        await upsertUserAppSettings(user.sub, {
          ...(theme !== undefined ? { theme } : {}),
          ...(selectedProjectId !== undefined ? { selectedProjectId } : {}),
        })
      }

      return { savedAt: new Date().toISOString() }
    },
  )

  app.get(
    '/api/character-arc/v1/projects',
    { preHandler: [app.authenticate] },
    async (request) => {
      const user = request.user as JwtUserPayload
      const workspace = await readUserWorkspace(user.sub)
      return workspace.projects.map((p) => ({
        id: p.id,
        title: p.title,
        genre: p.genre,
        wordCount: p.wordCount,
        lastEdited: p.lastEdited,
        cover: p.cover,
      }))
    },
  )

  app.post(
    '/api/character-arc/v1/projects',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const parsed = createProjectSchema.safeParse(request.body ?? {})
      if (!parsed.success) {
        return reply.status(400).send({ code: 'validation_error', message: parsed.error.message })
      }

      const user = request.user as JwtUserPayload
      const workspace = await readUserWorkspace(user.sub)
      const id = newProjectId()
      const now = new Date().toISOString()

      workspace.projects.push({
        id,
        title: parsed.data.title,
        genre: parsed.data.genre,
        novelLength: 'long',
        wordCount: parsed.data.wordCount,
        lastEdited: now,
        cover: '',
        targetPlatform: '',
        coverHistory: [],
        writingStylePresetId: 'cinematic-cool',
        writingStylePrompt: '',
        novelWorkflowStages: [],
        projectSkills: [],
        chapterAssistantTemplates: [],
        selectedReferenceWorkIds: [],
      })

      workspace.workspaces[id] = createEmptyProjectWorkspace()

      workspace.selectedProjectId = id
      await writeUserWorkspace(user.sub, workspace)
      await upsertUserAppSettings(user.sub, { selectedProjectId: id })

      return { id, title: parsed.data.title, lastEdited: now }
    },
  )

  app.post(
    '/api/character-arc/v1/projects/import',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const data = await request.file()
      if (!data) {
        return reply.status(400).send({ code: 'validation_error', message: '请上传 .carc 文件' })
      }

      const filename = data.filename.toLowerCase()
      if (!filename.endsWith('.carc')) {
        return reply.status(400).send({ code: 'validation_error', message: '仅支持 .carc 项目归档' })
      }

      const buffer = await data.toBuffer()
      if (buffer.length === 0) {
        return reply.status(400).send({ code: 'validation_error', message: '文件为空' })
      }

      const fields = data.fields as Record<string, { value?: string }>
      const mode = fields.mode?.value === 'overwrite-project' ? 'overwrite-project' : 'new-project'
      const targetProjectId = fields.targetProjectId?.value
      const modulesRaw = fields.modules?.value
      const modules = modulesRaw ? (JSON.parse(modulesRaw) as string[]) : undefined

      try {
        const user = request.user as JwtUserPayload
        const workspace = await readUserWorkspace(user.sub)
        const { workspace: next, projectId, preview } =
          mode === 'overwrite-project'
            ? await importCarcIntoProjectAsync(workspace, buffer, {
                mode,
                targetProjectId,
                modules,
              })
            : await importCarcAsNewProjectAsync(workspace, buffer)
        await writeUserWorkspace(user.sub, next)
        await upsertUserAppSettings(user.sub, { selectedProjectId: projectId })

        const project = next.projects.find((p) => p.id === projectId)
        return {
          id: projectId,
          title: project?.title ?? preview.projectTitle,
          lastEdited: project?.lastEdited ?? new Date().toISOString(),
          preview,
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : '导入失败'
        return reply.status(400).send({ code: 'import_error', message })
      }
    },
  )

  app.post(
    '/api/character-arc/v1/projects/import/preview',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const data = await request.file()
      if (!data) {
        return reply.status(400).send({ code: 'validation_error', message: '请上传 .carc 文件' })
      }
      const buffer = await data.toBuffer()
      try {
        return await inspectCarcArchive(buffer)
      } catch (err) {
        const message = err instanceof Error ? err.message : '无法解析归档'
        return reply.status(400).send({ code: 'import_error', message })
      }
    },
  )

  app.get(
    '/api/character-arc/v1/users/me/app-settings',
    { preHandler: [app.authenticate] },
    async (request) => {
      const user = request.user as JwtUserPayload
      return getUserAppSettings(user.sub)
    },
  )

  app.put(
    '/api/character-arc/v1/users/me/app-settings',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const parsed = appSettingsSchema.safeParse(request.body ?? {})
      if (!parsed.success) {
        return reply.status(400).send({ code: 'validation_error', message: parsed.error.message })
      }
      const user = request.user as JwtUserPayload
      return upsertUserAppSettings(user.sub, parsed.data)
    },
  )
}
