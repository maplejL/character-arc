/**
 * E2E: auto-creation worker — POST run + worker completes 1 chapter
 */
import { config as loadEnv } from 'dotenv'
import { readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { join } from 'node:path'

import { resolveE2eAiEnv } from './e2e-ai-env.js'

loadEnv({ path: join(process.cwd(), '../web/.env.e2e') })
loadEnv({ path: join(process.cwd(), '.env') })

const PORT = process.env.AUTO_CREATION_E2E_PORT ?? '8013'
const API = `http://localhost:${PORT}`
const INVITE = process.env.E2E_INVITE_CODE ?? 'CHARARC-BETA'
const e2eAi = resolveE2eAiEnv()
const API_KEY = e2eAi.apiKey
const BASE_URL = e2eAi.baseUrl
const MODEL = e2eAi.model
const PROVIDER = e2eAi.provider
const SAMPLE_CARC = join(process.cwd(), '../samples/projects/国家以为我在吹牛直到我造出恒星引擎.carc')

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
    const dataRoot = join(serverDir, `data/auto-creation-e2e-${Date.now()}`)
    const child = spawn('npx', ['tsx', 'src/index.ts'], {
      cwd: serverDir,
      env: {
        ...process.env,
        USE_PGLITE: '1',
        PORT,
        PGLITE_DIR: join(serverDir, 'data/pglite-auto-creation-e2e'),
        DATA_ROOT: dataRoot,
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

async function waitForRunComplete(token: string, projectId: string, runId: string): Promise<{
  status: string
  pauseMessage?: string
  currentStep?: string
}> {
  const deadline = Date.now() + 600_000
  while (Date.now() < deadline) {
    const res = await fetch(`${API}/api/character-arc/v1/projects/${projectId}/auto-creation/runs/${runId}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    const body = (await res.json()) as {
      result?: {
        status?: string
        pauseMessage?: string
        currentStep?: string
        completedChapterIds?: string[]
      }
    }
    const result = body.result
    const status = result?.status ?? ''
    if (status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'paused') {
      return {
        status,
        pauseMessage: result?.pauseMessage,
        currentStep: result?.currentStep,
      }
    }
    console.log(
      `[auto-creation-worker-e2e] run ${runId}: status=${status || 'unknown'} step=${result?.currentStep ?? '-'}`,
    )
    await new Promise((r) => setTimeout(r, 5000))
  }
  throw new Error('run timeout after 10 minutes')
}

async function main(): Promise<void> {
  if (!API_KEY) {
    console.error('SKIP: E2E_CENTOS_API_KEY / E2E_OPENCODE_API_KEY / E2E_DEEPSEEK_API_KEY 未配置')
    process.exit(0)
  }

  const server = await startServer()
  try {
    const email = `auto-worker-${Date.now()}@test.local`
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

    const carcBuffer = await readFile(SAMPLE_CARC)
    const form = new FormData()
    form.append('file', new Blob([carcBuffer]), 'sample.carc')
    const imported = await fetch(`${API}/api/character-arc/v1/projects/import`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    })
    if (!imported.ok) throw new Error(`import failed: ${await imported.text()}`)
    const project = (await imported.json()) as { id: string; title: string }

    const workspaceRes = await fetch(`${API}/api/character-arc/v1/workspace`, { headers })
    const workspace = (await workspaceRes.json()) as {
      workspaces: Record<string, { outlineVolumes?: Array<{ id: string; title?: string }>; chapters?: Array<{ id: string; volumeId?: string; content?: string }> }>
    }
    const ws = workspace.workspaces[project.id]
    const volumeId = ws?.outlineVolumes?.[0]?.id
    const chapterId = ws?.chapters?.find((chapter) => chapter.volumeId === volumeId)?.id
    if (!volumeId || !chapterId) throw new Error('sample project missing volume/chapter')

    const createRun = await fetch(`${API}/api/character-arc/v1/projects/${project.id}/auto-creation/runs`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        volumeId,
        config: {
          maxChapters: 1,
          targetWordCount: 3000,
          maxAuditRepairRounds: 2,
          maxFinalGateRounds: 2,
        },
      }),
    })
    if (!createRun.ok) throw new Error(`create run failed: ${await createRun.text()}`)
    const created = (await createRun.json()) as { result?: { runId?: string } }
    const runId = created.result?.runId
    if (!runId) throw new Error('missing runId')

    const final = await waitForRunComplete(token, project.id, runId)
    if (final.status === 'paused') {
      throw new Error(
        `run paused at step ${final.currentStep ?? '?'}: ${final.pauseMessage ?? 'unknown reason'}`,
      )
    }
    if (final.status !== 'completed') throw new Error(`run ended with ${final.status}`)

    const afterWs = await fetch(`${API}/api/character-arc/v1/workspace`, { headers })
    const after = (await afterWs.json()) as typeof workspace
    const chapter = after.workspaces[project.id]?.chapters?.find((item) => item.id === chapterId)
    if (!chapter?.content?.trim()) throw new Error('chapter content empty after run')

    console.log('PASS auto-creation-worker-e2e:', chapter.content.slice(0, 80))
  } finally {
    server.kill()
    await new Promise((r) => setTimeout(r, 1500))
  }
  process.exit(0)
}

main().catch((err) => {
  console.error('FAIL auto-creation-worker-e2e:', err)
  process.exit(1)
})
