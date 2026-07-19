import { clearTokens, getRefreshToken, setTokens } from './tokens'

let refreshInFlight: Promise<boolean> | null = null
let lastRefreshAt = 0
let lastRefreshFailedAt = 0

export function getLastTokenRefreshAt(): number {
  return lastRefreshAt
}

export function markTokenRefreshed(): void {
  lastRefreshAt = Date.now()
}

export async function refreshAccessToken(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight

  refreshInFlight = (async () => {
    const refreshToken = getRefreshToken()
    if (!refreshToken) return false

    try {
      const res = await fetch('/api/character-arc/v1/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      })
      if (!res.ok) {
        lastRefreshFailedAt = Date.now()
        return false
      }
      const body = (await res.json()) as { accessToken?: string; refreshToken?: string }
      if (!body.accessToken || !body.refreshToken) {
        lastRefreshFailedAt = Date.now()
        return false
      }
      setTokens({ accessToken: body.accessToken, refreshToken: body.refreshToken })
      markTokenRefreshed()
      return true
    } catch {
      // 网络抖动：不要清 token，下次再试
      lastRefreshFailedAt = Date.now()
      return false
    } finally {
      refreshInFlight = null
    }
  })()

  return refreshInFlight
}

export function logoutToLogin(): void {
  clearTokens()
  const loginPath = '/character-arc/login'
  if (!window.location.pathname.endsWith('/login') && !window.location.pathname.endsWith('/register')) {
    window.location.href = loginPath
  }
}

/** 刷新接口明确失败（401）后才应踢登录；网络错误不踢 */
export function shouldForceLogoutAfterRefreshFailure(): boolean {
  // 刚失败过且没有 refresh token 才强制
  if (!getRefreshToken()) return true
  return lastRefreshFailedAt > 0 && Date.now() - lastRefreshFailedAt < 5_000
}
