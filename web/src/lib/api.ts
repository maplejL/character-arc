import ky, { HTTPError } from 'ky'
import type { TokenResponse } from './types'
import { logoutToLogin, refreshAccessToken } from './tokenRefresh'
import { authHeaders, clearTokens, getAccessToken, setTokens } from './tokens'

async function tryRefreshAndRetry(
  request: Request,
  options: RequestInit,
): Promise<Response | null> {
  if (!getAccessToken() && !options.headers) return null
  const refreshed = await refreshAccessToken()
  if (!refreshed) return null

  const headers = new Headers(options.headers ?? request.headers)
  const token = getAccessToken()
  if (token) headers.set('Authorization', `Bearer ${token}`)

  return fetch(request.url, {
    ...options,
    headers,
    body:
      options.body ??
      (request.method !== 'GET' && request.method !== 'HEAD' ? request.clone().body : undefined),
  })
}

const client = ky.create({
  timeout: 30_000,
  hooks: {
    beforeRetry: [
      async ({ request, error }) => {
        if (!(error instanceof HTTPError) || error.response.status !== 401) return
        if (!getAccessToken()) return
        const refreshed = await refreshAccessToken()
        if (!refreshed) {
          // 不在 beforeRetry 里踢登录，交给 afterResponse / 调用方
          throw error
        }
        request.headers.set('Authorization', `Bearer ${getAccessToken()}`)
      },
    ],
    afterResponse: [
      async (request, options, response) => {
        if (response.status !== 401) return response
        // 登录/注册/刷新本身的 401 不要踢登录
        const url = request.url
        if (
          url.includes('/auth/login') ||
          url.includes('/auth/register') ||
          url.includes('/auth/refresh')
        ) {
          return response
        }
        if (!getAccessToken()) return response

        const retried = await tryRefreshAndRetry(request, options as RequestInit)
        if (retried && retried.status !== 401) return retried

        // 只有 refresh 失败或重试仍 401 才登出
        logoutToLogin()
        return response
      },
    ],
  },
  retry: {
    limit: 1,
    methods: ['get', 'post', 'put', 'delete', 'patch'],
    statusCodes: [401],
  },
})

export const api = {
  post: (path: string, json?: unknown) => {
    const options: { headers: Record<string, string>; json?: unknown } = { headers: authHeaders() }
    if (json !== undefined) options.json = json
    return client.post(`/api/character-arc/v1/${path}`, options)
  },
  postForm: (path: string, formData: FormData) =>
    client.post(`/api/character-arc/v1/${path}`, {
      body: formData,
      headers: authHeaders(),
    }),
  get: (path: string, options?: { searchParams?: Record<string, string> }) =>
    client.get(`/api/character-arc/v1/${path}`, { headers: authHeaders(), ...options }),
  put: (path: string, json: unknown) =>
    client.put(`/api/character-arc/v1/${path}`, {
      json,
      headers: authHeaders(),
    }),
  delete: (path: string) => client.delete(`/api/character-arc/v1/${path}`, { headers: authHeaders() }),
}

export async function postAuth(path: string, json: unknown): Promise<TokenResponse> {
  try {
    const res = await client.post(`/api/character-arc/v1/${path}`, { json }).json<TokenResponse>()
    setTokens(res)
    return res
  } catch (e) {
    if (e instanceof HTTPError && e.response.status === 401) {
      throw e
    }
    throw e
  }
}

export { clearTokens, getAccessToken, getRefreshToken, setTokens } from './tokens'
export { HTTPError }
