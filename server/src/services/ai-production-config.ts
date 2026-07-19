import { randomUUID } from 'node:crypto'
import { decryptSecret, encryptSecret } from '../lib/crypto.js'
import { config } from '../config.js'
import {
  defaultBaseUrl,
  getUserAiConfig,
  type AiProvider,
  type UserAiConfigRow,
} from './ai-config.js'
import { query } from '../db/pool.js'
import {
  normalizeChapterProductionModels,
  type ChapterProductionModels,
} from '../../../electron/shared/ai/model-roles.js'

export type StoredAiProfile = {
  id: string
  name: string
  provider: AiProvider
  model: string
  baseUrl: string
  apiKeyEnc: string
}

export type PublicAiProfile = {
  id: string
  name: string
  provider: AiProvider
  model: string
  baseUrl: string
  hasApiKey: boolean
}

export type UserProductionAiRow = UserAiConfigRow & {
  ai_profiles_json: StoredAiProfile[]
  active_ai_profile_id: string
  production_models_json: ChapterProductionModels
}

export type ResolvedAiProfile = {
  id: string
  name: string
  provider: string
  model: string
  baseUrl: string
  apiKey: string
}

export type UserProductionAiContext = {
  aiProfiles: ResolvedAiProfile[]
  activeAiProfileId: string
  chapterProductionModels: ChapterProductionModels
}

type AiProfileInput = {
  id?: string
  name: string
  provider: AiProvider
  model: string
  baseUrl?: string
  apiKey?: string
}

function normalizeStoredProfiles(raw: unknown): StoredAiProfile[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
    .map((item) => ({
      id: String(item.id ?? '').trim(),
      name: String(item.name ?? '').trim(),
      provider: (item.provider === 'openai-compatible' ? 'openai-compatible' : 'deepseek') as AiProvider,
      model: String(item.model ?? '').trim(),
      baseUrl: String(item.baseUrl ?? '').trim(),
      apiKeyEnc: String(item.apiKeyEnc ?? '').trim(),
    }))
    .filter((item) => item.id)
}

function toPublicProfile(profile: StoredAiProfile): PublicAiProfile {
  return {
    id: profile.id,
    name: profile.name || profile.model || '未命名',
    provider: profile.provider,
    model: profile.model,
    baseUrl: profile.baseUrl || defaultBaseUrl(profile.provider),
    hasApiKey: Boolean(profile.apiKeyEnc),
  }
}

function legacyProfileFromRow(row: UserAiConfigRow): StoredAiProfile | null {
  if (!row.api_key_enc) return null
  return {
    id: 'profile-default',
    name: row.provider === 'deepseek' ? 'DeepSeek' : 'OpenAI Compatible',
    provider: row.provider,
    model: row.model,
    baseUrl: row.base_url || defaultBaseUrl(row.provider),
    apiKeyEnc: row.api_key_enc,
  }
}

function ensureProfiles(row: UserProductionAiRow | null): StoredAiProfile[] {
  const stored = normalizeStoredProfiles(row?.ai_profiles_json)
  if (stored.length > 0) return stored
  if (!row) return []
  const legacy = legacyProfileFromRow(row)
  return legacy ? [legacy] : []
}

export function listStoredProfiles(row: UserProductionAiRow | null): StoredAiProfile[] {
  return ensureProfiles(row)
}

export async function getUserProductionAiRow(userId: string): Promise<UserProductionAiRow | null> {
  const { rows } = await query<UserProductionAiRow>(
    `SELECT provider, model, base_url, api_key_enc,
            ai_profiles_json, active_ai_profile_id, production_models_json
     FROM user_ai_configs WHERE user_id = $1`,
    [userId],
  )
  const row = rows[0]
  if (!row) return null
  return {
    ...row,
    ai_profiles_json: normalizeStoredProfiles(row.ai_profiles_json),
    active_ai_profile_id: String(row.active_ai_profile_id ?? '').trim(),
    production_models_json: normalizeChapterProductionModels(row.production_models_json),
  }
}

export function publicProductionAiConfig(row: UserProductionAiRow | null): {
  provider: AiProvider
  model: string
  baseUrl: string
  hasApiKey: boolean
  activeAiProfileId: string
  aiProfiles: PublicAiProfile[]
  chapterProductionModels: ChapterProductionModels
} {
  const profiles = ensureProfiles(row)
  const activeId =
    row?.active_ai_profile_id && profiles.some((p) => p.id === row.active_ai_profile_id)
      ? row.active_ai_profile_id
      : profiles[0]?.id ?? ''
  const active = profiles.find((p) => p.id === activeId) ?? profiles[0]
  const legacy = row ? publicAiConfigFromRow(row) : null
  return {
    provider: active?.provider ?? legacy?.provider ?? 'deepseek',
    model: active?.model ?? legacy?.model ?? config.seedAdminAiModel,
    baseUrl: active?.baseUrl || legacy?.baseUrl || defaultBaseUrl(active?.provider ?? 'deepseek'),
    hasApiKey: Boolean(active?.apiKeyEnc || row?.api_key_enc),
    activeAiProfileId: activeId,
    aiProfiles: profiles.map(toPublicProfile),
    chapterProductionModels: normalizeChapterProductionModels(row?.production_models_json),
  }
}

function publicAiConfigFromRow(row: UserAiConfigRow): {
  provider: AiProvider
  model: string
  baseUrl: string
  hasApiKey: boolean
} {
  return {
    provider: row.provider,
    model: row.model,
    baseUrl: row.base_url || defaultBaseUrl(row.provider),
    hasApiKey: Boolean(row.api_key_enc),
  }
}

export async function resolveUserProductionAiContext(userId: string): Promise<UserProductionAiContext> {
  const row = await getUserProductionAiRow(userId)
  const stored = ensureProfiles(row)
  const activeId =
    row?.active_ai_profile_id && stored.some((p) => p.id === row.active_ai_profile_id)
      ? row.active_ai_profile_id
      : stored[0]?.id ?? ''

  const aiProfiles: ResolvedAiProfile[] = []
  for (const profile of stored) {
    const apiKey = profile.apiKeyEnc ? decryptSecret(profile.apiKeyEnc) : ''
    if (!apiKey) continue
    aiProfiles.push({
      id: profile.id,
      name: profile.name,
      provider: profile.provider,
      model: profile.model,
      baseUrl: profile.baseUrl || defaultBaseUrl(profile.provider),
      apiKey,
    })
  }

  if (aiProfiles.length === 0 && row?.api_key_enc) {
    const apiKey = decryptSecret(row.api_key_enc)
    if (apiKey) {
      aiProfiles.push({
        id: activeId || 'profile-default',
        name: row.provider === 'deepseek' ? 'DeepSeek' : 'OpenAI Compatible',
        provider: row.provider,
        model: row.model,
        baseUrl: row.base_url || defaultBaseUrl(row.provider),
        apiKey,
      })
    }
  }

  return {
    aiProfiles,
    activeAiProfileId: activeId || aiProfiles[0]?.id || '',
    chapterProductionModels: normalizeChapterProductionModels(row?.production_models_json),
  }
}

function mergeProfileInputs(
  existing: StoredAiProfile[],
  incoming: AiProfileInput[] | undefined,
  legacyRow: UserAiConfigRow | null,
): StoredAiProfile[] {
  if (!incoming || incoming.length === 0) {
    return ensureProfiles(
      legacyRow
        ? {
            ...legacyRow,
            ai_profiles_json: existing,
            active_ai_profile_id: '',
            production_models_json: {},
          }
        : null,
    )
  }

  const existingById = new Map(existing.map((p) => [p.id, p]))
  return incoming.map((item) => {
    const id = String(item.id ?? '').trim() || `profile-${randomUUID()}`
    const prev = existingById.get(id)
    const provider = item.provider
    const baseUrl = item.baseUrl?.trim() || prev?.baseUrl || defaultBaseUrl(provider)
    const apiKeyEnc = item.apiKey?.trim()
      ? encryptSecret(item.apiKey.trim())
      : prev?.apiKeyEnc ?? ''
    return {
      id,
      name: item.name.trim() || prev?.name || '未命名',
      provider,
      model: item.model.trim() || prev?.model || '',
      baseUrl,
      apiKeyEnc,
    }
  })
}

export async function upsertUserProductionAiConfig(
  userId: string,
  input: {
    provider: AiProvider
    model: string
    baseUrl: string
    apiKeyEnc: string
    aiProfiles?: AiProfileInput[]
    activeAiProfileId?: string
    chapterProductionModels?: ChapterProductionModels
  },
): Promise<void> {
  const existing = await getUserProductionAiRow(userId)
  const mergedProfiles = mergeProfileInputs(
    existing?.ai_profiles_json ?? [],
    input.aiProfiles,
    existing,
  )

  let profiles = mergedProfiles
  if (profiles.length === 0 && input.apiKeyEnc) {
    profiles = [
      {
        id: 'profile-default',
        name: input.provider === 'deepseek' ? 'DeepSeek' : 'OpenAI Compatible',
        provider: input.provider,
        model: input.model,
        baseUrl: input.baseUrl,
        apiKeyEnc: input.apiKeyEnc,
      },
    ]
  }

  const activeCandidate = String(input.activeAiProfileId ?? existing?.active_ai_profile_id ?? '').trim()
  const activeAiProfileId =
    activeCandidate && profiles.some((p) => p.id === activeCandidate)
      ? activeCandidate
      : profiles[0]?.id ?? ''

  const activeProfile = profiles.find((p) => p.id === activeAiProfileId) ?? profiles[0]
  const provider = activeProfile?.provider ?? input.provider
  const model = activeProfile?.model ?? input.model
  const baseUrl = activeProfile?.baseUrl ?? input.baseUrl
  const apiKeyEnc = activeProfile?.apiKeyEnc || input.apiKeyEnc

  await query(
    `INSERT INTO user_ai_configs (
       user_id, provider, model, base_url, api_key_enc,
       ai_profiles_json, active_ai_profile_id, production_models_json, updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::jsonb, now())
     ON CONFLICT (user_id) DO UPDATE SET
       provider = EXCLUDED.provider,
       model = EXCLUDED.model,
       base_url = EXCLUDED.base_url,
       api_key_enc = CASE WHEN EXCLUDED.api_key_enc = '' THEN user_ai_configs.api_key_enc ELSE EXCLUDED.api_key_enc END,
       ai_profiles_json = EXCLUDED.ai_profiles_json,
       active_ai_profile_id = EXCLUDED.active_ai_profile_id,
       production_models_json = EXCLUDED.production_models_json,
       updated_at = now()`,
    [
      userId,
      provider,
      model,
      baseUrl,
      apiKeyEnc,
      JSON.stringify(profiles),
      activeAiProfileId,
      JSON.stringify(normalizeChapterProductionModels(input.chapterProductionModels)),
    ],
  )
}
