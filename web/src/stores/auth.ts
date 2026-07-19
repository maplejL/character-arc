import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { api, clearTokens, getAccessToken, postAuth, setTokens, HTTPError } from '../lib/api'
import { accessToken } from '../lib/tokens'
import { refreshAccessToken } from '../lib/tokenRefresh'
import type { AiConfigRead, AiConfigWrite, UserRead } from '../lib/types'

export const useAuthStore = defineStore('auth', () => {
  const user = ref<UserRead | null>(null)
  const aiConfig = ref<AiConfigRead | null>(null)
  const error = ref<string | null>(null)
  const loading = ref(false)

  // 依赖响应式 token，刷新/登录后 isLoggedIn 会正确更新
  const isLoggedIn = computed(() => Boolean(accessToken.value))
  const isAdmin = computed(() => user.value?.role === 'ADMIN')

  async function login(email: string, password: string): Promise<void> {
    loading.value = true
    error.value = null
    try {
      const res = await postAuth('auth/login', { email, password })
      setTokens(res)
      user.value = res.user
    } catch (e) {
      error.value = '登录失败，请检查邮箱和密码'
      throw e
    } finally {
      loading.value = false
    }
  }

  async function register(email: string, password: string, inviteCode: string): Promise<void> {
    loading.value = true
    error.value = null
    try {
      const res = await postAuth('auth/register', { email, password, inviteCode })
      setTokens(res)
      user.value = res.user
    } catch (e) {
      error.value = '注册失败，请检查邀请码与密码（至少 8 位）'
      throw e
    } finally {
      loading.value = false
    }
  }

  /**
   * 刷新后恢复会话。
   * - 网络错误：保留 token，不踢登录
   * - 401：先 refresh，再试一次；仍失败才清 token
   */
  async function fetchMe(): Promise<void> {
    if (!getAccessToken()) return

    const load = async (): Promise<UserRead> => api.get('auth/me').json<UserRead>()

    try {
      user.value = await load()
      return
    } catch (e) {
      const status = e instanceof HTTPError ? e.response.status : 0

      if (status === 401) {
        const refreshed = await refreshAccessToken()
        if (refreshed) {
          try {
            user.value = await load()
            return
          } catch (e2) {
            if (e2 instanceof HTTPError && e2.response.status === 401) {
              clearTokens()
              user.value = null
              throw new Error('session_expired')
            }
            // 非鉴权错误：保留 token
            throw e2
          }
        }
        clearTokens()
        user.value = null
        throw new Error('session_expired')
      }

      // 网络 / 5xx：保留本地 token，让页面可继续尝试
      throw e instanceof Error ? e : new Error('fetch_me_failed')
    }
  }

  async function loadAiConfig(): Promise<void> {
    aiConfig.value = await api.get('users/me/ai-config').json<AiConfigRead>()
  }

  async function saveAiConfig(payload: AiConfigWrite): Promise<void> {
    aiConfig.value = await api.put('users/me/ai-config', payload).json<AiConfigRead>()
  }

  async function testAiConfig(): Promise<{ ok: boolean; latencyMs: number; model: string; message?: string }> {
    return api.post('users/me/ai-config/test').json()
  }

  async function createInviteCode(maxUses = 5): Promise<{ code: string }> {
    return api.post('admin/invite-codes', { maxUses }).json()
  }

  function logout(): void {
    clearTokens()
    user.value = null
    aiConfig.value = null
    window.location.href = '/character-arc/login'
  }

  return {
    user,
    aiConfig,
    error,
    loading,
    isLoggedIn,
    isAdmin,
    login,
    register,
    fetchMe,
    loadAiConfig,
    saveAiConfig,
    testAiConfig,
    createInviteCode,
    logout,
  }
})
