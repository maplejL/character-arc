import { randomUUID } from 'node:crypto'
import { readUserWorkspace, writeUserWorkspace, type WorkspacePayload } from './json-store.js'

type ChapterRow = {
  id: string
  title?: string
  summary?: string
  status?: string
  wordTarget?: string
  content?: string
}

type ChapterVersionRow = {
  id: string
  chapterId: string
  title?: string
  summary?: string
  status?: string
  wordTarget?: string
  content?: string
  createdAt?: string
}

function projectWs(payload: WorkspacePayload, projectId: string): Record<string, unknown> {
  return payload.workspaces[projectId] ?? {}
}

export function readChapterFromJsonWorkspace(
  payload: WorkspacePayload,
  projectId: string,
  chapterId: string,
): ChapterRow | null {
  const ws = projectWs(payload, projectId)
  const chapters = (Array.isArray(ws.chapters) ? ws.chapters : []) as ChapterRow[]
  return chapters.find((chapter) => chapter.id === chapterId) ?? null
}

export function readChapterVersionFromJsonWorkspace(
  payload: WorkspacePayload,
  projectId: string,
  versionId: string,
): ChapterVersionRow | null {
  const ws = projectWs(payload, projectId)
  const versions = (Array.isArray(ws.chapterVersions) ? ws.chapterVersions : []) as ChapterVersionRow[]
  return versions.find((version) => version.id === versionId) ?? null
}

export async function commitChapterEditJson(
  userId: string,
  projectId: string,
  chapterId: string,
  oldContent: string,
  newContent: string,
): Promise<{ versionId: string }> {
  const payload = await readUserWorkspace(userId)
  const ws = projectWs(payload, projectId)
  const chapters = (Array.isArray(ws.chapters) ? ws.chapters : []) as ChapterRow[]
  const chapter = chapters.find((item) => item.id === chapterId)
  if (!chapter) throw new Error(`Chapter not found: ${chapterId}`)

  const versions = (Array.isArray(ws.chapterVersions) ? ws.chapterVersions : []) as ChapterVersionRow[]
  const versionId = randomUUID()
  versions.unshift({
    id: versionId,
    chapterId,
    title: chapter.title,
    summary: chapter.summary,
    status: chapter.status,
    wordTarget: chapter.wordTarget,
    content: oldContent,
    createdAt: new Date().toISOString(),
  })

  chapter.content = newContent
  ws.chapters = chapters
  ws.chapterVersions = versions
  payload.workspaces[projectId] = ws
  await writeUserWorkspace(userId, payload)
  return { versionId }
}
