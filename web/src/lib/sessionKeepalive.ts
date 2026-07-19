import { getAccessToken } from './tokens'
import { getLastTokenRefreshAt, logoutToLogin, refreshAccessToken } from './tokenRefresh'

const IDLE_LOGOUT_MS = 30 * 60 * 1000
const ACTIVITY_REFRESH_THROTTLE_MS = 60 * 1000
const PROACTIVE_CHECK_MS = 30 * 1000
const TOKEN_REFRESH_BEFORE_EXPIRY_MS = 2 * 60 * 1000
const AUTO_CREATION_REFRESH_MS = 5 * 60 * 1000

let lastActivityAt = Date.now()
let autoCreationActive = false
let timerId: ReturnType<typeof setInterval> | null = null
let autoCreationTimerId: ReturnType<typeof setInterval> | null = null
let installed = false

function decodeJwtExp(token: string): number | null {
  try {
    const payload = token.split('.')[1]
    if (!payload) return null
    const json = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as { exp?: number }
    return typeof json.exp === 'number' ? json.exp * 1000 : null
  } catch {
    return null
  }
}

function shouldRefreshToken(): boolean {
  const token = getAccessToken()
  if (!token) return false
  const exp = decodeJwtExp(token)
  if (!exp) return Date.now() - getLastTokenRefreshAt() > ACTIVITY_REFRESH_THROTTLE_MS
  return exp - Date.now() < TOKEN_REFRESH_BEFORE_EXPIRY_MS
}

async function onUserActivity(): Promise<void> {
  lastActivityAt = Date.now()
  if (!getAccessToken()) return
  if (Date.now() - getLastTokenRefreshAt() < ACTIVITY_REFRESH_THROTTLE_MS && !shouldRefreshToken()) return
  await refreshAccessToken()
}

function onActivityEvent(): void {
  void onUserActivity()
}

function checkIdleLogout(): void {
  if (!getAccessToken()) return
  if (autoCreationActive) return
  if (Date.now() - lastActivityAt < IDLE_LOGOUT_MS) return
  logoutToLogin()
}

async function proactiveTokenCheck(): Promise<void> {
  if (!getAccessToken()) return
  if (autoCreationActive || shouldRefreshToken()) {
    await refreshAccessToken()
  }
  checkIdleLogout()
}

export function setAutoCreationSessionActive(active: boolean): void {
  autoCreationActive = active
  if (active) {
    lastActivityAt = Date.now()
    if (!autoCreationTimerId) {
      autoCreationTimerId = setInterval(() => {
        void refreshAccessToken()
      }, AUTO_CREATION_REFRESH_MS)
    }
    void refreshAccessToken()
    return
  }

  if (autoCreationTimerId) {
    clearInterval(autoCreationTimerId)
    autoCreationTimerId = null
  }
}

export function touchSessionActivity(): void {
  lastActivityAt = Date.now()
}

export function installSessionKeepalive(): void {
  if (installed) return
  installed = true
  lastActivityAt = Date.now()

  const events: Array<keyof WindowEventMap> = ['click', 'keydown', 'mousemove', 'scroll', 'touchstart']
  for (const event of events) {
    window.addEventListener(event, onActivityEvent, { passive: true })
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      void onUserActivity()
    }
  })

  timerId = setInterval(() => {
    void proactiveTokenCheck()
  }, PROACTIVE_CHECK_MS)

  if (getAccessToken()) {
    void refreshAccessToken()
  }
}

export function uninstallSessionKeepalive(): void {
  if (!installed) return
  installed = false
  if (timerId) {
    clearInterval(timerId)
    timerId = null
  }
  if (autoCreationTimerId) {
    clearInterval(autoCreationTimerId)
    autoCreationTimerId = null
  }
}

export { refreshAccessToken } from './tokenRefresh'
