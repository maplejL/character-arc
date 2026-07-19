/**
 * E2E: Web AI pipeline — POST /ai/generate (worldview-entry)
 * Usage: pnpm --dir server test:ai
 */
import { config as loadEnv } from 'dotenv'
import { spawn } from 'node:child_process'
import { join } from 'node:path'

import { resolveE2eAiEnv } from './e2e-ai-env.js'

loadEnv({ path: join(process.cwd(), '../web/.env.e2e') })
loadEnv({ path: join(process.cwd(), '.env') })

const API = process.env.E2E_API_BASE ?? 'http://localhost:8010'
const INVITE = process.env.E2E_INVITE_CODE ?? 'CHARARC-BETA'
const e2eAi = resolveE2eAiEnv()
const API_KEY = e2eAi.apiKey
const BASE_URL = e2eAi.baseUrl
const MODEL = e2eAi.model
const PROVIDER = e2eAi.provider

async function json(res: Response): Promise<unknown> {
  return res.json()
}

async function waitForHealth(timeoutMs = 60_000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${API}/health`)
      if (res.ok) return
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
        PORT: '8010',
        PGLITE_DIR: join(serverDir, 'data/pglite-ai-e2e'),
        JWT_SECRET: 'e2e-jwt-secret-min-32-characters-long!!',
        ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
        CORS_ORIGINS: 'http://localhost:5174',
        SEED_INVITE_CODE: INVITE,
        CHARACTERARC_APP_ROOT: join(serverDir, '..'),
      },
      stdio: 'pipe',
      shell: true,
    })
    let booted = false
    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      if (text.includes('listening')) booted = true
    })
    child.stderr?.on('data', () => {})
    child.on('error', reject)
    void waitForHealth().then(() => {
      if (!booted) booted = true
      resolve({
        kill: () => {
          child.kill('SIGTERM')
        },
      })
    }).catch(reject)
  })
}

async function main(): Promise<void> {
  if (!API_KEY) {
    console.error('SKIP: E2E_CENTOS_API_KEY / E2E_OPENCODE_API_KEY / E2E_DEEPSEEK_API_KEY 未配置')
    process.exit(0)
  }

  const server = await startServer()
  try {
    const email = `ai-e2e-${Date.now()}@test.local`
    const password = 'TestPass123!'

    const reg = await fetch(`${API}/api/character-arc/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, inviteCode: INVITE }),
    })
    if (!reg.ok) throw new Error(`register failed: ${reg.status}`)
    const tokens = (await json(reg)) as { accessToken: string }

    const headers = {
      Authorization: `Bearer ${tokens.accessToken}`,
      'Content-Type': 'application/json',
    }

    await fetch(`${API}/api/character-arc/v1/users/me/ai-config`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ provider: PROVIDER, model: MODEL, baseUrl: BASE_URL, apiKey: API_KEY }),
    })

    await fetch(`${API}/api/character-arc/v1/projects`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ title: 'AI E2E 书', genre: '科幻', wordCount: '100万字' }),
    })

    const projects = (await json(await fetch(`${API}/api/character-arc/v1/projects`, { headers }))) as Array<{
      id: string
      title: string
    }>
    const project = projects.find((p) => p.title === 'AI E2E 书')
    if (!project) throw new Error('project not created')

    const gen = await fetch(`${API}/api/character-arc/v1/ai/generate`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        task: 'worldview-entry',
        context: {
          projectId: project.id,
          projectTitle: project.title,
          projectGenre: '科幻',
          worldviewTitles: [],
        },
        clientKey: 'worldview-entry',
        clientTaskId: `e2e-${Date.now()}`,
      }),
    })

    const body = (await json(gen)) as { success?: boolean; result?: { title?: string; content?: string }; message?: string }
    if (!gen.ok) {
      throw new Error(`generate failed ${gen.status}: ${JSON.stringify(body)}`)
    }
    if (!body.result || typeof body.result !== 'object') {
      throw new Error(`empty result: ${JSON.stringify(body)}`)
    }
    const result = body.result as { title?: string; content?: string }
    if (!result.title?.trim() || !result.content?.trim()) {
      throw new Error(`invalid worldview result: ${JSON.stringify(result)}`)
    }

    console.log('PASS ai-pipeline-e2e worldview-entry:', result.title.slice(0, 40))
  } finally {
    server.kill()
    await new Promise((r) => setTimeout(r, 1500))
  }
  process.exit(0)
}

main().catch((err) => {
  console.error('FAIL ai-pipeline-e2e:', err)
  process.exit(1)
})
