#!/usr/bin/env node
/** Quick status: run + ch1-3 body/acceptance */
import { readFile } from 'node:fs/promises'

const RUN_ID = process.argv[2] || '0befce47-662e-4d9f-95e5-507c081d1342'
const PROJECT_ID = 'project-1783149829898'
const VOLUME_ID = 'volume-1783149829899-4edc722e'
const API = 'http://127.0.0.1:8010'
const WS = '/opt/character-arc/data/users/8227fcf2-5d5e-468f-8870-31d8ca52814c/workspace.json'
const LOG = '/opt/character-arc/app.log'

const TASK_LABEL = {
  'chapter-memo': '备忘',
  'chapter-brief': '任务书',
  'chapter-first-draft': '初稿',
  'chapter-quality-review': '体检',
  'chapter-audit': '审计',
  'chapter-repair': '修复',
  'chapter-final-polish': '润色',
  'chapter-session-note': '下章建议',
}

async function login() {
  const body = await fetch(`${API}/api/character-arc/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@characterarc.local', password: '123456' }),
  }).then((r) => r.json())
  return body.accessToken
}

function plainLen(html) {
  return String(html ?? '').replace(/<[^>]+>/g, '').replace(/\s+/g, '').length
}

function chapterIndex(title) {
  const m = String(title ?? '').match(/第(\d+)章/)
  return m ? Number(m[1]) : null
}

async function extractCalls() {
  const { readFileSync } = await import('node:fs')
  const buf = readFileSync(LOG)
  const text = buf.slice(Math.max(0, buf.length - 4_000_000)).toString('utf8')
  const lines = text.split('\n').filter((l) => l.includes('[ai] prompt logged'))
  const runStart = '2026-07-08T04:10:00'
  const runEnd = '2026-07-08T04:36:00'
  const inRun = lines.filter((l) => {
    const t = l.match(/"time":(\d+)/)?.[1]
    if (t) {
      const iso = new Date(Number(t)).toISOString()
      return iso >= runStart && iso <= runEnd
    }
    return l.includes('deepseek-v4-pro') && l.includes('claude-sonnet-4-6')
  })
  const slice = inRun.length > 10 ? inRun : lines.filter((l) => l.includes('deepseek-v4-pro')).slice(-80)
  const calls = slice.map((l) => {
    const task = l.match(/task=([^\s|]+)/)?.[1]
    const model = l.match(/model=([^\s|]+)/)?.[1]
    return { task, model }
  }).filter((c) => c.task?.startsWith('chapter-'))
  return calls
}

async function main() {
  const token = await login()
  const run = await fetch(
    `${API}/api/character-arc/v1/projects/${PROJECT_ID}/auto-creation/runs/${RUN_ID}`,
    { headers: { Authorization: `Bearer ${token}` } },
  ).then((r) => r.json()).then((j) => j.result)

  const workspace = JSON.parse(await readFile(WS, 'utf8'))
  const ws = workspace.workspaces[PROJECT_ID]
  const journals = (workspace.knowledgeDocuments ?? []).filter((d) => d.sourceLabel === 'writing-journal')
  const chapters = (ws.chapters ?? [])
    .filter((c) => c.volumeId === VOLUME_ID)
    .map((ch) => {
      const idx = chapterIndex(ch.title)
      const journal = journals.find(
        (d) => d.metadata?.chapterId === ch.id && d.metadata?.autoAcceptancePassed,
      )
      return {
        index: idx,
        title: ch.title,
        wordLen: plainLen(ch.content),
        accepted: Boolean(journal),
        id: ch.id,
      }
    })
    .filter((c) => c.index != null && c.index <= 3)
    .sort((a, b) => a.index - b.index)

  const calls = await extractCalls()
  const chaptersAi = []
  let current = { chapter: 0, steps: [] }
  for (const c of calls) {
    if (c.task === 'chapter-memo' && current.steps.length > 0) {
      chaptersAi.push(current)
      current = { chapter: chaptersAi.length + 1, steps: [] }
    }
    if (c.task === 'chapter-memo' && current.steps.length === 0) {
      current.chapter = chaptersAi.length + 1
    }
    const step = TASK_LABEL[c.task] || c.task
    current.steps.push(`${step}→${c.model}`)
  }
  if (current.steps.length) chaptersAi.push(current)

  const auditRounds = (steps) => steps.filter((s) => s.startsWith('审计')).length

  console.log(JSON.stringify({
    runId: RUN_ID,
    status: run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    completed: run.completedChapterIds?.length ?? 0,
    skipped: run.skippedChapterIds?.length ?? 0,
    chapters,
    aiChapters: chaptersAi.map((ch) => ({
      chapter: ch.chapter,
      auditRounds: auditRounds(ch.steps),
      repairRounds: ch.steps.filter((s) => s.startsWith('修复')).length,
      pipeline: ch.steps,
    })),
  }, null, 2))
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
