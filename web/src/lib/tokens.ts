import { ref, readonly } from 'vue'
import type { TokenResponse } from './types'

const TOKEN_KEY = 'ca_access_token'
const REFRESH_KEY = 'ca_refresh_token'

/** 响应式登录态：避免 computed 读 localStorage 被缓存后永不更新 */
const accessTokenRef = ref<string | null>(
  typeof localStorage !== 'undefined' ? localStorage.getItem(TOKEN_KEY) : null,
)
const refreshTokenRef = ref<string | null>(
  typeof localStorage !== 'undefined' ? localStorage.getItem(REFRESH_KEY) : null,
)

export const accessToken = readonly(accessTokenRef)

export function getAccessToken(): string | null {
  return accessTokenRef.value
}

export function getRefreshToken(): string | null {
  return refreshTokenRef.value
}

export function setTokens(t: Pick<TokenResponse, 'accessToken' | 'refreshToken'>): void {
  accessTokenRef.value = t.accessToken
  refreshTokenRef.value = t.refreshToken
  localStorage.setItem(TOKEN_KEY, t.accessToken)
  localStorage.setItem(REFRESH_KEY, t.refreshToken)
}

export function clearTokens(): void {
  accessTokenRef.value = null
  refreshTokenRef.value = null
  localStorage.removeItem(TOKEN_KEY)
  localStorage.removeItem(REFRESH_KEY)
}

export function authHeaders(): Record<string, string> {
  const token = getAccessToken()
  return token ? { Authorization: `Bearer ${token}` } : {}
}

/** 仅当响应明确表示鉴权失败时返回 true（网络错误不算） */
export function isAuthFailureStatus(status: number): boolean {
  return status === 401 || status === 403
}
