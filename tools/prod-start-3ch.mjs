#!/usr/bin/env node
/** Start auto-creation for the next N chapters (skips already-accepted). */
import { readFile } from 'node:fs/promises'

const PROJECT_ID = 'project-1783149829898'
const VOLUME_ID = 'volume-1783149829899-4edc722e'
const API = process.env.CHARACTERARC_API || 'http://127.0.0.1:8010'
const DATA_ROOT = process.env.DATA_ROOT || '/opt/character-arc/data'
const WRITE_COUNT = Number(process.argv[2] || 3)

const BASE_CONFIG = {
  userPrompt: '',
  enabledSkillIds: [],
  maxRepairRounds: 2,
  forcedWordCountMax: 6000,
  forcedWordCountMin: 4000,
  maxAuditRepairRounds: 2,
  maxFinalGateRounds: 2,
  selectedReferenceWorkIds: [],
  qualityReviewMaxWarnings: 4,
  qualityReviewEnabled: true,
  chapterBriefEnabled: true,
  finalPolishEnabled: true,
}

async function login() {
  const body = await fetch(`${API}/api/character-arc/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@characterarc.local', password: '123456' }),
  }).then((r) => r.json())
  if (!body.accessToken) throw new Error(`login failed: ${JSON.stringify(body)}`)
  return body.accessToken
}

async function loadProgress(token) {
  const me = await fetch(`${API}/api/character-arc/v1/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
  }).then((r) => r.json())

  const workspace = JSON.parse(
    await readFile(`${DATA_ROOT}/users/${me.id}/workspace.json`, 'utf8'),
  )
  const ws = workspace.workspaces?.[PROJECT_ID] ?? {}
  const chapters = (Array.isArray(ws.chapters) ? ws.chapters : []).filter(
    (c) => c.volumeId === VOLUME_ID,
  )
  const journals = Array.isArray(workspace.knowledgeDocuments) ? workspace.knowledgeDocuments : []

  const volumeChapters = chapters.map((chapter, index) => {
    const journal = journals.find(
      (doc) =>
        doc.projectId === PROJECT_ID
        && doc.metadata?.chapterId === chapter.id
        && doc.metadata?.autoAcceptancePassed === true,
    )
    return {
      index: index + 1,
      id: chapter.id,
      title: chapter.title,
      accepted: Boolean(journal),
    }
  })

  const accepted = volumeChapters.filter((c) => c.accepted)
  const lastAcceptedIndex =
    accepted.length > 0 ? Math.max(...accepted.map((c) => c.index)) : 0
  const next = volumeChapters.find((c) => c.index > lastAcceptedIndex && !c.accepted)
    ?? volumeChapters.find((c) => !c.accepted)

  return {
    acceptedCount: accepted.length,
    lastAcceptedIndex,
    nextChapterIndex: next?.index ?? lastAcceptedIndex + 1,
    nextChapterTitle: next?.title,
    maxChapters: (next?.index ?? lastAcceptedIndex + 1) + WRITE_COUNT - 1,
  }
}

async function cancelRun(token, runId) {
  const res = await fetch(
    `${API}/api/character-arc/v1/projects/${PROJECT_ID}/auto-creation/runs/${runId}/cancel`,
    { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
  )
  return { status: res.status, body: await res.text() }
}

async function cancelActiveRuns(token) {
  const { execSync } = await import('node:child_process')
  let rows = []
  try {
    const out = execSync(
      `psql postgresql://maple:000125Ljj@localhost:5432/character_arc -t -A -c "SELECT id,status FROM auto_creation_runs WHERE status IN ('running','paused','queued')"`,
      { encoding: 'utf8' },
    )
    rows = out
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [id, status] = line.split('|')
        return { id, status }
      })
  } catch {
    rows = []
  }
  for (const r of rows) {
    console.log('cancel active run:', r.id, r.status)
    console.log(await cancelRun(token, r.id))
  }
}

async function startRun(token, config) {
  const res = await fetch(`${API}/api/character-arc/v1/projects/${PROJECT_ID}/auto-creation/runs`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ volumeId: VOLUME_ID, config }),
  })
  const body = await res.json()
  return { status: res.status, body }
}

async function main() {
  const token = await login()
  const progress = await loadProgress(token)
  console.log('progress:', JSON.stringify(progress, null, 2))

  const config = {
    ...BASE_CONFIG,
    maxChapters: progress.maxChapters,
  }
  console.log('config.maxChapters:', config.maxChapters, `(write next ${WRITE_COUNT} after skip)`)

  await cancelActiveRuns(token)

  const started = await startRun(token, config)
  console.log(JSON.stringify(started, null, 2))
  const runId = started.body?.result?.runId
  if (!runId) process.exit(1)
  console.log('RUN_ID=' + runId)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
