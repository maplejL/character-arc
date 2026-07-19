import { getAccessToken } from './api'

export type AutoCreationWsEvent = {
  type: string
  runId?: string
  chapterId?: string
  chapterTitle?: string
  step?: string
  message?: string
  status?: string
  auditPass?: boolean
  issues?: string[]
  targetWordCount?: number
  index?: number
  total?: number
  skipped?: boolean
  [key: string]: unknown
}

export type AutoCreationRunRemote = {
  id: string
  projectId: string
  volumeId: string
  status: string
  pauseReason?: string
  pauseMessage?: string
  config: Record<string, unknown>
  chapterQueue: string[]
  currentIndex: number
  currentStep?: string
  completedChapterIds: string[]
  skippedChapterIds: string[]
  failedChapterId?: string
  startedAt?: string
  updatedAt: string
  finishedAt?: string
}

function wsUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${window.location.host}/ws/character-arc/auto-creation`
}

export async function fetchAutoCreationRun(projectId: string, runId: string): Promise<AutoCreationRunRemote> {
  const token = getAccessToken()
  if (!token) throw new Error('未登录')
  const res = await fetch(
    `/api/character-arc/v1/projects/${encodeURIComponent(projectId)}/auto-creation/runs/${encodeURIComponent(runId)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  )
  const body = (await res.json()) as { success?: boolean; result?: AutoCreationRunRemote; message?: string }
  if (!res.ok || !body.result) throw new Error(body.message ?? '获取自动创作任务失败')
  return body.result
}

export async function startAutoCreationRun(
  projectId: string,
  volumeId: string,
  config: Record<string, unknown>,
  options?: { startFromIndex?: number; startFromChapterId?: string },
): Promise<{ runId: string; status: string }> {
  const token = getAccessToken()
  if (!token) throw new Error('未登录')
  const res = await fetch(`/api/character-arc/v1/projects/${encodeURIComponent(projectId)}/auto-creation/runs`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      volumeId,
      config,
      startFromIndex: options?.startFromIndex,
      startFromChapterId: options?.startFromChapterId,
    }),
  })
  const body = (await res.json()) as { success?: boolean; result?: { runId: string; status: string }; message?: string }
  if (!res.ok || !body.result?.runId) throw new Error(body.message ?? '启动自动创作失败')
  return body.result
}

export async function pauseAutoCreationRun(projectId: string, runId: string): Promise<{ ok: boolean; message?: string }> {
  const token = getAccessToken()
  if (!token) return { ok: false, message: '未登录' }
  const res = await fetch(
    `/api/character-arc/v1/projects/${encodeURIComponent(projectId)}/auto-creation/runs/${encodeURIComponent(runId)}/pause`,
    { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
  )
  const body = (await res.json()) as { success?: boolean; message?: string }
  return { ok: res.ok && body.success !== false, message: body.message }
}

export async function resumeAutoCreationRun(projectId: string, runId: string): Promise<{ ok: boolean; message?: string }> {
  const token = getAccessToken()
  if (!token) return { ok: false, message: '未登录' }
  const res = await fetch(
    `/api/character-arc/v1/projects/${encodeURIComponent(projectId)}/auto-creation/runs/${encodeURIComponent(runId)}/resume`,
    { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
  )
  const body = (await res.json()) as { success?: boolean; message?: string }
  return { ok: res.ok && body.success !== false, message: body.message }
}

export async function cancelAutoCreationRun(projectId: string, runId: string): Promise<{ ok: boolean; message?: string }> {
  const token = getAccessToken()
  if (!token) return { ok: false, message: '未登录' }
  const res = await fetch(
    `/api/character-arc/v1/projects/${encodeURIComponent(projectId)}/auto-creation/runs/${encodeURIComponent(runId)}/cancel`,
    { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
  )
  const body = (await res.json()) as { success?: boolean; message?: string }
  return { ok: res.ok && body.success !== false, message: body.message }
}

export function subscribeAutoCreationRun(
  projectId: string,
  runId: string,
  onEvent: (event: AutoCreationWsEvent) => void,
): () => void {
  const token = getAccessToken()
  if (!token) return () => {}

  const socket = new WebSocket(`${wsUrl()}?token=${encodeURIComponent(token)}`)
  socket.onopen = () => {
    socket.send(JSON.stringify({ type: 'subscribe', runId }))
  }
  socket.onmessage = (message) => {
    try {
      onEvent(JSON.parse(String(message.data)) as AutoCreationWsEvent)
    } catch {
      /* ignore */
    }
  }
  return () => {
    try {
      socket.close()
    } catch {
      /* ignore */
    }
  }
}
