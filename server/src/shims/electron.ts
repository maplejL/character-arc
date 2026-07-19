import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(fileURLToPath(new URL('../../..', import.meta.url)))

export const electronShim = {
  app: {
    getPath(name: string): string {
      if (name === 'userData') {
        return process.env.CHARACTERARC_USER_DATA || join(repoRoot, 'data', 'server-runtime')
      }
      if (name === 'appData') {
        return process.env.APPDATA || join(repoRoot, 'data', 'server-runtime')
      }
      return process.env.CHARACTERARC_USER_DATA || join(repoRoot, 'data', 'server-runtime')
    },
    getAppPath(): string {
      return process.env.CHARACTERARC_APP_ROOT || repoRoot
    },
    getVersion(): string {
      return process.env.CHARACTERARC_APP_VERSION || '1.13.0-web'
    },
  },
  BrowserWindow: class BrowserWindow {},
  ipcMain: { handle() {}, on() {} },
}
