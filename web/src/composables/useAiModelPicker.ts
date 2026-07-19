import { ref } from 'vue'
import { api, HTTPError } from '../lib/api'

export type AiModelCredential = {
  provider: 'deepseek' | 'openai-compatible'
  baseUrl?: string
  apiKey?: string
  profileId?: string
  hasSavedApiKey?: boolean
}

export type FetchedModel = { id: string; ownedBy: string | null }

export type FetchModelsMeta = {
  baseUrl: string
  provider: string
  profileId?: string
}

export function useAiModelPicker() {
  const models = ref<FetchedModel[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)
  const fetched = ref(false)
  const lastMeta = ref<FetchModelsMeta | null>(null)

  function reset(): void {
    models.value = []
    error.value = null
    fetched.value = false
    lastMeta.value = null
  }

  async function fetchModels(credentials: AiModelCredential): Promise<FetchedModel[]> {
    const hasKey = Boolean(credentials.apiKey?.trim() || credentials.hasSavedApiKey || credentials.profileId)
    if (!credentials.baseUrl?.trim()) {
      error.value = '请先填写供应商 Base URL'
      models.value = []
      fetched.value = false
      lastMeta.value = null
      return []
    }
    if (!hasKey) {
      error.value = '请先填写 API Key'
      models.value = []
      fetched.value = false
      lastMeta.value = null
      return []
    }

    loading.value = true
    error.value = null
    try {
      const res = await api
        .post('users/me/ai-config/models', {
          provider: credentials.provider,
          baseUrl: credentials.baseUrl.trim(),
          apiKey: credentials.apiKey?.trim() || undefined,
          profileId: credentials.profileId || undefined,
        })
        .json<{ success: boolean; result: FetchedModel[]; meta?: FetchModelsMeta }>()
      models.value = res.result ?? []
      lastMeta.value = res.meta ?? null
      fetched.value = true
      if (models.value.length === 0) {
        error.value = '接口未返回可用模型，请手动输入'
      }
      return models.value
    } catch (e) {
      models.value = []
      fetched.value = true
      lastMeta.value = null
      if (e instanceof HTTPError) {
        try {
          const body = (await e.response.json()) as { message?: string; meta?: FetchModelsMeta }
          if (body.meta?.baseUrl) lastMeta.value = body.meta
          error.value = body.message ?? e.message
        } catch {
          error.value = e.message
        }
      } else {
        error.value = e instanceof Error ? e.message : '获取模型列表失败，请手动输入'
      }
      return []
    } finally {
      loading.value = false
    }
  }

  return { models, loading, error, fetched, lastMeta, reset, fetchModels }
}
