import {
  CENTOS_OPENAI_BASE_URL,
  DEFAULT_DEEPSEEK_BASE_URL,
  OPENCODE_DEEPSEEK_BASE_URL,
} from './defaults'

export type AiPresetId = 'deepseek' | 'opencode' | 'centos' | 'custom-openai' | 'unknown'

function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '').toLowerCase()
}

export function resolveAiPreset(input: {
  provider: 'deepseek' | 'openai-compatible'
  baseUrl?: string
}): { id: AiPresetId; label: string } {
  if (input.provider === 'deepseek') {
    return { id: 'deepseek', label: 'DeepSeek 官方' }
  }

  const base = normalizeBaseUrl(input.baseUrl ?? '')
  if (base === normalizeBaseUrl(OPENCODE_DEEPSEEK_BASE_URL)) {
    return { id: 'opencode', label: 'OpenCode · DeepSeek' }
  }
  if (base === normalizeBaseUrl(CENTOS_OPENAI_BASE_URL)) {
    return { id: 'centos', label: 'CentOS 中转' }
  }
  if (base) {
    return { id: 'custom-openai', label: 'OpenAI 兼容（自定义网关）' }
  }
  return { id: 'unknown', label: 'OpenAI 兼容' }
}

export function formatAiProviderSummary(input: {
  provider: 'deepseek' | 'openai-compatible'
  model?: string
  baseUrl?: string
  hasApiKey?: boolean
}): string {
  const preset = resolveAiPreset(input)
  const parts = [preset.label]
  if (input.model?.trim()) parts.push(input.model.trim())
  if (input.baseUrl?.trim()) parts.push(input.baseUrl.trim())
  if (input.hasApiKey === false) parts.push('未配置 API Key')
  return parts.join(' · ')
}
