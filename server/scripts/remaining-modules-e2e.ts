/**
 * E2E: remaining IPC modules — skills / reference novel / chapter commit
 */
import { config as loadEnv } from 'dotenv'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import JSZip from 'jszip'

loadEnv({ path: join(process.cwd(), '../web/.env.e2e') })

const PORT = process.env.REMAINING_MODULES_E2E_PORT ?? '8015'
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
        PGLITE_DIR: join(serverDir, 'data/pglite-remaining-modules-e2e'),
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
  const dataRoot = join(process.cwd(), `data/remaining-modules-e2e-${Date.now()}`)
  const server = await startServer(dataRoot)
  try {
    const email = `remaining-${Date.now()}@test.local`
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
      body: JSON.stringify({ title: 'Remaining E2E', genre: '科幻' }),
    })
    const project = (await created.json()) as { id: string }
    const chapterId = `chapter-${Date.now()}`
    const refId = `ref-${Date.now()}`

    const workspaceRes = await fetch(`${API}/api/character-arc/v1/workspace`, { headers })
    const workspace = (await workspaceRes.json()) as Record<string, unknown>
    const ws = (workspace.workspaces as Record<string, Record<string, unknown>>)[project.id] ?? {}
    ws.chapters = [
      {
        id: chapterId,
        title: '第一章',
        summary: '测试章节',
        status: 'draft',
        content: '<p>旧正文</p>',
        volumeId: '',
      },
    ]
    ;(workspace.workspaces as Record<string, unknown>)[project.id] = ws
    await fetch(`${API}/api/character-arc/v1/workspace`, {
      method: 'PUT',
      headers,
      body: JSON.stringify(workspace),
    })

    const commit = await fetch(
      `${API}/api/character-arc/v1/projects/${project.id}/chapters/${chapterId}/commit-edit`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ oldContent: '<p>旧正文</p>', newContent: '<p>新正文</p>' }),
      },
    )
    if (!commit.ok) throw new Error(`commit failed: ${await commit.text()}`)
    const read = await fetch(`${API}/api/character-arc/v1/projects/${project.id}/chapters/${chapterId}`, { headers })
    const chapter = (await read.json()) as { result?: { content?: string } }
    if (!chapter.result?.content?.includes('新正文')) throw new Error('chapter content not updated')

    const form = new FormData()
    form.append('purpose', 'reference-novel')
    form.append('refId', refId)
    form.append('file', new Blob(['参考小说原文测试'], { type: 'text/plain' }), `${refId}.txt`)
    const upload = await fetch(`${API}/api/character-arc/v1/projects/${project.id}/files/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    })
    if (!upload.ok) throw new Error(`upload failed: ${await upload.text()}`)

    const novel = await fetch(`${API}/api/character-arc/v1/reference-novels/${refId}/text`, { headers })
    const novelBody = (await novel.json()) as { content?: string }
    if (!novelBody.content?.includes('参考小说')) throw new Error('reference novel read failed')

    const skills = await fetch(`${API}/api/character-arc/v1/projects/${project.id}/skills`, { headers })
    const skillBody = (await skills.json()) as { skills?: unknown[] }
    if (!Array.isArray(skillBody.skills) || skillBody.skills.length === 0) {
      throw new Error('expected builtin skills')
    }

    const zip = new JSZip()
    zip.file('e2e-skill/SKILL.md', '# E2E\n')
    const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' })
    const skillForm = new FormData()
    skillForm.append('purpose', 'project-skill')
    skillForm.append('file', new Blob([zipBuffer]), 'skills.zip')
    const skillUpload = await fetch(`${API}/api/character-arc/v1/projects/${project.id}/files/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: skillForm,
    })
    const skillUploaded = (await skillUpload.json()) as { importedSkillIds?: string[] }
    if (!skillUploaded.importedSkillIds?.includes('e2e-skill')) throw new Error('skill zip import failed')

    const skillsAfter = await fetch(`${API}/api/character-arc/v1/projects/${project.id}/skills`, { headers })
    const afterBody = (await skillsAfter.json()) as { skills?: Array<{ id?: string }> }
    if (!afterBody.skills?.some((skill) => skill.id === 'e2e-skill')) throw new Error('imported skill not scanned')

    console.log('PASS remaining-modules-e2e')
  } finally {
    server.kill()
    await new Promise((r) => setTimeout(r, 1500))
  }
  process.exit(0)
}

main().catch((err) => {
  console.error('FAIL remaining-modules-e2e:', err)
  process.exit(1)
})
