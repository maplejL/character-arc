#!/usr/bin/env node
import { config as loadEnv } from 'dotenv'
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import {
  applyTaskModelSettings,
  convergenceModelsDiffer,
} from '../../electron/shared/ai/model-roles.js'

loadEnv({ path: resolve(process.cwd(), '.env') })

const TASKS = [
  'chapter-memo',
  'chapter-first-draft',
  'chapter-quality-review',
  'chapter-audit',
  'chapter-repair',
  'chapter-session-note',
] as const

async function main() {
  const { initDb, query } = await import('../src/db/pool.js')
  const { decryptSecret } = await import('../src/lib/crypto.js')
  const { resolveUserProductionAiContext } = await import('../src/services/ai-production-config.js')
  const { resolveUserAppSettings } = await import('../src/ai/settings.js')

  await initDb()
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM users WHERE email = 'admin@characterarc.local'`,
  )
  const userId = rows[0]?.id
  if (!userId) throw new Error('admin not found')

  const productionCtx = await resolveUserProductionAiContext(userId)
  const serverDefaults = await resolveUserAppSettings(userId)
  const ws = JSON.parse(
    readFileSync(`/opt/character-arc/data/users/${userId}/workspace.json`, 'utf8'),
  ) as { appSettings?: { chapterProductionModels?: unknown } }

  const mergedModels = {
    ...productionCtx.chapterProductionModels,
    ...(ws.appSettings?.chapterProductionModels ?? {}),
  }

  const base = {
    ...serverDefaults,
    embeddingModel: '',
    aiProfiles: productionCtx.aiProfiles,
    activeAiProfileId: productionCtx.activeAiProfileId,
    chapterProductionModels: mergedModels,
  }

  console.log(
    JSON.stringify(
      {
        dbProductionModels: productionCtx.chapterProductionModels,
        wsProductionModels: ws.appSettings?.chapterProductionModels ?? {},
        mergedProductionModels: mergedModels,
        convergenceModelsDiffer: convergenceModelsDiffer(base),
        useConvergenceSession: !convergenceModelsDiffer(base),
        routed: Object.fromEntries(
          TASKS.map((task) => {
            const r = applyTaskModelSettings(base, task)
            return [
              task,
              {
                modelRole: r.modelRole,
                provider: r.provider,
                model: r.model,
                baseUrl: r.baseUrl,
              },
            ]
          }),
        ),
      },
      null,
      2,
    ),
  )
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
