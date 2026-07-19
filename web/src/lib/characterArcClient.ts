import { api, getAccessToken } from './api'
import { uploadProjectFile, type UploadPurpose } from './characterArcClientUpload'
import {
  cacheArchiveFile,
  downloadDataUrl,
  downloadTextFile,
  peekArchiveFile,
  pickArchiveFile,
  pickImageFile,
  pickReferenceNovelFiles,
  pickZipFile,
  takeArchiveFile,
  exportChapterDocxFile,
  pickJsonFile,
  downloadBlobFile,
} from './webFileHelpers'

import {
  buildChaptersExportText,
  type ChaptersExportPayload,
} from '@/features/chapters/exportChaptersText'
import {
  cancelAutoCreationRun,
  fetchAutoCreationRun,
  pauseAutoCreationRun,
  resumeAutoCreationRun,
  startAutoCreationRun,
  subscribeAutoCreationRun,
} from './autoCreationClient'
import { setAutoCreationSessionActive } from './sessionKeepalive'

const progressChannels = {
  referenceImport: 'reference-import',
  spiral: 'spiral',
  backfillState: 'backfill-state',
  assistant: 'assistant',
} as const

const progressListeners = {
  referenceImport: new Set<(payload: unknown) => void>(),
  spiral: new Set<(payload: unknown) => void>(),
  backfillState: new Set<(payload: unknown) => void>(),
  assistant: new Set<(payload: unknown) => void>(),
}

const progressStreamConsumers = new Map<string, AbortController>()

function dispatchProgress(channel: keyof typeof progressChannels, payload: unknown): void {
  for (const listener of progressListeners[channel]) listener(payload)
}

async function consumeProgressChannel(channel: keyof typeof progressChannels): Promise<void> {
  const token = getAccessToken()
  if (!token) return
  const channelName = progressChannels[channel]
  if (progressStreamConsumers.has(channelName)) return

  const controller = new AbortController()
  progressStreamConsumers.set(channelName, controller)

  try {
    const res = await fetch(`/api/character-arc/v1/events/${encodeURIComponent(channelName)}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    })
    if (!res.ok || !res.body) return

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const chunks = buffer.split('\n\n')
      buffer = chunks.pop() ?? ''
      for (const chunk of chunks) {
        const line = chunk.split('\n').find((item) => item.startsWith('data:'))
        if (!line) continue
        const json = line.slice(5).trim()
        if (!json) continue
        dispatchProgress(channel, JSON.parse(json) as unknown)
      }
    }
  } catch {
    /* ignore */
  } finally {
    progressStreamConsumers.delete(channelName)
  }
}

function subscribeProgress(channel: keyof typeof progressChannels, callback: (payload: unknown) => void): () => void {
  progressListeners[channel].add(callback)
  void consumeProgressChannel(channel)
  return () => {
    progressListeners[channel].delete(callback)
  }
}

const streamListeners = new Set<(payload: unknown) => void>()
const streamConsumers = new Map<string, AbortController>()

function dispatchStreamEvent(payload: unknown): void {
  for (const listener of streamListeners) {
    listener(payload)
  }
}

function stripAiPayload(payload: unknown): {
  task: string
  context: Record<string, unknown>
  clientKey?: string
  clientTaskId?: string
  settings?: Record<string, unknown>
} | null {
  const body = (payload ?? {}) as {
    task?: string
    context?: Record<string, unknown>
    clientKey?: string
    clientTaskId?: string
    settings?: Record<string, unknown>
  }
  if (!body.task) return null
  const { settings, ...rest } = body
  const safeSettings =
    settings && typeof settings === 'object'
      ? Object.fromEntries(Object.entries(settings).filter(([key]) => key !== 'apiKey'))
      : undefined
  return {
    ...rest,
    task: body.task,
    context: body.context ?? {},
    ...(safeSettings ? { settings: safeSettings } : {}),
  }
}

async function consumeStreamEvents(streamId: string): Promise<void> {
  const token = getAccessToken()
  if (!token) return

  const controller = new AbortController()
  streamConsumers.set(streamId, controller)

  try {
    const res = await fetch(`/api/character-arc/v1/ai/stream/${encodeURIComponent(streamId)}/events`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    })
    if (!res.ok || !res.body) {
      throw new Error(`SSE 连接失败 (${res.status})`)
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const chunks = buffer.split('\n\n')
      buffer = chunks.pop() ?? ''
      for (const chunk of chunks) {
        const line = chunk.split('\n').find((item) => item.startsWith('data:'))
        if (!line) continue
        const json = line.slice(5).trim()
        if (!json) continue
        dispatchStreamEvent(JSON.parse(json) as unknown)
      }
    }
  } catch (e) {
    if (controller.signal.aborted) return
    dispatchStreamEvent({
      streamId,
      type: 'error',
      error: e instanceof Error ? e.message : '流式连接失败',
    })
  } finally {
    streamConsumers.delete(streamId)
  }
}

async function startAiAgentStreamRequest(payload: unknown): Promise<{ success: boolean; result?: { streamId: string }; error?: string }> {
  if (!getAccessToken()) return { success: false, error: '未登录' }
  const body = stripAiPayload(payload)
  if (!body) return { success: false, error: '缺少 task' }
  try {
    const res = await api.post('ai/agent-stream/start', body).json<{ success: boolean; result?: { streamId?: string } }>()
    const streamId = res.result?.streamId
    if (!streamId) return { success: false, error: '未返回 streamId' }
    void consumeStreamEvents(streamId)
    return { success: true, result: { streamId } }
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : 'Agent 流式任务启动失败' }
  }
}

async function uploadReferenceNovel(file: File, meta: Record<string, unknown>) {
  const token = getAccessToken()
  if (!token) throw new Error('未登录')
  const form = new FormData()
  form.append('file', file)
  form.append('meta', JSON.stringify(meta))
  const res = await fetch('/api/character-arc/v1/reference-novels/import', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  })
  const body = await res.json()
  if (!res.ok) throw new Error((body as { message?: string }).message ?? '拆书失败')
  return body
}

async function startAiStreamRequest(payload: unknown): Promise<{ success: boolean; result?: { streamId: string }; error?: string }> {
  if (!getAccessToken()) return { success: false, error: '未登录' }
  const body = stripAiPayload(payload)
  if (!body) return { success: false, error: '缺少 task' }
  try {
    const res = await api.post('ai/stream/start', body).json<{ success: boolean; result?: { streamId?: string } }>()
    const streamId = res.result?.streamId
    if (!streamId) return { success: false, error: '未返回 streamId' }
    void consumeStreamEvents(streamId)
    return { success: true, result: { streamId } }
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : '流式任务启动失败' }
  }
}

function noopUnsub(): void {
  /* noop */
}

async function apiPost<T>(path: string, body: unknown): Promise<T> {
  return api.post(path, body).json<T>()
}

async function loadWorkspace(): Promise<{ success: boolean; payload?: unknown; error?: string }> {
  if (!getAccessToken()) {
    return { success: false, error: '未登录' }
  }
  try {
    const payload = await api.get('workspace').json<Record<string, unknown>>()
    return { success: true, payload }
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : '加载工作区失败' }
  }
}

async function saveWorkspace(payload: unknown): Promise<{ success: boolean; error?: string }> {
  if (!getAccessToken()) {
    return { success: false, error: '未登录' }
  }
  try {
    await api.put('workspace', payload)
    return { success: true }
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : '保存失败' }
  }
}

async function saveAppSettings(payload: unknown): Promise<{ success: boolean; error?: string }> {
  if (!getAccessToken()) {
    return { success: false, error: '未登录' }
  }
  const body = payload as {
    theme?: string
    selectedProjectId?: string
    appSettings?: Record<string, unknown>
  }
  try {
    const tasks: Promise<unknown>[] = []
    if (body.theme !== undefined || body.selectedProjectId !== undefined) {
      tasks.push(
        api.put('users/me/app-settings', {
          ...(body.theme !== undefined ? { theme: body.theme } : {}),
          ...(body.selectedProjectId !== undefined ? { selectedProjectId: body.selectedProjectId } : {}),
        }),
      )
    }
    if (body.appSettings && typeof body.appSettings === 'object') {
      const settings = body.appSettings
      tasks.push(
        api.put('users/me/app-settings', {
          theme: typeof settings.theme === 'string' ? settings.theme : undefined,
          selectedProjectId:
            typeof settings.selectedProjectId === 'string' ? settings.selectedProjectId : body.selectedProjectId,
          uiScale: typeof settings.uiScale === 'number' ? settings.uiScale : undefined,
          darkMode: typeof settings.darkMode === 'boolean' ? settings.darkMode : undefined,
          darkModeStyle: typeof settings.darkModeStyle === 'string' ? settings.darkModeStyle : undefined,
        }),
      )
    }
    await Promise.all(tasks)
    return { success: true }
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : '保存设置失败' }
  }
}

const assistantClient = {
  sessionList: async (payload: unknown) => apiPost<never[]>('assistant/session/list', payload),
  sessionCreate: async (payload: unknown) => apiPost<never>('assistant/session/create', payload),
  sessionDelete: async (payload: unknown) => apiPost<{ ok: boolean }>('assistant/session/delete', payload),
  sessionLoad: async (payload: unknown) =>
    apiPost<{ session: unknown; turns: unknown[]; events: unknown[] }>('assistant/session/load', payload),
  sessionRename: async (payload: unknown) => apiPost<{ ok: boolean }>('assistant/session/rename', payload),
  turnSend: async (payload: unknown) => apiPost<Record<string, unknown>>('assistant/turn/send', payload),
  turnCancel: async (payload: unknown) => apiPost<{ ok: boolean; reason?: string }>('assistant/turn/cancel', payload),
  stageList: async (payload: unknown) => apiPost<never[]>('assistant/stage/list', payload),
  stageAccept: async (payload: unknown) => apiPost<never[]>('assistant/stage/accept', payload),
  stageReject: async (payload: unknown) => apiPost<never[]>('assistant/stage/reject', payload),
  stageCommit: async (payload: unknown) => apiPost<never[]>('assistant/stage/commit', payload),
  stageBindTarget: async (payload: unknown) => apiPost<unknown>('assistant/stage/bind-target', payload),
  onEvent: (callback: (payload: unknown) => void) => subscribeProgress('assistant', callback),
}

export function installCharacterArcClient(): void {
  if (typeof window === 'undefined') return

  window.characterArc = {
    platform: 'web',
    version: '1.13.0-web',

    loadWorkspace,
    saveWorkspace,
    saveAppSettings,
    publishWorkspaceSync: async () => ({ success: true }),

    setZoomFactor: async (factor: number) => ({ success: true, factor }),
    getZoomFactor: async () => ({ success: true, factor: 1 }),
    setTitleBarOverlay: async () => {},

    onWorkspaceSync: () => noopUnsub,
    onAiStreamEvent: (callback: (payload: unknown) => void) => {
      streamListeners.add(callback)
      return () => {
        streamListeners.delete(callback)
      }
    },
    onAiRunEvent: () => noopUnsub,
    onChapterStateWarnings: () => noopUnsub,
    onChapterPostGenerationIssues: () => noopUnsub,
    onReferenceImportProgress: (callback: (payload: unknown) => void) => subscribeProgress('referenceImport', callback),
    onSpiralProgress: (callback: (payload: unknown) => void) => subscribeProgress('spiral', callback),
    onBackfillStateProgress: (callback: (payload: unknown) => void) => subscribeProgress('backfillState', callback),

    pickCoverImage: async () => {
      const picked = await pickImageFile()
      if (picked.canceled) return { success: false, canceled: true }
      return { success: true, canceled: false, dataUrl: picked.dataUrl, filePath: picked.file.name }
    },
    exportJson: async (payload: unknown) => {
      const body = payload as { data?: unknown; defaultPath?: string }
      const json = JSON.stringify(body.data ?? payload, null, 2)
      downloadTextFile(body.defaultPath ?? 'characterarc-export.json', json)
      return { success: true, canceled: false }
    },
    exportProjectArchive: async (payload: unknown) => {
      if (!getAccessToken()) return { success: false, canceled: true, error: '未登录' }
      const request = (payload ?? {}) as { projectId?: string; projectTitle?: string }
      const projectId = String(request.projectId ?? '').trim()
      if (!projectId) return { success: false, canceled: false, error: '缺少要导出的项目 ID。' }
      try {
        const token = getAccessToken()!
        const res = await fetch(
          `/api/character-arc/v1/projects/${encodeURIComponent(projectId)}/export-archive`,
          { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
        )
        if (!res.ok) {
          const body = (await res.json()) as { message?: string }
          return { success: false, canceled: false, error: body.message ?? '导出失败' }
        }
        const blob = await res.blob()
        const filename = `${request.projectTitle ?? 'project'}.carc`
        downloadBlobFile(filename, blob)
        return { success: true, canceled: false, filePath: filename }
      } catch (e) {
        return { success: false, canceled: false, error: e instanceof Error ? e.message : '导出失败' }
      }
    },
    inspectProjectArchive: async () => {
      if (!getAccessToken()) return { success: false, canceled: true, error: '未登录' }
      const picked = await pickArchiveFile()
      if (picked.canceled) return { success: false, canceled: true }
      try {
        const form = new FormData()
        form.append('file', picked.file)
        const token = getAccessToken()!
        const res = await fetch('/api/character-arc/v1/projects/import/preview', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          body: form,
        })
        const preview = await res.json()
        if (!res.ok) {
          return { success: false, canceled: false, error: (preview as { message?: string }).message ?? '预览失败' }
        }
        const filePath = cacheArchiveFile(picked.file)
        return { success: true, canceled: false, filePath, preview }
      } catch (e) {
        return { success: false, canceled: false, error: e instanceof Error ? e.message : '预览失败' }
      }
    },
    importProjectArchive: async (payload: unknown) => {
      if (!getAccessToken()) return { success: false, canceled: false, error: '未登录' }
      const request = (payload ?? {}) as {
        filePath?: string
        mode?: string
        targetProjectId?: string
        modules?: string[]
      }
      const filePath = String(request.filePath ?? '').trim()
      const file = peekArchiveFile(filePath) ?? takeArchiveFile(filePath)
      if (!file) return { success: false, canceled: false, error: '缺少要导入的项目归档文件。' }
      try {
        const form = new FormData()
        form.append('file', file)
        if (request.mode) form.append('mode', request.mode)
        if (request.targetProjectId) form.append('targetProjectId', request.targetProjectId)
        if (request.modules) form.append('modules', JSON.stringify(request.modules))
        const token = getAccessToken()!
        const res = await fetch('/api/character-arc/v1/projects/import', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          body: form,
        })
        const body = (await res.json()) as { id?: string; message?: string }
        takeArchiveFile(filePath)
        if (!res.ok) return { success: false, canceled: false, error: body.message ?? '导入失败' }
        return { success: true, canceled: false, selectedProjectId: body.id }
      } catch (e) {
        return { success: false, canceled: false, error: e instanceof Error ? e.message : '导入失败' }
      }
    },
    exportText: async (payload: unknown) => {
      const body = payload as { data?: unknown; defaultPath?: string; title?: string }
      let text: string
      if (typeof body.data === 'string') {
        text = body.data
      } else if (
        body.data
        && typeof body.data === 'object'
        && Array.isArray((body.data as ChaptersExportPayload).chapters)
      ) {
        text = buildChaptersExportText(body.data as ChaptersExportPayload)
      } else {
        text = typeof body.data === 'object'
          ? JSON.stringify(body.data, null, 2)
          : String(body.data ?? payload ?? '')
      }
      downloadTextFile(body.defaultPath ?? 'characterarc-export.txt', text)
      return { success: true, canceled: false }
    },
    exportChapterTxt: async (payload: unknown) => {
      const body = payload as { content?: string; defaultFileName?: string; title?: string }
      const filename = body.defaultFileName ?? `${body.title ?? 'chapter'}.txt`
      downloadTextFile(filename, body.content ?? '')
      return { success: true, canceled: false }
    },
    exportChapterDocx: async (payload: unknown) => {
      const body = payload as { title?: string; content?: string; defaultFileName?: string }
      return exportChapterDocxFile(
        body.defaultFileName?.trim() || 'chapter.docx',
        body.title ?? '',
        body.content ?? '',
      )
    },
    importJson: async () => {
      const picked = await pickJsonFile()
      if (picked.canceled) return { success: false, canceled: true }
      try {
        const parsed = JSON.parse(picked.text) as unknown
        const res = await api.post('workspace/import-json', { payload: parsed }).json<{
          success?: boolean
          payload?: unknown
          meta?: unknown
          message?: string
        }>()
        return res.success
          ? { success: true, canceled: false, payload: res.payload, meta: res.meta }
          : { success: false, canceled: false, error: res.message ?? '导入失败' }
      } catch (e) {
        return {
          success: false,
          canceled: false,
          error: e instanceof Error ? e.message : '文件不是有效的 JSON 格式。',
        }
      }
    },
    importReferenceNovelAnalysis: async (payload: unknown) => {
      const picked = await pickReferenceNovelFiles()
      if (picked.length === 0) return { success: false, canceled: true }
      try {
        const result = await uploadReferenceNovel(picked[0], (payload ?? {}) as Record<string, unknown>)
        return { success: true, canceled: false, ...(result as object) }
      } catch (e) {
        return { success: false, canceled: false, error: e instanceof Error ? e.message : '参考作品拆书失败' }
      }
    },
    importReferenceNovelBatch: async (payload: unknown) => {
      const request = (payload ?? {}) as { filePaths?: string[]; concurrency?: number }
      const token = getAccessToken()
      if (!token) return { success: false, canceled: true, error: '未登录' }

      let files: File[] = []
      if (Array.isArray(request.filePaths) && request.filePaths.length > 0) {
        files = await pickReferenceNovelFiles()
        files = files.filter((file) => request.filePaths!.includes(file.name))
      } else {
        files = await pickReferenceNovelFiles()
      }
      if (files.length === 0) return { success: false, canceled: true }

      const form = new FormData()
      for (const file of files) form.append('file', file)
      form.append(
        'meta',
        JSON.stringify({ ...(payload as object), concurrency: request.concurrency ?? 3 }),
      )
      try {
        const res = await fetch('/api/character-arc/v1/reference-novels/import-batch', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          body: form,
        })
        const body = await res.json()
        if (!res.ok) {
          return { success: false, canceled: false, error: (body as { message?: string }).message ?? '批量拆书失败' }
        }
        return { success: true, canceled: false, ...(body as object) }
      } catch (e) {
        return { success: false, canceled: false, error: e instanceof Error ? e.message : '批量拆书失败' }
      }
    },
    pickReferenceNovelFiles: async () => {
      const files = await pickReferenceNovelFiles()
      if (files.length === 0) return { success: false, canceled: true }
      return {
        success: true,
        canceled: false,
        files: files.map((file) => ({ filePath: file.name, fileName: file.name, size: file.size })),
      }
    },
    cancelReferenceNovelBook: async (bookId: string) => {
      try {
        await api.post('reference-novels/cancel-book', { bookId })
        return { success: true }
      } catch {
        return { success: true }
      }
    },
    readReferenceNovelText: async (refId: string) => {
      if (!getAccessToken()) return { success: false, error: '未登录' }
      try {
        const res = await api.get(`reference-novels/${encodeURIComponent(refId)}/text`).json<{ success?: boolean; content?: string; message?: string }>()
        return res.content ? { success: true, content: res.content } : { success: false, error: res.message ?? '读取失败' }
      } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : '读取失败' }
      }
    },
    scanProjectSkills: async (projectId: string) => {
      if (!getAccessToken()) return { success: false, skills: [], error: '未登录' }
      try {
        const res = await api.get(`projects/${encodeURIComponent(projectId)}/skills`).json<{ success?: boolean; skills?: unknown[] }>()
        return { success: true, skills: res.skills ?? [] }
      } catch {
        return { success: true, skills: [] }
      }
    },
    importProjectSkillsPackage: async (projectId: string) => {
      if (!getAccessToken()) return { success: false, canceled: true, error: '未登录' }
      const picked = await pickZipFile()
      if (picked.canceled) return { success: true, canceled: true, importedSkillIds: [] }
      const uploaded = await uploadProjectFile(projectId, 'project-skill', picked.file)
      if (!uploaded.success) return { success: false, canceled: false, error: uploaded.error, importedSkillIds: [] }
      return {
        success: true,
        canceled: false,
        importedSkillIds: uploaded.importedSkillIds ?? [],
      }
    },
    getProjectSkillsContext: async (projectId: string) => {
      if (!getAccessToken()) return { success: false, skills: [], error: '未登录' }
      try {
        const res = await api.get(`projects/${encodeURIComponent(projectId)}/skills/context`).json<{ success?: boolean; skills?: unknown[] }>()
        return { success: true, skills: res.skills ?? [] }
      } catch {
        return { success: true, skills: [] }
      }
    },

    generateAi: async (payload: unknown) => {
      if (!getAccessToken()) return { success: false, error: '未登录' }
      const body = stripAiPayload(payload)
      if (!body) return { success: false, error: '缺少 task' }
      try {
        const res = await api.post('ai/generate', body).json<{ success: boolean; result?: unknown; meta?: unknown }>()
        return { success: true, result: res.result }
      } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : 'AI 调用失败' }
      }
    },
    cancelAiTask: async (clientTaskId: string) => {
      if (!getAccessToken()) return { success: false, error: '未登录' }
      try {
        await api.post('ai/cancel', { clientTaskId })
        return { success: true }
      } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : '取消失败' }
      }
    },
    startAiStream: startAiStreamRequest,
    stopAiStream: async (streamId: string) => {
      if (!getAccessToken()) return { success: false, error: '未登录' }
      streamConsumers.get(streamId)?.abort()
      streamConsumers.delete(streamId)
      try {
        await api.post('ai/stream/stop', { streamId })
        return { success: true }
      } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : '停止失败' }
      }
    },
    startAiAgentStream: startAiAgentStreamRequest,
    readChapterFromDb: async (projectId: string, chapterId: string) => {
      if (!getAccessToken()) return { success: false, error: '未登录' }
      try {
        const res = await api
          .get(`projects/${encodeURIComponent(projectId)}/chapters/${encodeURIComponent(chapterId)}`)
          .json<{ success?: boolean; result?: unknown; message?: string }>()
        return res.result ? { success: true, result: res.result } : { success: false, error: res.message ?? '读取失败' }
      } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : '读取失败' }
      }
    },
    readChapterVersionFromDb: async (projectId: string, versionId: string) => {
      if (!getAccessToken()) return { success: false, error: '未登录' }
      try {
        const res = await api
          .get(
            `projects/${encodeURIComponent(projectId)}/chapters/versions/${encodeURIComponent(versionId)}`,
          )
          .json<{ success?: boolean; result?: unknown; message?: string }>()
        return res.result ? { success: true, result: res.result } : { success: false, error: res.message ?? '读取失败' }
      } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : '读取失败' }
      }
    },
    commitChapterEdit: async (projectId: string, chapterId: string, oldContent: string, newContent: string) => {
      if (!getAccessToken()) return { success: false, error: '未登录' }
      try {
        const res = await api
          .post(`projects/${encodeURIComponent(projectId)}/chapters/${encodeURIComponent(chapterId)}/commit-edit`, {
            oldContent,
            newContent,
          })
          .json<{ success?: boolean; versionId?: string; message?: string }>()
        return res.success ? { success: true, versionId: res.versionId } : { success: false, error: res.message ?? '写回失败' }
      } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : '写回失败' }
      }
    },
    testAiConnection: async () => {
      if (!getAccessToken()) return { success: false, error: '未登录' }
      try {
        const res = await api.post('users/me/ai-config/test').json<{
          ok: boolean
          model: string
          latencyMs: number
          message?: string
        }>()
        return res.ok
          ? { success: true, result: res }
          : { success: false, error: res.message ?? '连接失败' }
      } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : '连接失败' }
      }
    },
    fetchModels: async () => {
      if (!getAccessToken()) return { success: false, error: '未登录', result: [] }
      try {
        const res = await api.get('ai/models').json<{ success: boolean; result: Array<{ id: string; ownedBy: string | null }> }>()
        return { success: true, result: res.result ?? [] }
      } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : '获取模型失败', result: [] }
      }
    },
    fetchImageModels: async () => {
      if (!getAccessToken()) return { success: false, error: '未登录', result: [] }
      try {
        const res = await api.get('ai/image-models').json<{ success: boolean; result: unknown[] }>()
        return { success: true, result: res.result ?? [] }
      } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : '获取图片模型失败', result: [] }
      }
    },
    generateImage: async (payload: unknown) => {
      if (!getAccessToken()) return { success: false, error: '未登录' }
      try {
        const res = await api.post('ai/generate-image', payload).json<{ success: boolean; result?: unknown; error?: string }>()
        return res.success ? { success: true, result: res.result } : { success: false, error: res.error ?? '图片生成失败' }
      } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : '图片生成失败' }
      }
    },
    readStoryState: async (projectId: string) => {
      if (!getAccessToken()) return { success: false, error: '未登录' }
      try {
        const res = await api
          .get(`projects/${encodeURIComponent(projectId)}/story-state`)
          .json<{ success?: boolean; result?: unknown; message?: string }>()
        return res.success ? { success: true, result: res.result } : { success: false, error: res.message ?? '读取失败' }
      } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : '读取世界状态失败' }
      }
    },
    spiralBootstrap: async (payload: unknown) => {
      if (!getAccessToken()) return { success: false, error: '未登录' }
      try {
        return await api.post('ai/spiral-bootstrap', payload).json<{ success: boolean; result?: unknown; error?: string }>()
      } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : '螺旋生成失败' }
      }
    },
    cancelSpiralBootstrap: async () => {
      if (!getAccessToken()) return { success: false, error: '未登录' }
      try {
        return await api.post('ai/spiral-cancel', {}).json<{ success: boolean; error?: string }>()
      } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : '取消失败' }
      }
    },
    backfillProjectState: async (payload: unknown) => {
      if (!getAccessToken()) return { success: false, error: '未登录' }
      try {
        return await api.post('ai/backfill-state', payload).json<{ success: boolean; result?: unknown; error?: string }>()
      } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : '状态补录失败' }
      }
    },
    reverseExtractContinuation: async (payload: unknown) => {
      if (!getAccessToken()) return { success: false, error: '未登录' }
      const body = payload as {
        projectId?: string
        maxBodyChapters?: number
        maxCharacters?: number
        maxOutlineItems?: number
        maxWorldview?: number
        maxRelations?: number
        rebuildImportedOutline?: boolean
      }
      const projectId = String(body?.projectId ?? '').trim()
      if (!projectId) return { success: false, error: '缺少 projectId' }
      try {
        return await api
          .post(`projects/${encodeURIComponent(projectId)}/continuation/reverse-extract`, {
            maxBodyChapters: body.maxBodyChapters,
            maxCharacters: body.maxCharacters,
            maxOutlineItems: body.maxOutlineItems,
            maxWorldview: body.maxWorldview,
            maxRelations: body.maxRelations,
            rebuildImportedOutline: body.rebuildImportedOutline ?? true,
          })
          .json<{ success: boolean; result?: unknown; message?: string; error?: string }>()
      } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : '反推设定失败' }
      }
    },
    saveCoverImage: async (payload: unknown) => {
      const body = payload as { dataUrl?: string; defaultFileName?: string }
      const dataUrl = String(body?.dataUrl ?? '').trim()
      if (!dataUrl) return { success: false, error: '没有可保存的封面图片。' }
      downloadDataUrl(body.defaultFileName ?? `cover-${Date.now()}.png`, dataUrl)
      return { success: true, canceled: false, filePath: body.defaultFileName ?? 'cover.png' }
    },

    checkUpdate: () => Promise.resolve({ success: true, result: { hasUpdate: false, currentVersion: '1.13.0-web', latestVersion: '1.13.0-web', releaseTitle: '', releaseNotes: '', releaseUrl: '', publishedAt: '', assets: [] } }),
    fetchAnnouncements: () => Promise.resolve({ success: true, data: [] }),
    openExternalUrl: async (url: string) => {
      window.open(url, '_blank', 'noopener,noreferrer')
    },

    listSessions: async (projectId: string) => {
      if (!getAccessToken()) return { success: false, result: [], error: '未登录' }
      try {
        return await api.get('sessions', { searchParams: { projectId } }).json<{ success: boolean; result: unknown[] }>()
      } catch (e) {
        return { success: false, result: [], error: e instanceof Error ? e.message : '获取会话列表失败' }
      }
    },
    loadSession: async (sessionId: string) => {
      if (!getAccessToken()) return { success: false, error: '未登录' }
      try {
        return await api.get(`sessions/${encodeURIComponent(sessionId)}`).json<{ success: boolean; result?: unknown; error?: string }>()
      } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : '加载会话失败' }
      }
    },
    saveSession: async (payload: unknown) => {
      if (!getAccessToken()) return { success: false, error: '未登录' }
      const body = payload as { id?: string }
      const sessionId = String(body.id ?? '')
      if (!sessionId) return { success: false, error: '缺少 sessionId' }
      try {
        return await api.put(`sessions/${encodeURIComponent(sessionId)}`, payload).json<{ success: boolean; error?: string }>()
      } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : '保存会话失败' }
      }
    },
    deleteSession: async (sessionId: string) => {
      if (!getAccessToken()) return { success: false, error: '未登录' }
      try {
        return await api.delete(`sessions/${encodeURIComponent(sessionId)}`).json<{ success: boolean; error?: string }>()
      } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : '删除会话失败' }
      }
    },
    fetchFanqieTrends: async (path: string, force = false) => {
      if (!getAccessToken()) return { success: false, error: '未登录' }
      try {
        const data = await api
          .get('fanqie-trends', { searchParams: { path, force: force ? 'true' : 'false' } })
          .json<Record<string, unknown>>()
        return { success: true, ...data }
      } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : '获取番茄风向标失败' }
      }
    },

    assistant: assistantClient,

    autoCreation: {
      startRun: startAutoCreationRun,
      fetchRun: fetchAutoCreationRun,
      pauseRun: pauseAutoCreationRun,
      resumeRun: resumeAutoCreationRun,
      cancelRun: cancelAutoCreationRun,
      subscribeRun: subscribeAutoCreationRun,
    },

    session: {
      setAutoCreationActive: setAutoCreationSessionActive,
    },
  } as unknown as Window['characterArc']
}
