import { randomUUID } from 'node:crypto'
import { query } from '../db/pool.js'

export type AutoCreationRunStatus =
  | 'queued'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type AutoCreationPauseReason = 'user' | 'api_error' | 'config_error' | 'quality_limit'

export interface AutoCreationConfig {
  targetWordCount?: number
  forcedWordCountMin?: number
  forcedWordCountMax?: number
  selectedReferenceWorkIds?: string[]
  enabledSkillIds?: string[]
  userPrompt?: string
  /** @deprecated 使用 maxRepairRounds */
  maxAuditRepairRounds?: number
  /** @deprecated 使用 maxRepairRounds */
  maxFinalGateRounds?: number
  maxRepairRounds?: number
  maxChapters?: number
  targetOutlineItemId?: string
  openingRecycleMinChars?: number
  dialogueRatioMin?: number
  qualityReviewMaxWarnings?: number
  qualityReviewEnabled?: boolean
  narratorTelegraphEnabled?: boolean
  chapterBriefEnabled?: boolean
  finalPolishEnabled?: boolean
  /** 单次运行覆盖：初稿模型 profile */
  draftProfileId?: string
  /** 单次运行覆盖：修复模型 profile */
  repairProfileId?: string
  /** 单次运行覆盖：审查模型 profile */
  auditProfileId?: string
  /**
   * 跨章一致性检查间隔（每写完 N 章触发一次批次分析，发现 risk 时暂停）。
   * 0 或 undefined 表示关闭。
   */
  consistencyCheckInterval?: number
  /** 跨章一致性检查使用的模型 profile（缺省用审查模型） */
  consistencyProfileId?: string
}

export function getAutoCreationEffectiveTotal(input: {
  chapterQueueLength: number
  maxChapters?: number
  targetOutlineQueueLength?: number
}): number {
  const { chapterQueueLength, maxChapters, targetOutlineQueueLength } = input
  let limit = chapterQueueLength
  if (targetOutlineQueueLength != null && targetOutlineQueueLength > 0) {
    limit = Math.min(limit, targetOutlineQueueLength)
  }
  if (maxChapters != null && maxChapters > 0) {
    limit = Math.min(limit, Math.round(maxChapters))
  }
  return limit
}

export interface AutoCreationRunRow {
  id: string
  user_id: string
  project_id: string
  volume_id: string
  status: AutoCreationRunStatus
  pause_reason: AutoCreationPauseReason | null
  pause_message: string
  config_json: AutoCreationConfig
  chapter_queue_json: string[]
  current_index: number
  current_step: string | null
  completed_chapter_ids: string[]
  skipped_chapter_ids: string[]
  failed_chapter_id: string | null
  worker_id: string | null
  started_at: Date | null
  updated_at: Date
  finished_at: Date | null
}

export interface AutoCreationRunRead {
  id: string
  userId: string
  projectId: string
  volumeId: string
  status: AutoCreationRunStatus
  pauseReason?: AutoCreationPauseReason
  pauseMessage?: string
  config: AutoCreationConfig
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

function mapRow(row: AutoCreationRunRow): AutoCreationRunRead {
  return {
    id: row.id,
    userId: row.user_id,
    projectId: row.project_id,
    volumeId: row.volume_id,
    status: row.status,
    pauseReason: row.pause_reason ?? undefined,
    pauseMessage: row.pause_message || undefined,
    config: row.config_json ?? {},
    chapterQueue: Array.isArray(row.chapter_queue_json) ? row.chapter_queue_json : [],
    currentIndex: row.current_index,
    currentStep: row.current_step ?? undefined,
    completedChapterIds: Array.isArray(row.completed_chapter_ids) ? row.completed_chapter_ids : [],
    skippedChapterIds: Array.isArray(row.skipped_chapter_ids) ? row.skipped_chapter_ids : [],
    failedChapterId: row.failed_chapter_id ?? undefined,
    startedAt: row.started_at?.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    finishedAt: row.finished_at?.toISOString(),
  }
}

export async function createAutoCreationRun(input: {
  userId: string
  projectId: string
  volumeId: string
  config: AutoCreationConfig
  chapterQueue: string[]
}): Promise<AutoCreationRunRead> {
  const id = randomUUID()
  const { rows } = await query<AutoCreationRunRow>(
    `INSERT INTO auto_creation_runs (
      id, user_id, project_id, volume_id, status, config_json, chapter_queue_json
    ) VALUES ($1, $2, $3, $4, 'queued', $5::jsonb, $6::jsonb)
    RETURNING *`,
    [id, input.userId, input.projectId, input.volumeId, JSON.stringify(input.config), JSON.stringify(input.chapterQueue)],
  )
  return mapRow(rows[0]!)
}

export async function getAutoCreationRun(userId: string, runId: string): Promise<AutoCreationRunRead | null> {
  const { rows } = await query<AutoCreationRunRow>(
    'SELECT * FROM auto_creation_runs WHERE id = $1 AND user_id = $2',
    [runId, userId],
  )
  return rows[0] ? mapRow(rows[0]) : null
}

export async function claimNextAutoCreationRun(workerId: string): Promise<AutoCreationRunRead | null> {
  const { rows } = await query<AutoCreationRunRow>(
    `UPDATE auto_creation_runs
     SET status = 'running',
         worker_id = $1,
         started_at = COALESCE(started_at, now()),
         updated_at = now()
     WHERE id = (
       SELECT id FROM auto_creation_runs
       WHERE status IN ('queued')
          OR (status = 'paused' AND pause_reason = 'api_error')
       ORDER BY updated_at ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING *`,
    [workerId],
  )
  return rows[0] ? mapRow(rows[0]) : null
}

export async function updateAutoCreationRun(
  runId: string,
  patch: Partial<{
    status: AutoCreationRunStatus
    pauseReason: AutoCreationPauseReason | null
    pauseMessage: string
    currentIndex: number
    currentStep: string | null
    completedChapterIds: string[]
    skippedChapterIds: string[]
    failedChapterId: string | null
    finishedAt: Date | null
  }>,
): Promise<AutoCreationRunRead | null> {
  const fields: string[] = ['updated_at = now()']
  const values: unknown[] = [runId]
  let idx = 2

  if (patch.status !== undefined) {
    fields.push(`status = $${idx++}`)
    values.push(patch.status)
  }
  if (patch.pauseReason !== undefined) {
    fields.push(`pause_reason = $${idx++}`)
    values.push(patch.pauseReason)
  }
  if (patch.pauseMessage !== undefined) {
    fields.push(`pause_message = $${idx++}`)
    values.push(patch.pauseMessage)
  }
  if (patch.currentIndex !== undefined) {
    fields.push(`current_index = $${idx++}`)
    values.push(patch.currentIndex)
  }
  if (patch.currentStep !== undefined) {
    fields.push(`current_step = $${idx++}`)
    values.push(patch.currentStep)
  }
  if (patch.completedChapterIds !== undefined) {
    fields.push(`completed_chapter_ids = $${idx++}::jsonb`)
    values.push(JSON.stringify(patch.completedChapterIds))
  }
  if (patch.skippedChapterIds !== undefined) {
    fields.push(`skipped_chapter_ids = $${idx++}::jsonb`)
    values.push(JSON.stringify(patch.skippedChapterIds))
  }
  if (patch.failedChapterId !== undefined) {
    fields.push(`failed_chapter_id = $${idx++}`)
    values.push(patch.failedChapterId)
  }
  if (patch.finishedAt !== undefined) {
    fields.push(`finished_at = $${idx++}`)
    values.push(patch.finishedAt)
  }

  const { rows } = await query<AutoCreationRunRow>(
    `UPDATE auto_creation_runs SET ${fields.join(', ')} WHERE id = $1 RETURNING *`,
    values,
  )
  return rows[0] ? mapRow(rows[0]) : null
}

export async function pauseAutoCreationRun(userId: string, runId: string): Promise<AutoCreationRunRead | null> {
  const existing = await getAutoCreationRun(userId, runId)
  if (!existing || !['running', 'queued'].includes(existing.status)) return null
  const { rows } = await query<AutoCreationRunRow>(
    `UPDATE auto_creation_runs
     SET status = 'paused', pause_reason = 'user', updated_at = now()
     WHERE id = $1 AND user_id = $2
     RETURNING *`,
    [runId, userId],
  )
  return rows[0] ? mapRow(rows[0]) : null
}

export async function resumeAutoCreationRun(userId: string, runId: string): Promise<AutoCreationRunRead | null> {
  const existing = await getAutoCreationRun(userId, runId)
  if (!existing || existing.status !== 'paused') return null
  const { rows } = await query<AutoCreationRunRow>(
    `UPDATE auto_creation_runs
     SET status = 'queued', pause_reason = NULL, pause_message = '', updated_at = now()
     WHERE id = $1 AND user_id = $2
     RETURNING *`,
    [runId, userId],
  )
  return rows[0] ? mapRow(rows[0]) : null
}

export async function cancelAutoCreationRun(userId: string, runId: string): Promise<AutoCreationRunRead | null> {
  const existing = await getAutoCreationRun(userId, runId)
  if (!existing || ['completed', 'failed', 'cancelled'].includes(existing.status)) return null
  const { rows } = await query<AutoCreationRunRow>(
    `UPDATE auto_creation_runs
     SET status = 'cancelled', finished_at = now(), updated_at = now()
     WHERE id = $1 AND user_id = $2
     RETURNING *`,
    [runId, userId],
  )
  return rows[0] ? mapRow(rows[0]) : null
}
