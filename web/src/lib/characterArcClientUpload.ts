import { getAccessToken } from './api'

export type UploadPurpose = 'cover' | 'reference-novel' | 'project-skill' | 'export'

export async function uploadProjectFile(
  projectId: string,
  purpose: UploadPurpose,
  file: File,
  options?: { refId?: string },
): Promise<{
  success: boolean
  fileId?: string
  url?: string
  importedSkillIds?: string[]
  error?: string
}> {
  const token = getAccessToken()
  if (!token) return { success: false, error: '未登录' }

  const form = new FormData()
  form.append('purpose', purpose)
  form.append('file', file)
  if (options?.refId) form.append('refId', options.refId)

  try {
    const res = await fetch(
      `/api/character-arc/v1/projects/${encodeURIComponent(projectId)}/files/upload`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      },
    )
    const body = (await res.json().catch(() => ({}))) as {
      fileId?: string
      url?: string
      importedSkillIds?: string[]
      message?: string
    }
    if (!res.ok) {
      return { success: false, error: body.message ?? `上传失败 (${res.status})` }
    }
    return {
      success: true,
      fileId: body.fileId,
      url: body.url,
      importedSkillIds: body.importedSkillIds,
    }
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : '上传失败' }
  }
}
