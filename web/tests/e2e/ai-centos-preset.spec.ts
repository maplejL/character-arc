import { test, expect } from '@playwright/test'

const E2E_API_BASE = 'http://localhost:8010'
const CENTOS_KEY = process.env.E2E_CENTOS_API_KEY ?? ''

test.describe('CentOS OpenAI 兼容预设', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('login')
    await page.evaluate(() => localStorage.clear())
  })

  test('预设填充并保存 openai-compatible + CentOS 网关', async ({ page, request }) => {
    await page.getByTestId('login-email').fill('admin@characterarc.local')
    await page.getByTestId('login-password').fill('123456')
    await page.getByTestId('login-submit').click()
    await expect(page.getByTestId('home-welcome')).toBeVisible({ timeout: 15_000 })

    await page.getByTestId('ai-preset-centos').click()
    await expect(page.getByTestId('ai-provider')).toHaveValue('openai-compatible')
    await expect(page.getByTestId('ai-model')).toHaveValue('deepseek-v4-flash')
    await expect(page.getByTestId('ai-base-url')).toHaveValue('https://ai.centos.hk')

    if (CENTOS_KEY) {
      await page.getByTestId('ai-api-key').fill(CENTOS_KEY)
    }
    await page.getByTestId('ai-save').click()
    await expect(page.getByTestId('ai-save')).toBeEnabled({ timeout: 10_000 })

    const token = await page.evaluate(() => localStorage.getItem('ca_access_token'))
    expect(token).toBeTruthy()

    const cfg = await request.get(`${E2E_API_BASE}/api/character-arc/v1/users/me/ai-config`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    const saved = await cfg.json()
    expect(saved.provider).toBe('openai-compatible')
    expect(saved.model).toBe('deepseek-v4-flash')
    expect(saved.baseUrl).toBe('https://ai.centos.hk')
  })

  test('CentOS 测试连接', async ({ page }) => {
    test.skip(!CENTOS_KEY, 'E2E_CENTOS_API_KEY 未配置')

    await page.getByTestId('login-email').fill('admin@characterarc.local')
    await page.getByTestId('login-password').fill('123456')
    await page.getByTestId('login-submit').click()
    await expect(page.getByTestId('home-welcome')).toBeVisible({ timeout: 15_000 })

    await page.getByTestId('ai-preset-centos').click()
    await page.getByTestId('ai-api-key').fill(CENTOS_KEY)
    await page.getByTestId('ai-save').click()
    await page.getByTestId('ai-test').click()
    await expect(page.getByTestId('ai-test-result')).toContainText(/连接成功|OK/i, { timeout: 90_000 })
  })
})
