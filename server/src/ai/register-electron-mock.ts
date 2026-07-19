import { existsSync } from 'node:fs'
import Module from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { electronShim } from '../shims/electron.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const defaultRepoRoot = join(__dirname, '../../..')
const shimPath = join(__dirname, '../shims/electron.js')

let registered = false

function appRoot(): string {
  return process.env.CHARACTERARC_APP_ROOT || defaultRepoRoot
}

function resolveSharedModule(request: string): string | null {
  const prefix = '@shared/'
  if (!request.startsWith(prefix)) return null

  const rel = request.slice(prefix.length)
  const base = join(appRoot(), 'electron/shared', rel)
  for (const candidate of [`${base}.ts`, `${base}.js`, base]) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

function isBareSpecifier(request: string): boolean {
  return (
    !request.startsWith('.')
    && !request.startsWith('/')
    && !request.startsWith('node:')
    && !request.startsWith('@shared/')
  )
}

function isElectronParent(parent: NodeModule): boolean {
  const file = parent?.filename
  if (!file) return false
  return file.includes(join(appRoot(), 'electron'))
}

function resolveFromServerNodeModules(request: string): string {
  return join(appRoot(), 'server/node_modules', request)
}

export function registerElectronMock(): void {
  if (registered) return
  registered = true

  process.env.CHARACTERARC_APP_ROOT = appRoot()

  const originalResolve = Module._resolveFilename
  Module._resolveFilename = function patchedResolve(
    request: string,
    parent: NodeModule,
    isMain: boolean,
    options?: unknown,
  ) {
    if (request === 'electron') {
      return shimPath
    }
    const sharedModule = resolveSharedModule(request)
    if (sharedModule) {
      return sharedModule
    }
    try {
      return originalResolve.call(this, request, parent, isMain, options as never)
    } catch (error) {
      if (isBareSpecifier(request) && isElectronParent(parent)) {
        return originalResolve.call(
          this,
          resolveFromServerNodeModules(request),
          parent,
          isMain,
          options as never,
        )
      }
      throw error
    }
  }

  const require = Module.createRequire(import.meta.url)
  require.cache[shimPath] = {
    id: shimPath,
    filename: shimPath,
    loaded: true,
    exports: electronShim,
  } as NodeModule
}

export function repoRootPath(): string {
  return appRoot()
}

export async function importAiRuntime(): Promise<typeof import('../../../electron/main/ai/runtime/index.js')> {
  registerElectronMock()
  const runtimeDir = join(appRoot(), 'electron/main/ai/runtime')
  const tsEntry = join(runtimeDir, 'index.ts')
  const jsEntry = join(runtimeDir, 'index.js')
  const entry = existsSync(tsEntry) ? tsEntry : jsEntry
  return import(pathToFileURL(entry).href)
}
