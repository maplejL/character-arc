import type { AutoCreationChapterStep, ChapterPipelineProgress } from './types'

export type AutoCreationLogLevel = 'info' | 'success' | 'warn' | 'error'

export interface AutoCreationLogEntry {
  id: string
  at: string
  chapterId?: string
  chapterTitle?: string
  chapterIndex?: number
  chapterTotal?: number
  step?: AutoCreationChapterStep | string
  level: AutoCreationLogLevel
  title: string
  detail?: string
  issues?: string[]
}

export type AutoCreationChapterContext = {
  chapterId?: string
  chapterTitle?: string
  chapterIndex?: number
  chapterTotal?: number
}

let logSeq = 0

export function createAutoCreationLogId(): string {
  logSeq += 1
  return `ac-log-${Date.now()}-${logSeq}`
}

export function appendAutoCreationLog(
  entries: AutoCreationLogEntry[],
  entry: Omit<AutoCreationLogEntry, 'id' | 'at'> & { id?: string; at?: string },
): AutoCreationLogEntry[] {
  const next: AutoCreationLogEntry = {
    id: entry.id ?? createAutoCreationLogId(),
    at: entry.at ?? new Date().toISOString(),
    ...entry,
  }
  return [...entries, next]
}

export function progressToLogEntry(
  progress: ChapterPipelineProgress,
  ctx: AutoCreationChapterContext,
): AutoCreationLogEntry {
  const level: AutoCreationLogLevel =
    progress.step === 'persist' ? 'success' : progress.label.includes('失败') ? 'warn' : 'info'
  return {
    id: createAutoCreationLogId(),
    at: new Date().toISOString(),
    ...ctx,
    step: progress.step,
    level,
    title: progress.label,
  }
}

export function wsEventToLogEntry(
  event: Record<string, unknown>,
  ctx: AutoCreationChapterContext,
): Omit<AutoCreationLogEntry, 'id' | 'at'> | null {
  const type = String(event.type ?? '')
  if (type === 'chapter-start') {
    return {
      ...ctx,
      chapterId: String(event.chapterId ?? ''),
      chapterTitle: String(event.chapterTitle ?? ''),
      chapterIndex: Number(event.index ?? 0) + 1,
      chapterTotal: Number(event.total ?? 0),
      level: 'info',
      title: `开始处理：${String(event.chapterTitle ?? event.chapterId ?? '章节')}`,
      detail: `第 ${Number(event.index ?? 0) + 1}/${Number(event.total ?? 0)} 章`,
    }
  }
  if (type === 'step-progress') {
    const step = String(event.step ?? '')
    const auditPass = event.auditPass
    let level: AutoCreationLogLevel = 'info'
    if (step === 'persist') level = 'success'
    if (auditPass === false) level = 'warn'
    const issues = Array.isArray(event.issues) ? (event.issues as string[]) : undefined
    return {
      ...ctx,
      chapterId: String(event.chapterId ?? ctx.chapterId ?? ''),
      step,
      level,
      title: String(event.message ?? event.step ?? '处理中'),
      detail: event.targetWordCount ? `目标字数约 ${event.targetWordCount}` : undefined,
      issues,
    }
  }
  if (type === 'chapter-complete') {
    return {
      ...ctx,
      chapterId: String(event.chapterId ?? ctx.chapterId ?? ''),
      level: event.skipped ? 'info' : 'success',
      title: event.skipped ? '跳过（已验收）' : '本章完成',
    }
  }
  if (type === 'run-status') {
    const status = String(event.status ?? '')
    if (status === 'running' || status === 'queued') return null
    const level: AutoCreationLogLevel =
      status === 'completed' ? 'success' : status === 'paused' ? 'warn' : 'error'
    return {
      level,
      title: status === 'completed' ? '本分卷自动创作已完成' : `任务状态：${status}`,
      detail: String(event.message ?? ''),
    }
  }
  if (type === 'run-error') {
    return {
      level: 'error',
      title: '自动创作中断',
      detail: String(event.message ?? ''),
    }
  }
  return null
}

export const AUTO_CREATION_LOG_STORAGE_PREFIX = 'characterarc:auto-creation-logs:'
