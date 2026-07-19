/**
 * E2E: SSE AI stream — POST /ai/stream/start + GET events
 */
import { config as loadEnv } from 'dotenv'
import { spawn } from 'node:child_process'
import { join } from 'node:path'

import { resolveE2eAiEnv } from './e2e-ai-env.js'

loadEnv({ path: join(process.cwd(), '../web/.env.e2e') })
loadEnv({ path: join(process.cwd(), '.env') })

const PORT = process.env.AI_STREAM_E2E_PORT ?? '8012'
const API = `http://localhost:${PORT}`
const INVITE = process.env.E2E_INVITE_CODE ?? 'CHARARC-BETA'
const e2eAi = resolveE2eAiEnv()
const API_KEY = e2eAi.apiKey
const BASE_URL = e2eAi.baseUrl
const MODEL = e2eAi.model
const PROVIDER = e2eAi.provider

async function waitForHealth(timeoutMs = 60_000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${API}/health`)
      if (!res.ok) throw new Error('health not ok')
      const probe = await fetch(`${API}/api/character-arc/v1/ai/stream/start`, { method: 'POST' })
      if (probe.status !== 401 && probe.status !== 404) return
      if (probe.status === 401) return
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 2000))
  }
  throw new Error('API health timeout')
}

function startServer(): Promise<{ kill: () => void }> {
  return new Promise((resolve, reject) => {
    const serverDir = join(process.cwd())
    const child = spawn('npx', ['tsx', 'src/index.ts'], {
      cwd: serverDir,
      env: {
        ...process.env,
        USE_PGLITE: '1',
        PORT,
        PGLITE_DIR: join(serverDir, 'data/pglite-ai-stream-e2e'),
        JWT_SECRET: 'e2e-jwt-secret-min-32-characters-long!!',
        ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
        CORS_ORIGINS: 'http://localhost:5174',
        SEED_INVITE_CODE: INVITE,
        CHARACTERARC_APP_ROOT: join(serverDir, '..'),
      },
      stdio: 'pipe',
      shell: true,
    })
    child.on('error', reject)
    void waitForHealth()
      .then(() => resolve({ kill: () => child.kill('SIGTERM') }))
      .catch(reject)
  })
}

async function readSseUntilDone(streamId: string, token: string): Promise<{ type: string; content?: string; result?: unknown }> {
  const res = await fetch(`${API}/api/character-arc/v1/ai/stream/${encodeURIComponent(streamId)}/events`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok || !res.body) throw new Error(`SSE failed ${res.status}`)

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let lastEvent: { type: string; content?: string; result?: unknown } = { type: 'pending' }

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const parts = buffer.split('\n\n')
    buffer = parts.pop() ?? ''
    for (const part of parts) {
      const line = part.split('\n').find((item) => item.startsWith('data:'))
      if (!line) continue
      const event = JSON.parse(line.slice(5).trim()) as { type?: string; content?: string; result?: unknown; error?: string }
      if (event.type === 'chunk') continue
      if (event.type === 'done' || event.type === 'error' || event.type === 'canceled') {
        lastEvent = { type: event.type ?? 'unknown', content: event.content, result: event.result }
        return lastEvent
      }
    }
  }
  return lastEvent
}

async function main(): Promise<void> {
  if (!API_KEY) {
    console.error('SKIP: E2E_CENTOS_API_KEY / E2E_OPENCODE_API_KEY / E2E_DEEPSEEK_API_KEY 未配置')
    process.exit(0)
  }

  const server = await startServer()
  try {
    const email = `ai-stream-${Date.now()}@test.local`
    const reg = await fetch(`${API}/api/character-arc/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'TestPass123!', inviteCode: INVITE }),
    })
    const { accessToken: token } = (await reg.json()) as { accessToken: string }
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }

    await fetch(`${API}/api/character-arc/v1/users/me/ai-config`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ provider: PROVIDER, model: MODEL, baseUrl: BASE_URL, apiKey: API_KEY }),
    })

    const created = await fetch(`${API}/api/character-arc/v1/projects`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ title: 'Stream E2E', genre: '科幻', wordCount: '100万' }),
    })
    const project = (await created.json()) as { id: string; title: string }

    const start = await fetch(`${API}/api/character-arc/v1/ai/stream/start`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        task: 'chapter-first-draft',
        context: {
          projectId: project.id,
          projectTitle: project.title,
          projectGenre: '科幻',
          chapterTitle: '第一章 异变',
          chapterIndex: 1,
          chapterSummary: '主角在清晨发现城市上空出现奇异光晕，决定出门探查。',
          chapterWordTarget: '800',
          targetWordCount: '800',
        },
        clientKey: 'chapter-first-draft',
      }),
    })
    const started = (await start.json()) as { result?: { streamId?: string } }
    const streamId = started.result?.streamId
    if (!streamId) throw new Error(`no streamId: ${JSON.stringify(started)}`)

    const finalEvent = await readSseUntilDone(streamId, token)
    if (finalEvent.type !== 'done') {
      throw new Error(`stream ended with ${finalEvent.type}`)
    }
    const hasPayload =
      Boolean(finalEvent.content?.trim()) ||
      (finalEvent.result && typeof finalEvent.result === 'object' && Object.keys(finalEvent.result as object).length > 0)
    if (!hasPayload) {
      throw new Error('empty stream result')
    }

    console.log('PASS ai-stream-e2e:', JSON.stringify(finalEvent.result ?? finalEvent.content).slice(0, 80))
  } finally {
    server.kill()
    await new Promise((r) => setTimeout(r, 1500))
  }
  process.exit(0)
}

main().catch((err) => {
  console.error('FAIL ai-stream-e2e:', err)
  process.exit(1)
})
