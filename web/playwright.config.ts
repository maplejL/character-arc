import { defineConfig, devices } from '@playwright/test'
import dotenv from 'dotenv'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.resolve(__dirname, '.env.e2e') })

export const E2E_API_PORT = 8010
export const WEB_PORT = 5174
export const E2E_API_BASE = `http://localhost:${E2E_API_PORT}`

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 120_000,
  expect: { timeout: 30_000 },
  retries: 0,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: `http://localhost:${WEB_PORT}/character-arc/`,
    headless: true,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [{
    name: 'chromium',
    use: {
      ...devices['Desktop Chrome'],
      channel: 'msedge',
    },
  }],
  webServer: [
    {
      command: 'npx tsx src/index.ts',
      cwd: path.resolve(__dirname, '../server'),
      url: `${E2E_API_BASE}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: {
        USE_PGLITE: '1',
        PORT: String(E2E_API_PORT),
        PGLITE_DIR: path.resolve(__dirname, '../server/data/pglite-e2e'),
        JWT_SECRET: 'e2e-jwt-secret-min-32-characters-long!!',
        ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
        CORS_ORIGINS: `http://localhost:${WEB_PORT}`,
        DEEPSEEK_BASE_URL: 'https://api.deepseek.com',
        SEED_INVITE_CODE: process.env.E2E_INVITE_CODE ?? 'CHARARC-BETA',
        CHARACTERARC_APP_ROOT: path.resolve(__dirname, '..'),
      },
    },
    {
      command: 'pnpm dev',
      cwd: path.resolve(__dirname),
      url: `http://localhost:${WEB_PORT}/character-arc/login`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: {
        VITE_API_PROXY: E2E_API_BASE,
      },
    },
  ],
})
