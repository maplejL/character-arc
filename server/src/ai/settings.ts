import { decryptSecret } from '../lib/crypto.js'
import {
  defaultBaseUrl,
  getUserAiConfig,
  type AiProvider,
} from '../services/ai-config.js'

export type ServerAppSettings = {
  provider: string
  model: string
  apiKey: string
  baseUrl: string
  embeddingModel: string
  imageModel: string
  imageApiKey: string
  imageBaseUrl: string
  temperature?: number
  topP?: number
  aiTimeoutSeconds?: number
}

export async function resolveUserAppSettings(userId: string): Promise<ServerAppSettings> {
  const row = await getUserAiConfig(userId)
  if (!row?.api_key_enc) {
    throw Object.assign(new Error('请先配置 API Key'), { statusCode: 503, code: 'ai_not_configured' })
  }
  const apiKey = decryptSecret(row.api_key_enc)
  if (!apiKey) {
    throw Object.assign(new Error('API Key 无效'), { statusCode: 503, code: 'ai_not_configured' })
  }
  const provider = row.provider as AiProvider
  return {
    provider,
    model: row.model,
    apiKey,
    baseUrl: row.base_url || defaultBaseUrl(provider),
    embeddingModel: '',
    imageModel: '',
    imageApiKey: '',
    imageBaseUrl: '',
    aiTimeoutSeconds: 180,
  }
}

export function mapProviderForAiSdk(provider: string): string {
  return provider
}
