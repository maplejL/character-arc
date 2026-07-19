import { test, expect } from '@playwright/test'

const E2E_API_BASE = 'http://localhost:8010'

const INVITE = process.env.E2E_INVITE_CODE ?? 'CHARARC-BETA'
const API_KEY = process.env.E2E_DEEPSEEK_API_KEY ?? ''
const BASE_URL = process.env.E2E_DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com'
const MODEL = process.env.E2E_DEEPSEEK_MODEL ?? 'deepseek-chat'

test.describe.configure({ mode: 'serial' })

test.describe('P0 验收', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('login')
    await page.evaluate(() => localStorage.clear())
  })
  test('无邀请码不能注册', async ({ page }) => {
    await page.goto('register')
    await expect(page.getByTestId('register-invite')).toBeVisible({ timeout: 30_000 })
    await page.getByTestId('register-invite').fill('INVALID-CODE')
    await page.getByTestId('register-email').fill(`no-invite-${Date.now()}@test.local`)
    await page.getByTestId('register-password').fill('TestPass123!')
    await page.getByTestId('register-submit').click()
    await expect(page.getByTestId('register-error')).toBeVisible({ timeout: 10_000 })
  })

  test('邀请注册 → 登录 → BYOK → DeepSeek 测试连接', async ({ page, request }) => {
    test.skip(!API_KEY, 'E2E_DEEPSEEK_API_KEY 未配置')

    const email = `e2e-${Date.now()}@test.local`
    const password = 'TestPass123!'

    await page.goto('register')
    await expect(page.getByTestId('register-invite')).toBeVisible({ timeout: 30_000 })
    await page.getByTestId('register-invite').fill(INVITE)
    await page.getByTestId('register-email').fill(email)
    await page.getByTestId('register-password').fill(password)
    await Promise.all([
      page.waitForURL(/\/character-arc\/?$/),
      page.waitForResponse((r) => r.url().includes('/auth/register') && r.status() === 200),
      page.getByTestId('register-submit').click(),
    ])
    await expect(page.getByTestId('home-welcome')).toBeVisible({ timeout: 15_000 })

    // BYOK 响应不含明文 key
    const token = await page.evaluate(() => localStorage.getItem('ca_access_token'))
    expect(token).toBeTruthy()
    const cfgBefore = await request.get(`${E2E_API_BASE}/api/character-arc/v1/users/me/ai-config`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(cfgBefore.ok()).toBeTruthy()
    const cfgJson = await cfgBefore.json()
    expect(cfgJson).not.toHaveProperty('apiKey')
    expect(cfgJson.hasApiKey).toBe(false)

    await page.getByTestId('ai-provider').selectOption('deepseek')
    await page.getByTestId('ai-model').fill(MODEL)
    await page.getByTestId('ai-base-url').fill(BASE_URL)
    await page.getByTestId('ai-api-key').fill(API_KEY)
    await page.getByTestId('ai-save').click()

    const cfgAfter = await request.get(`${E2E_API_BASE}/api/character-arc/v1/users/me/ai-config`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    const saved = await cfgAfter.json()
    expect(saved.hasApiKey).toBe(true)
    expect(saved).not.toHaveProperty('apiKey')

    await page.getByTestId('ai-test').click()
    await expect(page.getByTestId('ai-test-result')).toContainText(/连接成功|OK/i, { timeout: 60_000 })

    // 工作区：创建作品
    await page.getByTestId('project-title').fill('E2E 测试书')
    await page.getByTestId('project-genre').fill('科幻')
    await page.getByTestId('project-create').click()
    await expect(page.getByTestId('project-list')).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId('project-item').filter({ hasText: 'E2E 测试书' })).toBeVisible()

    // 401 格式
    const unauth = await request.get(`${E2E_API_BASE}/api/character-arc/v1/auth/me`)
    expect(unauth.status()).toBe(401)
    const errBody = await unauth.json()
    expect(errBody.code).toBeTruthy()
    expect(errBody.message).toBeTruthy()
  })

  test('Admin 登录可生成邀请码', async ({ page }) => {
    await page.goto('login')
    await page.getByTestId('login-email').fill('admin@characterarc.local')
    await page.getByTestId('login-password').fill('123456')
    await page.getByTestId('login-submit').click()
    await expect(page.getByTestId('home-welcome')).toBeVisible()
    await page.getByTestId('admin-gen-invite').click()
    await expect(page.getByTestId('admin-invite-code')).toBeVisible()
  })
})
