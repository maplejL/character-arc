/**
 * Workspace API E2E（扩展现有 P0 流程）
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { setTimeout as sleep } from 'node:timers/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config as loadEnv } from 'dotenv'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
loadEnv({ path: path.resolve(__dirname, '../../web/.env.e2e') })
const API = process.env.E2E_API_BASE ?? 'http://127.0.0.1:8016'
const INVITE = process.env.E2E_INVITE_CODE ?? 'CHARARC-BETA'

let child: ChildProcess | null = null

async function startServer(): Promise<void> {
  const serverDir = path.resolve(__dirname, '..')
  const runId = Date.now()
  const port = '8016'
  child = spawn('pnpm start:once', [], {
    cwd: serverDir,
    shell: true,
    env: {
      ...process.env,
      USE_PGLITE: '1',
      PORT: port,
      PGLITE_DIR: path.join(serverDir, 'data', `pglite-workspace-e2e-${runId}`),
      DATA_ROOT: path.join(serverDir, 'data', `workspace-e2e-${runId}`),
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

async function run(): Promise<void> {
  if (!process.env.SKIP_SERVER_START) {
    await startServer()
  }

  const email = `ws-e2e-${Date.now()}@test.local`
  const reg = await fetch(`${API}/api/character-arc/v1/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'TestPass123!', inviteCode: INVITE }),
  })
  if (!reg.ok) throw new Error(`register failed: ${reg.status}`)
  const tokens = (await reg.json()) as { accessToken: string }
  const headers = {
    Authorization: `Bearer ${tokens.accessToken}`,
    'Content-Type': 'application/json',
  }

  const emptyWs = await fetch(`${API}/api/character-arc/v1/workspace`, { headers })
  if (!emptyWs.ok) throw new Error(`GET workspace failed: ${emptyWs.status}`)
  const ws0 = (await emptyWs.json()) as { projects: unknown[]; selectedProjectId: string }
  if (ws0.projects.length !== 0) throw new Error('expected empty projects')

  const create = await fetch(`${API}/api/character-arc/v1/projects`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ title: '测试长篇', genre: '玄幻', wordCount: '100万字' }),
  })
  if (!create.ok) throw new Error(`POST project failed: ${create.status}`)
  const project = (await create.json()) as { id: string; title: string }
  if (project.title !== '测试长篇') throw new Error('project title mismatch')

  const list = await fetch(`${API}/api/character-arc/v1/projects`, { headers })
  const projects = (await list.json()) as Array<{ id: string; title: string }>
  if (projects.length !== 1 || projects[0].title !== '测试长篇') {
    throw new Error('project list mismatch')
  }

  const ws1 = await fetch(`${API}/api/character-arc/v1/workspace`, { headers })
  const workspace = (await ws1.json()) as {
    selectedProjectId: string
    projects: Array<{ id: string }>
    workspaces: Record<string, unknown>
  }
  if (workspace.selectedProjectId !== project.id) throw new Error('selectedProjectId not set')
  if (!workspace.workspaces[project.id]) throw new Error('project workspace missing')

  const settings = await fetch(`${API}/api/character-arc/v1/users/me/app-settings`, { headers })
  const appSettings = (await settings.json()) as { selectedProjectId: string }
  if (appSettings.selectedProjectId !== project.id) throw new Error('app settings not synced')

  const carcPath = path.resolve(__dirname, '../../samples/projects/国家以为我在吹牛直到我造出恒星引擎.carc')
  const carcBytes = await readFile(carcPath)
  const form = new FormData()
  form.append('file', new Blob([carcBytes]), 'sample.carc')
  const imported = await fetch(`${API}/api/character-arc/v1/projects/import`, {
    method: 'POST',
    headers: { Authorization: headers.Authorization },
    body: form,
  })
  if (!imported.ok) {
    const err = await imported.text()
    throw new Error(`POST import failed: ${imported.status} ${err}`)
  }
  const importedProject = (await imported.json()) as { id: string; title: string; preview: { modules: { chapters?: { count: number } } } }
  if (!importedProject.title.includes('恒星引擎')) throw new Error('import title mismatch')
  if ((importedProject.preview.modules.chapters?.count ?? 0) < 1) throw new Error('import preview chapters missing')

  const list2 = await fetch(`${API}/api/character-arc/v1/projects`, { headers })
  const projects2 = (await list2.json()) as Array<{ id: string; title: string }>
  if (projects2.length !== 2) throw new Error(`expected 2 projects after import, got ${projects2.length}`)

  const ws2 = await fetch(`${API}/api/character-arc/v1/workspace`, { headers })
  const workspace2 = (await ws2.json()) as {
    selectedProjectId: string
    workspaces: Record<string, { chapters?: unknown[] }>
  }
  const importedWs = workspace2.workspaces[importedProject.id]
  if (!importedWs || !Array.isArray(importedWs.chapters) || importedWs.chapters.length < 1) {
    throw new Error('imported workspace chapters missing')
  }

  console.log('workspace-api E2E: ALL PASSED')
}

run()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => {
    child?.kill()
  })
