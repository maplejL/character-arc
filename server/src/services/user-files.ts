import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { join, basename, extname, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import JSZip from 'jszip'
import { config } from '../config.js'
import { query } from '../db/pool.js'

export type FilePurpose = 'cover' | 'reference-novel' | 'project-skill' | 'export'

export interface UserFileRecord {
  id: string
  userId: string
  projectId: string | null
  purpose: FilePurpose
  fileName: string
  diskPath: string
  mimeType: string
  sizeBytes: number
  createdAt: string
}

const PURPOSE_DIRS: Record<FilePurpose, (userId: string, projectId: string) => string> = {
  cover: (userId, projectId) => join(config.dataRoot, 'users', userId, 'projects', projectId, 'covers'),
  'reference-novel': (userId) => join(config.dataRoot, 'users', userId, 'reference-novels'),
  'project-skill': (userId, projectId) => join(config.dataRoot, 'users', userId, 'project-skills', projectId),
  export: (userId, projectId) => join(config.dataRoot, 'users', userId, 'exports', projectId),
}

const ALLOWED_EXTENSIONS: Record<FilePurpose, string[]> = {
  cover: ['.png', '.jpg', '.jpeg', '.webp', '.gif'],
  'reference-novel': ['.txt', '.md'],
  'project-skill': ['.zip'],
  export: ['.zip', '.carc', '.txt', '.md', '.docx'],
}

function sanitizeFileName(name: string): string {
  const base = basename(name).replace(/[^\w.\-()\u4e00-\u9fff]+/g, '_')
  return base.slice(0, 200) || `file-${Date.now()}`
}

function mapRow(row: {
  id: string
  user_id: string
  project_id: string | null
  purpose: FilePurpose
  file_name: string
  disk_path: string
  mime_type: string
  size_bytes: number | string
  created_at: Date
}): UserFileRecord {
  return {
    id: row.id,
    userId: row.user_id,
    projectId: row.project_id,
    purpose: row.purpose,
    fileName: row.file_name,
    diskPath: row.disk_path,
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes),
    createdAt: row.created_at.toISOString(),
  }
}

export async function getUserFile(userId: string, fileId: string): Promise<UserFileRecord | null> {
  const { rows } = await query<Parameters<typeof mapRow>[0]>(
    'SELECT * FROM user_files WHERE id = $1 AND user_id = $2',
    [fileId, userId],
  )
  return rows[0] ? mapRow(rows[0]) : null
}

async function extractSkillZip(buffer: Buffer, targetDir: string): Promise<string[]> {
  const zip = await JSZip.loadAsync(buffer)
  const skillMdPaths = Object.keys(zip.files).filter((name) => {
    const entry = zip.files[name]
    return entry && !entry.dir && name.replace(/\\/g, '/').endsWith('SKILL.md')
  })

  if (skillMdPaths.length === 0) {
    throw new Error('ZIP 中未找到 SKILL.md')
  }

  const imported: string[] = []

  for (const skillMdPath of skillMdPaths) {
    const normalized = skillMdPath.replace(/\\/g, '/')
    const parentDir = normalized.includes('/') ? normalized.slice(0, normalized.lastIndexOf('/')) : ''
    const skillId = parentDir ? basename(parentDir) : normalized.replace(/\/SKILL\.md$/i, '') || 'skill'
    const prefix = parentDir ? `${parentDir}/` : ''
    const destDir = join(targetDir, skillId)
    await mkdir(destDir, { recursive: true })

    for (const [entryName, entry] of Object.entries(zip.files)) {
      if (entry.dir) continue
      const entryNorm = entryName.replace(/\\/g, '/')
      if (prefix && !entryNorm.startsWith(prefix)) continue
      const relative = prefix ? entryNorm.slice(prefix.length) : entryNorm
      if (!relative || relative.includes('..')) continue
      const outPath = join(destDir, relative)
      await mkdir(dirname(outPath), { recursive: true })
      await writeFile(outPath, await entry.async('nodebuffer'))
    }

    imported.push(skillId)
  }

  return [...new Set(imported)].sort((a, b) => a.localeCompare(b, 'zh-CN'))
}

export async function saveUserUpload(input: {
  userId: string
  projectId: string
  purpose: FilePurpose
  fileName: string
  mimeType: string
  buffer: Buffer
  refId?: string
}): Promise<{ record: UserFileRecord; url: string; importedSkillIds?: string[] }> {
  const ext = extname(input.fileName).toLowerCase()
  const allowed = ALLOWED_EXTENSIONS[input.purpose]
  if (!allowed.includes(ext)) {
    throw Object.assign(new Error(`不支持的文件类型: ${ext || '(无扩展名)'}`), { statusCode: 400 })
  }

  const dir = PURPOSE_DIRS[input.purpose](input.userId, input.projectId)
  await mkdir(dir, { recursive: true })

  let diskPath: string
  let importedSkillIds: string[] | undefined

  if (input.purpose === 'project-skill') {
    importedSkillIds = await extractSkillZip(input.buffer, dir)
    diskPath = dir
  } else {
    const safeName =
      input.purpose === 'reference-novel' && input.refId
        ? `${input.refId}.txt`
        : `${randomUUID().slice(0, 8)}-${sanitizeFileName(input.fileName)}`
    diskPath = join(dir, safeName)
    await writeFile(diskPath, input.buffer)
  }

  const id = randomUUID()
  const storedName = input.purpose === 'project-skill' ? `${importedSkillIds?.join(',') || 'skills'}.zip` : basename(diskPath)

  const { rows } = await query<Parameters<typeof mapRow>[0]>(
    `INSERT INTO user_files (id, user_id, project_id, purpose, file_name, disk_path, mime_type, size_bytes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      id,
      input.userId,
      input.projectId,
      input.purpose,
      storedName,
      diskPath,
      input.mimeType || 'application/octet-stream',
      input.buffer.length,
    ],
  )

  const record = mapRow(rows[0]!)
  const url = `/api/character-arc/v1/files/${record.id}`
  return { record, url, importedSkillIds }
}

export async function readUserFileContent(record: UserFileRecord): Promise<Buffer> {
  if (record.purpose === 'project-skill') {
    throw Object.assign(new Error('Skill 包请通过 scan API 读取'), { statusCode: 400 })
  }
  return readFile(record.diskPath)
}
