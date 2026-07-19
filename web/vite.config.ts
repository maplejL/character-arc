import { existsSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Plugin } from 'vite'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..')
const sharedRoot = resolve(repoRoot, 'electron/shared')

/** electron/shared 旁路有 CJS .js；Web 打包优先用同名 .ts 源 */
function preferSharedTypeScript(): Plugin {
  return {
    name: 'prefer-shared-typescript',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!importer || !source.endsWith('.js')) return null
      const base = isAbsolute(source) ? source : resolve(dirname(importer), source)
      if (!base.startsWith(sharedRoot) && !importer.startsWith(sharedRoot)) return null
      const tsPath = base.replace(/\.js$/i, '.ts')
      if (existsSync(tsPath)) return tsPath
      return null
    },
  }
}

export default defineConfig({
  plugins: [preferSharedTypeScript(), vue()],
  base: '/character-arc/',
  resolve: {
    alias: {
      '@': resolve(repoRoot, 'renderer/src'),
      '@shared': resolve(repoRoot, 'electron/shared'),
    },
    // Prefer TypeScript sources over sibling CJS .js (electron/shared emits both)
    extensions: ['.mjs', '.mts', '.ts', '.tsx', '.jsx', '.js', '.json', '.vue'],
    dedupe: ['vue', 'pinia'],
  },
  server: {
    port: 5174,
    fs: {
      allow: [repoRoot],
    },
    proxy: {
      '/api/character-arc': {
        target: process.env.VITE_API_PROXY ?? 'http://localhost:8010',
        changeOrigin: true,
      },
    },
  },
})
