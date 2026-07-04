/**
 * Export a CharacterArc project from local workspace.db to a .carc archive.
 *
 * Usage:
 *   pnpm run export:project -- --project-id <id> --output <path.carc>
 *   pnpm run export:project -- --list
 *
 * Env:
 *   CHARACTERARC_USER_DATA  override userData dir (default: %APPDATA%/CharacterArc)
 */

import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'

import { exportProjectArchive, getProjectArchiveDefaultName } from '../electron/main/archive/project-archive'
import { initAssistantRuntimeSchema } from '../electron/main/ai/runtime-v2/conversation-manager'
import { readWorkspaceSnapshot } from '../electron/main/workspace-store'

function resolveDefaultDbPath(): string {
  const userData =
    process.env.CHARACTERARC_USER_DATA ||
    join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'CharacterArc')
  return join(userData, 'data', 'workspace.db')
}

function parseArgs(argv: string[]) {
  let projectId = ''
  let output = ''
  let list = false
  let dbPath = resolveDefaultDbPath()

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--list') list = true
    else if (arg === '--project-id') projectId = argv[++index] ?? ''
    else if (arg === '--output') output = argv[++index] ?? ''
    else if (arg === '--db') dbPath = argv[++index] ?? dbPath
    else if (arg === '--help' || arg === '-h') {
      console.log(`Usage:
  pnpm run export:project -- --list
  pnpm run export:project -- --project-id <id> [--output <path.carc>] [--db <workspace.db>]`)
      process.exit(0)
    }
  }

  return { projectId, output, list, dbPath }
}

async function main(): Promise<void> {
  const { projectId, output, list, dbPath } = parseArgs(process.argv.slice(2))

  if (!existsSync(dbPath)) {
    throw new Error(`workspace.db not found: ${dbPath}`)
  }

  const db = new DatabaseSync(dbPath)
  initAssistantRuntimeSchema(db)
  const snapshot = readWorkspaceSnapshot(db)

  if (!snapshot || snapshot.projects.length === 0) {
    throw new Error('No projects found in workspace.db')
  }

  if (list) {
    for (const project of snapshot.projects) {
      const workspace = snapshot.workspaces[project.id]
      const chapters = workspace?.chapters.length ?? 0
      console.log(`${project.id}\t${project.title}\tchapters=${chapters}`)
    }
    return
  }

  const target =
    snapshot.projects.find((project) => project.id === projectId) ??
  (projectId ? null : snapshot.projects[0])

  if (!target) {
    throw new Error(
      projectId
        ? `Project not found: ${projectId}`
        : 'Specify --project-id or ensure at least one project exists'
    )
  }

  const filePath = output || join(process.cwd(), getProjectArchiveDefaultName(target.title))
  mkdirSync(dirname(filePath), { recursive: true })

  await exportProjectArchive({
    db,
    filePath,
    projectId: target.id,
    readWorkspaceSnapshot
  })

  console.log(`Exported: ${filePath}`)
  console.log(`Project: ${target.title} (${target.id})`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
