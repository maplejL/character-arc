import Module from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const electronMockPath = join(__dirname, 'electron-mock.mjs')
const originalResolveFilename = Module._resolveFilename

Module._resolveFilename = function (request, parent, isMain, options) {
  if (request === 'electron') {
    return electronMockPath
  }
  return originalResolveFilename.call(this, request, parent, isMain, options)
}

await import(pathToFileURL(join(__dirname, 'auto-creation-e2e.ts')).href)
