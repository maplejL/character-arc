#!/usr/bin/env node
/**
 * Compile electron/main/ai TypeScript to sibling .js for production server.
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const tsconfig = join(here, 'tsconfig.electron-emit.json')

const result = spawnSync(
  process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
  ['exec', 'tsc', '-p', tsconfig],
  { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' },
)

if (result.status !== 0) {
  process.exit(result.status ?? 1)
}

console.log('electron/main/ai emit OK')
