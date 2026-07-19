import { config } from '../config.js'
import { decryptSecret } from '../lib/crypto.js'
import { query } from '../db/pool.js'

export type AiProvider = 'deepseek' | 'openai-compatible'

export interface UserAiConfigRow {
  provider: AiProvider
  model: string
  base_url: string
  api_key_enc: string
}

export async function getUserAiConfig(userId: string): Promise<UserAiConfigRow | null> {
  const { rows } = await query<UserAiConfigRow>(
    'SELECT provider, model, base_url, api_key_enc FROM user_ai_configs WHERE user_id = $1',
    [userId],
  )
  return rows[0] ?? null
}

export async function upsertUserAiConfig(
  userId: string,
  input: {
    provider: AiProvider
    model: string
    baseUrl: string
    apiKeyEnc: string
  },
): Promise<void> {
  await query(
    `INSERT INTO user_ai_configs (user_id, provider, model, base_url, api_key_enc, updated_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (user_id) DO UPDATE SET
       provider = EXCLUDED.provider,
       model = EXCLUDED.model,
       base_url = EXCLUDED.base_url,
       api_key_enc = CASE WHEN EXCLUDED.api_key_enc = '' THEN user_ai_configs.api_key_enc ELSE EXCLUDED.api_key_enc END,
       updated_at = now()`,
    [userId, input.provider, input.model, input.baseUrl, input.apiKeyEnc],
  )
}

function resolveChatUrl(provider: AiProvider, baseUrl: string): string {
  const stripSuffix = (root: string) =>
    root.replace(/\/v1\/chat\/completions\/?$/i, '').replace(/\/$/, '')

  if (provider === 'deepseek') {
    const root = stripSuffix(baseUrl || config.deepseekBaseUrl)
    return `${root}/v1/chat/completions`
  }
  const root = stripSuffix(baseUrl || config.openAiCompatibleBaseUrl)
  return `${root}/v1/chat/completions`
}

function extractContent(data: Record<string, unknown>): string {
  const choices = data.choices as Array<{ message?: { content?: string; reasoning_content?: string } }> | undefined
  const msg = choices?.[0]?.message
  return (msg?.content || msg?.reasoning_content || '').trim()
}

export async function testAiConnection(userId: string): Promise<{
  ok: boolean
  latencyMs: number
  model: string
  message?: string
}> {
  const row = await getUserAiConfig(userId)
  if (!row || !row.api_key_enc) {
    throw Object.assign(new Error('请先配置 API Key'), { statusCode: 503, code: 'ai_not_configured' })
  }

  const apiKey = decryptSecret(row.api_key_enc)
  if (!apiKey) {
    throw Object.assign(new Error('API Key 无效'), { statusCode: 503, code: 'ai_not_configured' })
  }

  const url = resolveChatUrl(row.provider, row.base_url)
  const body = {
    model: row.model,
    messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
    max_tokens: 16,
  }

  const start = Date.now()
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  })

  const latencyMs = Date.now() - start
  const text = await res.text()
  let data: Record<string, unknown> = {}
  try {
    data = JSON.parse(text) as Record<string, unknown>
  } catch {
    /* ignore */
  }

  const success = res.ok
  await query(
    `INSERT INTO ai_call_logs
     (user_id, feature, provider, model, latency_ms, success, error_message)
     VALUES ($1, 'config-test', $2, $3, $4, $5, $6)`,
    [
      userId,
      row.provider,
      row.model,
      latencyMs,
      success,
      success ? '' : text.slice(0, 500),
    ],
  )

  if (!success) {
    return { ok: false, latencyMs, model: row.model, message: text.slice(0, 200) }
  }

  const content = extractContent(data)
  return { ok: true, latencyMs, model: row.model, message: content || 'OK' }
}

export function publicAiConfig(row: UserAiConfigRow | null): {
  provider: AiProvider
  model: string
  baseUrl: string
  hasApiKey: boolean
} {
  if (!row) {
    return {
      provider: 'openai-compatible',
      model: config.seedAdminAiModel,
      baseUrl: config.openAiCompatibleBaseUrl,
      hasApiKey: false,
    }
  }
  return {
    provider: row.provider,
    model: row.model,
    baseUrl: row.base_url || (row.provider === 'deepseek' ? config.deepseekBaseUrl : config.openAiCompatibleBaseUrl),
    hasApiKey: Boolean(row.api_key_enc),
  }
}

export function defaultBaseUrl(provider: AiProvider): string {
  return provider === 'deepseek' ? config.deepseekBaseUrl : config.openAiCompatibleBaseUrl
}

export type FetchModelsInput = {
  provider?: AiProvider
  baseUrl?: string
  apiKey?: string
  profileId?: string
}

export type FetchModelsResult = {
  models: Array<{ id: string; ownedBy: string | null }>
  meta: {
    baseUrl: string
    provider: AiProvider
    profileId?: string
  }
}

export type ResolvedModelsFetchContext = {
  baseUrl: string
  provider: AiProvider
  profileId?: string
  apiKey: string
}

export async function resolveModelsFetchContext(
  userId: string,
  input: FetchModelsInput,
): Promise<ResolvedModelsFetchContext> {
  const { getUserProductionAiRow, listStoredProfiles } = await import('./ai-production-config.js')

  const profileId = input.profileId?.trim()
  const inputBaseUrl = input.baseUrl?.trim() || ''
  const inputApiKey = input.apiKey?.trim() || ''

  let provider: AiProvider = input.provider === 'openai-compatible' ? 'openai-compatible' : 'deepseek'
  let baseUrl = inputBaseUrl
  let apiKey = inputApiKey

  if (profileId) {
    const row = await getUserProductionAiRow(userId)
    const profiles = listStoredProfiles(row)
    const profile = profiles.find((p) => p.id === profileId)
    if (!profile) {
      throw Object.assign(new Error('供应商不存在，请先保存供应商配置'), {
        statusCode: 400,
        code: 'ai_profile_not_found',
      })
    }
    provider =
      input.provider === 'openai-compatible' || input.provider === 'deepseek'
        ? input.provider
        : profile.provider
    baseUrl = inputBaseUrl || profile.baseUrl || defaultBaseUrl(provider)
    if (!apiKey && profile.apiKeyEnc) {
      apiKey = decryptSecret(profile.apiKeyEnc) || ''
    }
  } else if (!apiKey) {
    const row = await getUserAiConfig(userId)
    if (row?.api_key_enc) {
      apiKey = decryptSecret(row.api_key_enc) || ''
      if (!baseUrl) {
        provider = row.provider
        baseUrl = row.base_url || defaultBaseUrl(row.provider)
      }
    }
  }

  if (!apiKey) {
    throw Object.assign(new Error('请先填写 API Key'), { statusCode: 400, code: 'ai_not_configured' })
  }

  if (!baseUrl) {
    baseUrl = defaultBaseUrl(provider)
  }

  return {
    baseUrl,
    provider,
    profileId: profileId || undefined,
    apiKey,
  }
}

export async function fetchModelsForCredentials(
  userId: string,
  input: FetchModelsInput,
): Promise<FetchModelsResult> {
  const { importAiRuntime } = await import('../ai/register-electron-mock.js')
  const ctx = await resolveModelsFetchContext(userId, input)
  const { fetchModels } = await importAiRuntime()
  const { normalizeSettings } = await import('../../../electron/main/ai/settings.js')
  const { mapProviderForAiSdk } = await import('../ai/settings.js')
  const models = await fetchModels(
    normalizeSettings({
      provider: mapProviderForAiSdk(ctx.provider),
      model: 'deepseek-chat',
      baseUrl: ctx.baseUrl,
      apiKey: ctx.apiKey,
    }),
  )
  return {
    models,
    meta: {
      baseUrl: ctx.baseUrl,
      provider: ctx.provider,
      profileId: ctx.profileId,
    },
  }
}
