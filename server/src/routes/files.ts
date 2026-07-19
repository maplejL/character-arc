import type { FastifyInstance } from 'fastify'
import type { JwtUserPayload } from '../config.js'
import { readUserWorkspace, writeUserWorkspace } from '../workspace/json-store.js'
import {
  getUserFile,
  readUserFileContent,
  saveUserUpload,
  type FilePurpose,
} from '../services/user-files.js'

const VALID_PURPOSES = new Set<FilePurpose>(['cover', 'reference-novel', 'project-skill', 'export'])

export async function fileRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/api/character-arc/v1/projects/:projectId/files/upload',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const user = request.user as JwtUserPayload
      const projectId = String((request.params as { projectId?: string }).projectId ?? '')

      const workspace = await readUserWorkspace(user.sub)
      if (!workspace.projects.some((project) => project.id === projectId)) {
        return reply.status(404).send({ code: 'not_found', message: '项目不存在' })
      }

      let purpose: FilePurpose | null = null
      let fileName = ''
      let mimeType = ''
      let buffer: Buffer | null = null
      let refId = ''

      for await (const part of request.parts()) {
        if (part.type === 'field' && part.fieldname === 'purpose') {
          const value = String(part.value ?? '').trim() as FilePurpose
          if (VALID_PURPOSES.has(value)) purpose = value
        }
        if (part.type === 'field' && part.fieldname === 'refId') {
          refId = String(part.value ?? '').trim()
        }
        if (part.type === 'file' && part.fieldname === 'file') {
          buffer = await part.toBuffer()
          fileName = part.filename ?? 'upload.bin'
          mimeType = part.mimetype ?? 'application/octet-stream'
        }
      }

      if (!purpose) {
        return reply.status(400).send({ code: 'validation_error', message: '缺少或无效的 purpose' })
      }
      if (!buffer || buffer.length === 0) {
        return reply.status(400).send({ code: 'validation_error', message: '请上传文件' })
      }

      try {
        const saved = await saveUserUpload({
          userId: user.sub,
          projectId,
          purpose,
          fileName,
          mimeType,
          buffer,
          refId: refId || undefined,
        })

        if (purpose === 'cover') {
          const project = workspace.projects.find((item) => item.id === projectId)
          if (project) {
            project.cover = saved.url
            await writeUserWorkspace(user.sub, workspace)
          }
        }

        return {
          success: true,
          fileId: saved.record.id,
          path: saved.record.diskPath,
          url: saved.url,
          purpose,
          ...(saved.importedSkillIds ? { importedSkillIds: saved.importedSkillIds } : {}),
        }
      } catch (err) {
        const e = err as { message?: string; statusCode?: number }
        return reply.status(e.statusCode ?? 400).send({
          code: 'upload_error',
          message: e.message ?? '上传失败',
        })
      }
    },
  )

  app.get(
    '/api/character-arc/v1/files/:fileId',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const user = request.user as JwtUserPayload
      const fileId = String((request.params as { fileId?: string }).fileId ?? '')
      const record = await getUserFile(user.sub, fileId)
      if (!record) {
        return reply.status(404).send({ code: 'not_found', message: '文件不存在' })
      }

      try {
        const content = await readUserFileContent(record)
        return reply
          .header('Content-Type', record.mimeType || 'application/octet-stream')
          .header('Content-Disposition', `inline; filename="${encodeURIComponent(record.fileName)}"`)
          .send(content)
      } catch (err) {
        const e = err as { message?: string; statusCode?: number }
        return reply.status(e.statusCode ?? 404).send({
          code: 'file_error',
          message: e.message ?? '无法读取文件',
        })
      }
    },
  )
}
