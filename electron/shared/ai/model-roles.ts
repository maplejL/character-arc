/** 章节生产流水线中的模型角色：初稿 / 修复 / 审查，其余任务走默认。 */
export type ModelRole = 'draft' | 'repair' | 'audit' | 'default'

export type ChapterProductionModels = {
  draftProfileId?: string
  draftModel?: string
  repairProfileId?: string
  repairModel?: string
  auditProfileId?: string
  auditModel?: string
}

export type AiProfileLike = {
  id: string
  name?: string
  provider: string
  baseUrl: string
  apiKey: string
  model: string
  temperature?: number
  topP?: number
}

export type TaskModelSettingsSource = {
  provider: string
  model: string
  apiKey: string
  baseUrl: string
  temperature?: number
  topP?: number
  aiProfiles?: AiProfileLike[]
  activeAiProfileId?: string
  chapterProductionModels?: ChapterProductionModels
}

/** 任务名 → 模型角色（未列出的任务使用 default / 当前激活配置）。 */
export const TASK_MODEL_ROLE: Partial<Record<string, ModelRole>> = {
  'chapter-memo': 'draft',
  'chapter-brief': 'draft',
  'chapter-first-draft': 'draft',
  'chapter-final-polish': 'draft',
  'chapter-session-note': 'draft',
  'chapter-quality-review': 'audit',
  'chapter-audit': 'audit',
  'story-deep-audit': 'audit',
  'chapter-repair': 'repair',
}

export function resolveModelRole(taskName: string): ModelRole {
  return TASK_MODEL_ROLE[taskName] ?? 'default'
}

function findProfile(profiles: AiProfileLike[], profileId: string | undefined): AiProfileLike | undefined {
  const id = String(profileId ?? '').trim()
  if (!id) return undefined
  return profiles.find((p) => p.id === id)
}

function resolveProfileIdForRole(
  settings: TaskModelSettingsSource,
  role: ModelRole,
): string | undefined {
  const production = settings.chapterProductionModels ?? {}
  const active = String(settings.activeAiProfileId ?? '').trim()

  if (role === 'draft') return production.draftProfileId?.trim() || active || undefined
  if (role === 'repair') return production.repairProfileId?.trim() || active || undefined
  if (role === 'audit') return production.auditProfileId?.trim() || active || undefined
  return active || undefined
}

function resolveProfileForRole(
  settings: TaskModelSettingsSource,
  role: ModelRole,
): AiProfileLike | undefined {
  const profiles = Array.isArray(settings.aiProfiles) ? settings.aiProfiles : []
  if (profiles.length === 0) return undefined
  const profileId = resolveProfileIdForRole(settings, role)
  return findProfile(profiles, profileId)
}

function resolveModelOverride(
  production: ChapterProductionModels,
  role: ModelRole,
): string | undefined {
  if (role === 'draft') return production.draftModel?.trim() || undefined
  if (role === 'repair') return production.repairModel?.trim() || undefined
  if (role === 'audit') return production.auditModel?.trim() || undefined
  return undefined
}

/**
 * 部分模型 API 只接受固定 temperature（如 Kimi coding 的 k3 仅允许 1）。
 * 在任务路由层强制，避免调用侧默认 0 直接 400。
 */
export function forceTemperatureForModel(
  model: string | undefined,
  temperature: number | undefined,
): number | undefined {
  const id = String(model ?? '').trim().toLowerCase()
  if (!id) return temperature
  // Kimi coding：k3 / kimi-k3 仅允许 temperature=1
  if (id === 'k3' || id === 'kimi-k3' || id.startsWith('kimi-k3')) {
    return 1
  }
  return temperature
}

/**
 * 按任务角色解析应使用的 provider/model/apiKey，并附带 modelRole 供日志。
 * 未配置分角色或 profile 缺 key 时回退到当前激活配置或顶层 settings。
 */
export function applyTaskModelSettings<T extends TaskModelSettingsSource>(
  settings: T,
  taskName: string,
): T & { modelRole: ModelRole } {
  const role = resolveModelRole(taskName)
  const profile = resolveProfileForRole(settings, role)
  const production = settings.chapterProductionModels ?? {}
  const modelOverride = resolveModelOverride(production, role)
  if (!profile || !profile.apiKey?.trim()) {
    const model = modelOverride || settings.model
    return {
      ...settings,
      model,
      temperature: forceTemperatureForModel(model, settings.temperature),
      modelRole: role,
    }
  }
  const model = modelOverride || profile.model || settings.model
  return {
    ...settings,
    provider: profile.provider || settings.provider,
    model,
    apiKey: profile.apiKey || settings.apiKey,
    baseUrl: profile.baseUrl || settings.baseUrl,
    temperature: forceTemperatureForModel(model, profile.temperature ?? settings.temperature),
    topP: profile.topP ?? settings.topP,
    modelRole: role,
  }
}

export function normalizeChapterProductionModels(
  raw: unknown,
): ChapterProductionModels {
  if (!raw || typeof raw !== 'object') return {}
  const source = raw as Record<string, unknown>
  const pick = (key: keyof ChapterProductionModels) => {
    const value = String(source[key] ?? '').trim()
    return value || undefined
  }
  const result: ChapterProductionModels = {}
  const draftProfileId = pick('draftProfileId')
  const draftModel = pick('draftModel')
  const repairProfileId = pick('repairProfileId')
  const repairModel = pick('repairModel')
  const auditProfileId = pick('auditProfileId')
  const auditModel = pick('auditModel')
  if (draftProfileId) result.draftProfileId = draftProfileId
  if (draftModel) result.draftModel = draftModel
  if (repairProfileId) result.repairProfileId = repairProfileId
  if (repairModel) result.repairModel = repairModel
  if (auditProfileId) result.auditProfileId = auditProfileId
  if (auditModel) result.auditModel = auditModel
  return result
}

/** 合并多层生产模型配置；忽略空值，避免 workspace 空对象覆盖 DB 绑定。 */
export function mergeChapterProductionModels(
  ...layers: Array<ChapterProductionModels | undefined>
): ChapterProductionModels {
  return normalizeChapterProductionModels(Object.assign({}, ...layers))
}

function taskNameForRole(role: ModelRole): string {
  if (role === 'draft') return 'chapter-first-draft'
  if (role === 'repair') return 'chapter-repair'
  if (role === 'audit') return 'chapter-quality-review'
  return 'chapter-assistant'
}

function modelSignature(settings: TaskModelSettingsSource & { modelRole?: ModelRole }, taskName: string): string {
  const routed = applyTaskModelSettings(settings, taskName)
  return `${routed.provider}::${routed.model}`
}

/** 收敛流中 audit 与 repair 是否解析到不同模型（需拆 session / 走独立 streamTask）。 */
export function convergenceModelsDiffer(
  settings: TaskModelSettingsSource,
  overrides?: ChapterProductionModels,
): boolean {
  const merged: TaskModelSettingsSource = {
    ...settings,
    chapterProductionModels: {
      ...settings.chapterProductionModels,
      ...overrides,
    },
  }
  const auditSig = modelSignature(merged, taskNameForRole('audit'))
  const repairSig = modelSignature(merged, taskNameForRole('repair'))
  return auditSig !== repairSig
}
