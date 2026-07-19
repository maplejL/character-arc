import type { AutoCreationLogEntry } from '@/features/autoCreation/logTypes'
import { AUTO_CREATION_LOG_STORAGE_PREFIX } from '@/features/autoCreation/logTypes'
import type { AutoCreationRun } from '@/features/autoCreation/types'
import { AUTO_CREATION_RUN_STORAGE_KEY } from '@/features/autoCreation/types'

function logStorageKey(runId: string): string {
  return `${AUTO_CREATION_LOG_STORAGE_PREFIX}${runId}`
}

export function loadPersistedAutoCreationLogs(runId: string): AutoCreationLogEntry[] {
  try {
    const raw = localStorage.getItem(logStorageKey(runId))
    if (!raw) return []
    const parsed = JSON.parse(raw) as AutoCreationLogEntry[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function persistAutoCreationLogs(runId: string, entries: AutoCreationLogEntry[]): void {
  if (!entries.length) {
    localStorage.removeItem(logStorageKey(runId))
    return
  }
  localStorage.setItem(logStorageKey(runId), JSON.stringify(entries))
}

export function clearPersistedAutoCreationLogs(runId?: string): void {
  if (!runId) return
  localStorage.removeItem(logStorageKey(runId))
}

export function loadPersistedAutoCreationRun(): AutoCreationRun | null {
  try {
    const raw = localStorage.getItem(AUTO_CREATION_RUN_STORAGE_KEY)
    if (!raw) return null
    return JSON.parse(raw) as AutoCreationRun
  } catch {
    return null
  }
}

export function persistAutoCreationRun(run: AutoCreationRun | null): void {
  if (!run) {
    localStorage.removeItem(AUTO_CREATION_RUN_STORAGE_KEY)
    return
  }
  localStorage.setItem(AUTO_CREATION_RUN_STORAGE_KEY, JSON.stringify(run))
}

export function clearPersistedAutoCreationRun(): void {
  localStorage.removeItem(AUTO_CREATION_RUN_STORAGE_KEY)
}
