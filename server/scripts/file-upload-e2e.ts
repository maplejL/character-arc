/**
 * E2E: multipart file uploads — cover / reference-novel / project-skill
 */
import { config as loadEnv } from 'dotenv'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import JSZip from 'jszip'

loadEnv({ path: join(process.cwd(), '../web/.env.e2e') })

const PORT = process.env.FILE_UPLOAD_E2E_PORT ?? '8014'
const API = `http://localhost:${PORT}`
const INVITE = process.env.E2E_INVITE_CODE ?? 'CHARARC-BETA'

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

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
        PGLITE_DIR: join(serverDir, 'data/pglite-file-upload-e2e'),
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

async function buildSkillZip(): Promise<Buffer> {
  const zip = new JSZip()
  zip.file('demo-skill/SKILL.md', '# Demo Skill\n\n用于 E2E 测试的项目 skill。\n')
  return zip.generateAsync({ type: 'nodebuffer' })
}

async function uploadFile(
  token: string,
  projectId: string,
  purpose: string,
  fileName: string,
  body: Buffer,
  mime: string,
): Promise<{ fileId: string; url: string; importedSkillIds?: string[] }> {
  const form = new FormData()
  form.append('purpose', purpose)
  form.append('file', new Blob([body], { type: mime }), fileName)
  const res = await fetch(`${API}/api/character-arc/v1/projects/${projectId}/files/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  })
  if (!res.ok) throw new Error(`${purpose} upload failed: ${await res.text()}`)
  return (await res.json()) as { fileId: string; url: string; importedSkillIds?: string[] }
}

async function main(): Promise<void> {
  const dataRoot = join(process.cwd(), `data/file-upload-e2e-${Date.now()}`)
  const server = await startServer(dataRoot)
  try {
    const email = `file-upload-${Date.now()}@test.local`
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
      body: JSON.stringify({ title: 'Upload E2E', genre: '科幻' }),
    })
    const project = (await created.json()) as { id: string }

    const cover = await uploadFile(token, project.id, 'cover', 'cover.png', PNG_1X1, 'image/png')
    const coverGet = await fetch(`${API}${cover.url}`, { headers: { Authorization: `Bearer ${token}` } })
    if (!coverGet.ok || (await coverGet.arrayBuffer()).byteLength !== PNG_1X1.length) {
      throw new Error('cover download mismatch')
    }

    const novel = await uploadFile(
      token,
      project.id,
      'reference-novel',
      'sample.txt',
      Buffer.from('第一章 测试参考小说正文。\n', 'utf8'),
      'text/plain',
    )
    const novelGet = await fetch(`${API}${novel.url}`, { headers: { Authorization: `Bearer ${token}` } })
    const novelText = await novelGet.text()
    if (!novelText.includes('参考小说')) throw new Error('reference-novel content mismatch')

    const skillZip = await buildSkillZip()
    const skill = await uploadFile(token, project.id, 'project-skill', 'skills.zip', skillZip, 'application/zip')
    if (!skill.importedSkillIds?.includes('demo-skill')) {
      throw new Error(`skill import ids: ${JSON.stringify(skill.importedSkillIds)}`)
    }

    const projects = await fetch(`${API}/api/character-arc/v1/projects`, { headers })
    const list = (await projects.json()) as Array<{ id: string; cover?: string }>
    const listed = list.find((item) => item.id === project.id)
    if (!listed?.cover?.includes(cover.fileId)) throw new Error('project cover url not updated')

    console.log('PASS file-upload-e2e: cover + reference-novel + project-skill')
  } finally {
    server.kill()
    await new Promise((r) => setTimeout(r, 1500))
  }
  process.exit(0)
}

main().catch((err) => {
  console.error('FAIL file-upload-e2e:', err)
  process.exit(1)
})
