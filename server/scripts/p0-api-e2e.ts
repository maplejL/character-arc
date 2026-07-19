/**
 * P0 API 验收脚本（无需 Playwright 浏览器）
 * Usage: pnpm --dir server exec tsx scripts/p0-api-e2e.ts
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config as loadEnv } from 'dotenv'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
loadEnv({ path: path.resolve(__dirname, '../../web/.env.e2e') })
const API = process.env.E2E_API_BASE ?? 'http://127.0.0.1:8012'
const INVITE = process.env.E2E_INVITE_CODE ?? 'CHARARC-BETA'
const API_KEY = process.env.E2E_DEEPSEEK_API_KEY ?? ''
const BASE_URL = process.env.E2E_DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com'
const MODEL = process.env.E2E_DEEPSEEK_MODEL ?? 'deepseek-chat'

let child: ChildProcess | null = null

async function startServer(): Promise<void> {
  const serverDir = path.resolve(__dirname, '..')
  child = spawn('pnpm start:once', [], {
    cwd: serverDir,
    shell: true,
    env: {
      ...process.env,
      USE_PGLITE: '1',
      PORT: '8012',
      PGLITE_DIR: path.join(serverDir, 'data', 'pglite-api-e2e'),
      JWT_SECRET: 'e2e-jwt-secret-min-32-characters-long!!',
      ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      CORS_ORIGINS: 'http://127.0.0.1:5174',
      SEED_INVITE_CODE: INVITE,
    },
    stdio: 'pipe',
  })
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${API}/health`)
      if (res.ok) return
    } catch {
      /* wait */
    }
    await sleep(1000)
  }
  throw new Error('Server failed to start')
}

async function json(res: Response): Promise<unknown> {
  return res.json()
}

async function run(): Promise<void> {
  if (!process.env.SKIP_SERVER_START) {
    await startServer()
  }

  // 401 format
  const unauth = await fetch(`${API}/api/character-arc/v1/auth/me`)
  if (unauth.status !== 401) throw new Error(`expected 401, got ${unauth.status}`)
  const unauthBody = (await json(unauth)) as { code?: string; message?: string }
  if (!unauthBody.code || !unauthBody.message) throw new Error('401 body missing code/message')

  // no invite
  const badReg = await fetch(`${API}/api/character-arc/v1/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: `bad-${Date.now()}@test.local`,
      password: 'TestPass123!',
      inviteCode: 'INVALID',
    }),
  })
  if (badReg.status !== 403) throw new Error(`expected 403 for bad invite, got ${badReg.status}`)

  const email = `e2e-api-${Date.now()}@test.local`
  const reg = await fetch(`${API}/api/character-arc/v1/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'TestPass123!', inviteCode: INVITE }),
  })
  if (!reg.ok) throw new Error(`register failed: ${reg.status} ${await reg.text()}`)
  const tokens = (await json(reg)) as { accessToken: string }
  const headers = { Authorization: `Bearer ${tokens.accessToken}`, 'Content-Type': 'application/json' }

  const cfg0 = (await json(await fetch(`${API}/api/character-arc/v1/users/me/ai-config`, { headers }))) as Record<string, unknown>
  if ('apiKey' in cfg0) throw new Error('apiKey leaked in response')

  if (!API_KEY) {
    console.log('[p0-api-e2e] SKIP DeepSeek test — E2E_DEEPSEEK_API_KEY not set')
  } else {
    const put = await fetch(`${API}/api/character-arc/v1/users/me/ai-config`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ provider: 'deepseek', model: MODEL, baseUrl: BASE_URL, apiKey: API_KEY }),
    })
    if (!put.ok) throw new Error(`save ai config failed: ${put.status}`)
    const saved = (await json(await fetch(`${API}/api/character-arc/v1/users/me/ai-config`, { headers }))) as { hasApiKey: boolean; apiKey?: string }
    if (!saved.hasApiKey) throw new Error('hasApiKey should be true')
    if ('apiKey' in saved && saved.apiKey) throw new Error('apiKey leaked after save')

    const test = await fetch(`${API}/api/character-arc/v1/users/me/ai-config/test`, {
      method: 'POST',
      headers: { Authorization: headers.Authorization },
    })
    if (!test.ok) throw new Error(`ai test failed: ${test.status} ${await test.text()}`)
    const testBody = (await json(test)) as { ok: boolean; latencyMs: number }
    if (!testBody.ok || !testBody.latencyMs) throw new Error('ai test response invalid')
    console.log(`[p0-api-e2e] DeepSeek OK ${testBody.latencyMs}ms`)
  }

  console.log('[p0-api-e2e] ALL PASSED')
}

run()
  .catch((err) => {
    console.error('[p0-api-e2e] FAILED', err)
    process.exit(1)
  })
  .finally(() => {
    child?.kill()
  })
