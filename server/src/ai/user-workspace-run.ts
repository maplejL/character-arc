import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { config } from '../config.js'
import { readUserWorkspace, writeUserWorkspace, type WorkspacePayload } from '../workspace/json-store.js'
import { registerElectronMock } from './register-electron-mock.js'

export type UserWorkspaceRunContext = {
  userId: string
  db: DatabaseSync
  snapshot: import('../../../electron/main/workspace-types.js').WorkspacePayload
  persist: () => Promise<void>
}

export function userDataRoot(userId: string): string {
  return join(config.dataRoot, 'users', userId)
}

function toElectronWorkspace(payload: WorkspacePayload): import('../../../electron/main/workspace-types.js').WorkspacePayload {
  return payload as unknown as import('../../../electron/main/workspace-types.js').WorkspacePayload
}

export async function runWithUserWorkspace<T>(
  userId: string,
  fn: (ctx: UserWorkspaceRunContext) => Promise<T>,
  options?: { persist?: boolean },
): Promise<T> {
  registerElectronMock()
  const prevUserData = process.env.CHARACTERARC_USER_DATA
  process.env.CHARACTERARC_USER_DATA = userDataRoot(userId)

  const jsonSnapshot = await readUserWorkspace(userId)
  const { createMemoryWorkspaceDb, runWithWorkspaceDb, readWorkspaceSnapshot } = await import(
    '../../../electron/main/workspace-store.js'
  )
  const { resetAssistantRuntimeState } = await import('../../../electron/main/ai/runtime-v2/state.js')

  resetAssistantRuntimeState()
  const db = await createMemoryWorkspaceDb(toElectronWorkspace(jsonSnapshot), { keepOpen: true })

  const ctx: UserWorkspaceRunContext = {
    userId,
    db,
    snapshot: toElectronWorkspace(jsonSnapshot),
    persist: async () => {
      if (options?.persist === false) return
      const next = readWorkspaceSnapshot(db)
      if (!next) return
      await writeUserWorkspace(userId, next as unknown as WorkspacePayload)
    },
  }

  try {
    const result = await runWithWorkspaceDb(db, () => fn(ctx))
    if (options?.persist !== false) {
      await ctx.persist()
    }
    return result
  } finally {
    try {
      db.close()
    } catch {
      /* ignore */
    }
    resetAssistantRuntimeState()
    if (prevUserData === undefined) delete process.env.CHARACTERARC_USER_DATA
    else process.env.CHARACTERARC_USER_DATA = prevUserData
  }
}
