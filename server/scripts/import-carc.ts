/**
 * Import a .carc archive into a user's workspace.json (CLI).
 *
 * Usage:
 *   pnpm --dir server exec tsx scripts/import-carc.ts --email admin@characterarc.local --file ../samples/projects/foo.carc
 */

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { runMigrations } from '../src/db/migrate.js'
import { seedDevData } from '../src/db/seed.js'
import { initDb, closeDb, query } from '../src/db/pool.js'
import { readUserWorkspace, writeUserWorkspace } from '../src/workspace/json-store.js'
import { importCarcAsNewProjectAsync } from '../src/workspace/carc-import.js'
import { upsertUserAppSettings } from '../src/services/user-app-settings.js'

function parseArgs(argv: string[]) {
  let email = ''
  let file = ''
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--email') email = argv[++i] ?? ''
    else if (arg === '--file') file = argv[++i] ?? ''
    else if (arg === '--help' || arg === '-h') {
      console.log(`Usage:
  pnpm --dir server exec tsx scripts/import-carc.ts --email <user@email> --file <path.carc>`)
      process.exit(0)
    }
  }
  return { email, file }
}

async function main(): Promise<void> {
  const { email, file } = parseArgs(process.argv.slice(2))
  if (!email || !file) {
    throw new Error('需要 --email 和 --file')
  }

  await runMigrations()
  await initDb()
  await seedDevData()

  const { rows } = await query<{ id: string; email: string }>(
    'SELECT id, email FROM users WHERE email = $1',
    [email],
  )
  const user = rows[0]
  if (!user) {
    throw new Error(`用户不存在: ${email}`)
  }

  const filePath = resolve(file)
  const buffer = await readFile(filePath)
  const workspace = await readUserWorkspace(user.id)
  const { workspace: next, projectId, preview } = await importCarcAsNewProjectAsync(workspace, buffer)

  await writeUserWorkspace(user.id, next)
  await upsertUserAppSettings(user.id, { selectedProjectId: projectId })

  const project = next.projects.find((p) => p.id === projectId)
  console.log(`Imported: ${project?.title ?? preview.projectTitle}`)
  console.log(`Project ID: ${projectId}`)
  console.log(`User: ${user.email} (${user.id})`)
  console.log(`Chapters: ${preview.modules.chapters?.count ?? '?'}`)
  console.log(`Characters: ${preview.modules.characters?.count ?? '?'}`)

  await closeDb()
}

main().catch(async (err) => {
  console.error(err)
  await closeDb()
  process.exit(1)
})
