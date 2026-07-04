import { homedir } from 'node:os'
import { join } from 'node:path'

const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
const userData =
  process.env.CHARACTERARC_USER_DATA || join(appData, 'CharacterArc')

export const app = {
  getPath(name) {
    if (name === 'userData') return userData
    if (name === 'appData') return appData
    return userData
  },
  getVersion() {
    return process.env.CHARACTERARC_APP_VERSION || '1.13.0'
  }
}

export const BrowserWindow = class BrowserWindow {}
export const ipcMain = { handle() {}, on() {} }
