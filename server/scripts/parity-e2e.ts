/**
 * E2E: Web parity APIs — story state / chapter version / fanqie / legacy sessions
 */
import { config as loadEnv } from 'dotenv'
import { spawn } from 'node:child_process'
import { join } from 'node:path'

loadEnv({ path: join(process.cwd(), '../web/.env.e2e') })

const PORT = process.env.PARITY_E2E_PORT ?? '8016'
const API = `http://localhost:${PORT}`
const INVITE = process.env.E2E_INVITE_CODE ?? 'CHARARC-BETA'

async function waitForHealth(timeoutMs = 60_000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${API}/health`)
      if (res.ok) return
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 1500))
  }
  throw new Error('API health timeout')
}

function startServer(dataRoot: string): Promise<{ kill: () => void }> {
  return new Promise((resolve, reject) => {
    const serverDir = join(process.cwd())
    const child = spawn('npx', ['tsx', 'src/index.ts'], {
      cwd: serverDir,
      env: {
        ...process.env,
        USE_PGLITE: '1',
        PORT,
        PGLITE_DIR: join(serverDir, 'data/pglite-parity-e2e'),
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

async function main(): Promise<void> {
  const dataRoot = join(process.cwd(), `data/parity-e2e-${Date.now()}`)
  const server = await startServer(dataRoot)
  try {
    const email = `parity-${Date.now()}@test.local`
    const reg = await fetch(`${API}/api/character-arc/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'TestPass123!', inviteCode: INVITE }),
    })
    const { accessToken: token } = (await reg.json()) as { accessToken: string }
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }

    const created = await fetch(`${API}/api/character-arc/v1/projects`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ title: 'Parity E2E', genre: '科幻' }),
    })
    const project = (await created.json()) as { id: string }

    const storyRes = await fetch(`${API}/api/character-arc/v1/projects/${project.id}/story-state`, { headers })
    if (!storyRes.ok) {
      const errBody = await storyRes.text()
      throw new Error(`story-state failed: ${storyRes.status} ${errBody}`)
    }
    const story = (await storyRes.json()) as { success?: boolean }
    if (!story.success) throw new Error('story-state not success')

    const sessionId = `session-${Date.now()}`
    const saveRes = await fetch(`${API}/api/character-arc/v1/sessions/${sessionId}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        projectId: project.id,
        title: 'Parity Session',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })
    const saved = (await saveRes.json()) as { success?: boolean; error?: string }
    if (!saved.success) throw new Error(`session save failed: ${saved.error ?? saveRes.status}`)

    const listRes = await fetch(`${API}/api/character-arc/v1/sessions?projectId=${project.id}`, { headers })
    const listed = (await listRes.json()) as { success?: boolean; result?: unknown[]; error?: string }
    if (!listed.success) throw new Error(`session list error: ${listed.error ?? listRes.status}`)
    if (!listed.result?.length) throw new Error(`session list empty: ${JSON.stringify(listed)}`)

    const fanqieRes = await fetch(`${API}/api/character-arc/v1/fanqie-trends?path=`, { headers })
    if (!fanqieRes.ok) throw new Error(`fanqie failed: ${fanqieRes.status}`)

    const exportRes = await fetch(`${API}/api/character-arc/v1/projects/${project.id}/export-archive`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!exportRes.ok) {
      const errBody = await exportRes.text()
      throw new Error(`export archive failed: ${exportRes.status} ${errBody}`)
    }
    const buf = await exportRes.arrayBuffer()
    if (buf.byteLength < 100) throw new Error('export archive too small')

    console.log('parity-e2e: OK')
  } finally {
    server.kill()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
