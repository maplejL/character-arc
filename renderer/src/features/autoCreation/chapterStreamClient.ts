import { toIpcPayload } from '@/utils/ipcPayload'
import type { AppSettings } from '@/types/app'

export type ChapterStreamTaskName =
  | 'chapter-first-draft'
  | 'chapter-memo'
  | 'chapter-brief'
  | 'chapter-audit'
  | 'chapter-quality-review'
  | 'chapter-repair'
  | 'chapter-final-polish'
  | 'chapter-session-note'

export type ChapterStreamTaskResult = {
  text: string
  result?: unknown
}

export type ChapterStreamEventHandler = (payload: CharacterArcAiStreamEvent) => void

export function createChapterStreamTaskClient(options: {
  appSettings: AppSettings
  onEvent?: ChapterStreamEventHandler
  onTaskChange?: (task: ChapterStreamTaskName | null) => void
}): {
  streamTask: (task: ChapterStreamTaskName, context: Record<string, unknown>) => Promise<ChapterStreamTaskResult>
  getStreamId: () => string | null
  stop: () => Promise<void>
} {
  let streamId: string | null = null
  let resolveStream: ((result: ChapterStreamTaskResult) => void) | null = null
  let rejectStream: ((error: Error) => void) | null = null
  let currentTask: ChapterStreamTaskName | null = null
  let streamBuffer = ''

  const taskErrorMessage: Record<ChapterStreamTaskName, string> = {
    'chapter-memo': 'AI 写作备忘生成失败',
    'chapter-brief': 'AI 任务书生成失败',
    'chapter-first-draft': 'AI 初稿生成失败',
    'chapter-audit': 'AI 章节审计失败',
    'chapter-quality-review': 'AI 章节质量审查失败',
    'chapter-repair': 'AI 章节修复失败',
    'chapter-final-polish': 'AI 终稿润色失败',
    'chapter-session-note': 'AI 写作日志生成失败'
  }

  function releaseStreamState(): void {
    streamId = null
    resolveStream = null
    rejectStream = null
  }

  function handleStreamEvent(payload: CharacterArcAiStreamEvent): void {
    options.onEvent?.(payload)
    if (payload.streamId !== streamId) return

    if (payload.type === 'done') {
      const text = (payload.content?.trim() ? payload.content : streamBuffer).trim()
      const resolve = resolveStream
      releaseStreamState()
      resolve?.({ text, result: payload.result })
      return
    }
    if (payload.type === 'canceled') {
      const reject = rejectStream
      releaseStreamState()
      reject?.(new Error('canceled'))
      return
    }
    if (payload.type === 'error') {
      const reject = rejectStream
      releaseStreamState()
      reject?.(new Error(payload.error || (currentTask ? taskErrorMessage[currentTask] : 'AI 任务失败')))
      return
    }
    if (payload.type === 'chunk') {
      streamBuffer += payload.delta
    }
  }

  const removeListener = window.characterArc.onAiStreamEvent(handleStreamEvent)

  async function streamTask(task: ChapterStreamTaskName, context: Record<string, unknown>): Promise<ChapterStreamTaskResult> {
    currentTask = task
    streamBuffer = ''
    options.onTaskChange?.(task)

    const result = await window.characterArc.startAiStream(toIpcPayload({
      task,
      settings: options.appSettings,
      context
    }))

    const nextStreamId = (result.result as { streamId?: string } | undefined)?.streamId
    if (!result.success || !nextStreamId) {
      throw new Error(result.error ?? taskErrorMessage[task])
    }
    streamId = nextStreamId

    return new Promise<ChapterStreamTaskResult>((resolve, reject) => {
      resolveStream = resolve
      rejectStream = reject
    })
  }

  async function stop(): Promise<void> {
    if (!streamId) return
    const result = await window.characterArc.stopAiStream(streamId)
    if (!result.success && !String(result.error ?? '').includes('当前没有可停止的生成任务')) {
      throw new Error(result.error ?? '停止 AI 任务失败')
    }
    releaseStreamState()
  }

  return {
    streamTask,
    getStreamId: () => streamId,
    stop: async () => {
      await stop()
      removeListener()
    }
  }
}
