#!/usr/bin/env node
import { config as loadEnv } from 'dotenv'
import { resolve } from 'node:path'

loadEnv({ path: resolve(process.cwd(), '.env') })

async function main() {
  const { initDb, query } = await import('../src/db/pool.js')
  const { prepareServerAiTask } = await import('../src/ai/prepare-ai-task.js')
  await initDb()
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM users WHERE email = 'admin@characterarc.local'`,
  )
  const userId = rows[0].id
  const first = await prepareServerAiTask(userId, { task: 'chapter-audit', context: {} }, {})
  console.log('prepare meta', {
    chapterProductionModels: first.chapterProductionModels,
    aiProfiles: first.aiProfiles.map((p) => ({ id: p.id, provider: p.provider, model: p.model, hasKey: Boolean(p.apiKey) })),
    activeAiProfileId: first.activeAiProfileId,
  })
  for (const task of ['chapter-memo', 'chapter-quality-review', 'chapter-audit', 'chapter-repair']) {
    const prepared = task === 'chapter-audit' ? first : await prepareServerAiTask(
      userId,
      {
        task,
        context: {
          autoCreationRunId: 'diag',
          chapterTitle: 'test',
        },
      },
      {},
    )
    const s = prepared.taskPayload.settings as Record<string, unknown>
    console.log(task, {
      modelRole: s.modelRole,
      provider: s.provider,
      model: s.model,
      baseUrl: s.baseUrl,
      hasKey: Boolean(String(s.apiKey ?? '').trim()),
    })
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
