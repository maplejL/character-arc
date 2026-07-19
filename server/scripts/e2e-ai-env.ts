/**
 * E2E AI 凭据解析：CentOS 网关 > OpenCode > DeepSeek 官方
 */
import { config as loadEnv } from 'dotenv'
import { join } from 'node:path'

loadEnv({ path: join(process.cwd(), '../web/.env.e2e') })
loadEnv({ path: join(process.cwd(), '.env') })

export type E2eAiEnv = {
  apiKey: string
  baseUrl: string
  model: string
  provider: 'deepseek' | 'openai-compatible'
  source: 'centos' | 'opencode' | 'deepseek' | 'none'
}

export function resolveE2eAiEnv(): E2eAiEnv {
  const centosKey = process.env.E2E_CENTOS_API_KEY?.trim() ?? ''
  if (centosKey) {
    return {
      apiKey: centosKey,
      baseUrl: process.env.E2E_CENTOS_BASE_URL?.trim() || 'https://ai.centos.hk',
      model: process.env.E2E_CENTOS_MODEL?.trim() || 'deepseek-v4-flash',
      provider: 'openai-compatible',
      source: 'centos',
    }
  }

  const opencodeKey = process.env.E2E_OPENCODE_API_KEY?.trim() ?? ''
  if (opencodeKey) {
    return {
      apiKey: opencodeKey,
      baseUrl: process.env.E2E_OPENCODE_BASE_URL?.trim() || 'https://opencode.ai/zen/go',
      model: process.env.E2E_OPENCODE_MODEL?.trim() || 'deepseek-v4-flash',
      provider: 'openai-compatible',
      source: 'opencode',
    }
  }

  const deepseekKey = process.env.E2E_DEEPSEEK_API_KEY?.trim() ?? ''
  return {
    apiKey: deepseekKey,
    baseUrl: process.env.E2E_DEEPSEEK_BASE_URL?.trim() || 'https://api.deepseek.com',
    model: process.env.E2E_DEEPSEEK_MODEL?.trim() || 'deepseek-chat',
    provider: 'deepseek',
    source: deepseekKey ? 'deepseek' : 'none',
  }
}
