import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import type { JwtUserPayload } from '../config.js'
import { config } from '../config.js'
import { readUserWorkspace } from '../workspace/json-store.js'
import { commitChapterEditJson, readChapterFromJsonWorkspace } from '../workspace/chapter-json.js'

function userDataRoot(userId: string): string {
  return join(config.dataRoot, 'users', userId)
}

async function withUserSkillRegistry<T>(userId: string, projectId: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.CHARACTERARC_USER_DATA
  process.env.CHARACTERARC_USER_DATA = userDataRoot(userId)
  try {
    const { refreshRegistry } = await import('../../../electron/main/ai/skills/index.js')
    await refreshRegistry(projectId)
    return run()
  } finally {
    if (previous === undefined) delete process.env.CHARACTERARC_USER_DATA
    else process.env.CHARACTERARC_USER_DATA = previous
  }
}

export async function projectModulesRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/character-arc/v1/projects/:projectId/skills',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const user = request.user as JwtUserPayload
      const projectId = String((request.params as { projectId?: string }).projectId ?? '')
      const workspace = await readUserWorkspace(user.sub)
      if (!workspace.projects.some((project) => project.id === projectId)) {
        return reply.status(404).send({ code: 'not_found', message: '项目不存在' })
      }
      try {
        const skills = await withUserSkillRegistry(user.sub, projectId, async () => {
          const { toScanEntries } = await import('../../../electron/main/ai/skills/index.js')
          return toScanEntries(projectId)
        })
        return { success: true, skills }
      } catch (err) {
        return reply.status(500).send({
          code: 'skills_scan_failed',
          message: err instanceof Error ? err.message : '扫描 skills 失败',
        })
      }
    },
  )

  app.get(
    '/api/character-arc/v1/projects/:projectId/skills/context',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const user = request.user as JwtUserPayload
      const projectId = String((request.params as { projectId?: string }).projectId ?? '')
      const workspace = await readUserWorkspace(user.sub)
      if (!workspace.projects.some((project) => project.id === projectId)) {
        return reply.status(404).send({ code: 'not_found', message: '项目不存在' })
      }
      try {
        const skills = await withUserSkillRegistry(user.sub, projectId, async () => {
          const { toContextEntries } = await import('../../../electron/main/ai/skills/index.js')
          return toContextEntries(projectId)
        })
        return { success: true, skills }
      } catch (err) {
        return reply.status(500).send({
          code: 'skills_context_failed',
          message: err instanceof Error ? err.message : '读取 skills 失败',
        })
      }
    },
  )

  app.get(
    '/api/character-arc/v1/reference-novels/:refId/text',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const user = request.user as JwtUserPayload
      const refId = String((request.params as { refId?: string }).refId ?? '').trim()
      if (!refId) {
        return reply.status(400).send({ code: 'validation_error', message: '缺少 refId' })
      }
      const novelPath = join(userDataRoot(user.sub), 'reference-novels', `${refId}.txt`)
      try {
        const content = await readFile(novelPath, 'utf8')
        return { success: true, content }
      } catch {
        return reply.status(404).send({
          code: 'not_found',
          message: '未找到该参考作品的原文存档，可能是旧版本导入的作品',
        })
      }
    },
  )

  app.get(
    '/api/character-arc/v1/projects/:projectId/chapters/:chapterId',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const user = request.user as JwtUserPayload
      const projectId = String((request.params as { projectId?: string }).projectId ?? '')
      const chapterId = String((request.params as { chapterId?: string }).chapterId ?? '')
      const workspace = await readUserWorkspace(user.sub)
      const chapter = readChapterFromJsonWorkspace(workspace, projectId, chapterId)
      if (!chapter) {
        return reply.status(404).send({ code: 'not_found', message: '章节不存在' })
      }
      return {
        success: true,
        result: {
          id: chapter.id,
          title: chapter.title ?? '',
          summary: chapter.summary ?? '',
          status: chapter.status ?? 'draft',
          wordTarget: chapter.wordTarget ?? '',
          content: chapter.content ?? '',
        },
      }
    },
  )

  app.post(
    '/api/character-arc/v1/projects/:projectId/chapters/:chapterId/commit-edit',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const user = request.user as JwtUserPayload
      const projectId = String((request.params as { projectId?: string }).projectId ?? '')
      const chapterId = String((request.params as { chapterId?: string }).chapterId ?? '')
      const body = request.body as { oldContent?: string; newContent?: string }
      const oldContent = typeof body?.oldContent === 'string' ? body.oldContent : ''
      const newContent = typeof body?.newContent === 'string' ? body.newContent : ''
      if (!oldContent && !newContent) {
        return reply.status(400).send({ code: 'validation_error', message: '缺少内容' })
      }
      try {
        const result = await commitChapterEditJson(user.sub, projectId, chapterId, oldContent, newContent)
        return { success: true, versionId: result.versionId }
      } catch (err) {
        return reply.status(400).send({
          code: 'commit_failed',
          message: err instanceof Error ? err.message : '写回失败',
        })
      }
    },
  )
}
