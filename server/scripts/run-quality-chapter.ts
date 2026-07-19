/**
 * Run quality-only pipeline for a single chapter (production ops).
 * Usage: npx tsx scripts/run-quality-chapter.ts <chapterId>
 */
import { config as loadEnv } from 'dotenv'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeDb, initDb } from '../src/db/pool.js'
import { runServerChapterProductionPipeline } from '../src/auto-creation/chapter-pipeline.js'
import { syncOutlineItemStatus } from '../src/auto-creation/shared/index.js'
import { readUserWorkspace, writeUserWorkspace } from '../src/workspace/json-store.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
loadEnv({ path: resolve(__dirname, '../.env') })

const USER_ID = '8227fcf2-5d5e-468f-8870-31d8ca52814c'
const PROJECT_ID = 'project-1783149829898'
const CHAPTER_ID = process.argv[2] || 'chapter-1783302315874-5dfe3fc2'

const CONFIG = {
  userPrompt: [
    '第3章定向修复（quality-only，保留主线）：',
    '1. 章首承接上章：明确时间推移，提及上章推演/数据接续',
    '2. 必须兑现 payoffs：陆行之不可能题、陈熵越界推导路径、沈镜首次旁观记录、章末推导痕迹被项目组截取（尚未实名）',
    '3. 削减比喻与光影/沉默模板意象；章末落具体动作或信息，禁止旁白升华',
    '4. 字数控制在 4500–5500 字',
  ].join('\n'),
  enabledSkillIds: [] as string[],
  maxRepairRounds: 10,
  forcedWordCountMax: 5500,
  forcedWordCountMin: 4500,
  maxAuditRepairRounds: 10,
  maxFinalGateRounds: 10,
  qualityReviewMaxWarnings: 5,
  selectedReferenceWorkIds: [] as string[],
}

async function main(): Promise<void> {
  let workspace = await readUserWorkspace(USER_ID)
  workspace = {
    ...workspace,
    knowledgeDocuments: workspace.knowledgeDocuments.map((doc) => {
      if (doc.sourceLabel !== 'writing-journal') return doc
      const meta = { ...(doc.metadata ?? {}) }
      if (String(meta.chapterId ?? '') === CHAPTER_ID && meta.autoAcceptancePassed) {
        return { ...doc, metadata: { ...meta, autoAcceptancePassed: false } }
      }
      return doc
    }),
  }
  await writeUserWorkspace(USER_ID, workspace)
  workspace = await readUserWorkspace(USER_ID)

  const ws = workspace.workspaces[PROJECT_ID]
  if (!ws) throw new Error(`workspace missing: ${PROJECT_ID}`)
  const chapters = Array.isArray(ws.chapters) ? ws.chapters : []
  const chapter = chapters.find((item) => item.id === CHAPTER_ID)
  if (!chapter) throw new Error(`chapter missing: ${CHAPTER_ID}`)

  console.log(`[run-quality-chapter] ${chapter.title ?? CHAPTER_ID}`)

  const result = await runServerChapterProductionPipeline({
    userId: USER_ID,
    workspace,
    projectId: PROJECT_ID,
    chapterId: CHAPTER_ID,
    config: CONFIG,
    mode: 'quality-only',
    signal: new AbortController().signal,
    onProgress: (progress) => console.log(`[${progress.step}] ${progress.label}`),
  })

  // Re-read latest workspace before persist (avoid stale overwrite)
  let latest = await readUserWorkspace(USER_ID)
  const latestWs = latest.workspaces[PROJECT_ID]
  if (!latestWs) throw new Error(`workspace missing after pipeline: ${PROJECT_ID}`)
  const latestChapters = Array.isArray(latestWs.chapters) ? latestWs.chapters : []
  const latestChapter = latestChapters.find((item) => item.id === CHAPTER_ID)
  if (!latestChapter) throw new Error(`chapter missing after pipeline: ${CHAPTER_ID}`)

  latestChapter.content = result.finalContent ?? latestChapter.content
  latestChapter.status = 'review'
  const knowledgeDocuments = [...latest.knowledgeDocuments]
  if (result.knowledgeDocuments?.length) {
    knowledgeDocuments.push(...result.knowledgeDocuments)
  }
  const outlineItems = Array.isArray(latestWs.outlineItems) ? latestWs.outlineItems : []
  const outlineItem = latestChapter.outlineItemId
    ? outlineItems.find((item) => item.id === latestChapter.outlineItemId)
    : undefined
  if (outlineItem) {
    outlineItem.status = syncOutlineItemStatus(outlineItem, latestChapters, knowledgeDocuments)
  }
  latest = {
    ...latest,
    workspaces: {
      ...latest.workspaces,
      [PROJECT_ID]: { ...latestWs, chapters: latestChapters, outlineItems },
    },
    knowledgeDocuments,
  }
  await writeUserWorkspace(USER_ID, latest)

  console.log(
    JSON.stringify(
      {
        ok: result.ok,
        acceptanceRecorded: result.acceptanceRecorded,
        finalGatePass: result.finalGatePass,
        auditPass: result.auditPass,
        error: result.error,
      },
      null,
      2,
    ),
  )
  if (!result.ok || !result.acceptanceRecorded) process.exit(1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

async function run(): Promise<void> {
  await initDb()
  try {
    await main()
  } finally {
    await closeDb()
  }
}

void run()
