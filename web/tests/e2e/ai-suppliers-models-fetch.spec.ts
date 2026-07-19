import { test, expect } from '@playwright/test'

const E2E_API_BASE = process.env.E2E_API_BASE ?? 'http://localhost:8010'
const TEST_KEY = process.env.E2E_DEEPSEEK_API_KEY || 'sk-e2e-test-key'

const SUPPLIERS = [
  {
    id: 'profile-ui-draft',
    name: 'UI初稿',
    provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    role: 'draft' as const,
    testId: 'prod-draft',
  },
  {
    id: 'profile-ui-centos',
    name: 'UI润色',
    provider: 'openai-compatible',
    baseUrl: process.env.E2E_CENTOS_BASE_URL ?? 'https://ai.centos.hk',
    model: 'gemini-3.5-flash',
    role: 'repair' as const,
    testId: 'prod-repair',
  },
  {
    id: 'profile-ui-cpa',
    name: 'UI审查',
    provider: 'openai-compatible',
    baseUrl: process.env.E2E_CPA_BASE_URL ?? 'http://124.222.218.97/cpa/v1',
    model: 'grok-composer-2.5-fast',
    role: 'audit' as const,
    testId: 'prod-audit',
  },
]

test.describe('三供应商模型拉取 Base URL', () => {
  test.beforeEach(async ({ page, request }) => {
    await page.goto('login')
    await page.evaluate(() => localStorage.clear())

    const login = await request.post(`${E2E_API_BASE}/api/character-arc/v1/auth/login`, {
      data: { email: 'admin@characterarc.local', password: '123456' },
    })
    const { accessToken } = await login.json()

    await request.put(`${E2E_API_BASE}/api/character-arc/v1/users/me/ai-config`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      data: {
        provider: SUPPLIERS[0].provider,
        model: SUPPLIERS[0].model,
        baseUrl: SUPPLIERS[0].baseUrl,
        apiKey: TEST_KEY,
        activeAiProfileId: SUPPLIERS[0].id,
        aiProfiles: SUPPLIERS.map((s) => ({
          id: s.id,
          name: s.name,
          provider: s.provider,
          model: s.model,
          baseUrl: s.baseUrl,
          apiKey: TEST_KEY,
        })),
        chapterProductionModels: {
          draftProfileId: SUPPLIERS[0].id,
          draftModel: SUPPLIERS[0].model,
          repairProfileId: SUPPLIERS[1].id,
          repairModel: SUPPLIERS[1].model,
          auditProfileId: SUPPLIERS[2].id,
          auditModel: SUPPLIERS[2].model,
        },
      },
    })

    await page.getByTestId('login-email').fill('admin@characterarc.local')
    await page.getByTestId('login-password').fill('123456')
    await page.getByTestId('login-submit').click()
    await expect(page.getByTestId('home-welcome')).toBeVisible({ timeout: 15_000 })
  })

  test('每个流水线阶段拉取时 POST 的 baseUrl 与绑定供应商一致', async ({ page }) => {
    const captured: Array<{ role: string; body: Record<string, unknown>; responseMeta?: { baseUrl?: string } }> = []

    await page.route('**/users/me/ai-config/models', async (route) => {
      const body = route.request().postDataJSON() as Record<string, unknown>
      const supplier = SUPPLIERS.find((s) => s.id === body.profileId)
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          result: [{ id: supplier?.model ?? 'mock-model', ownedBy: null }],
          meta: {
            baseUrl: body.baseUrl ?? supplier?.baseUrl,
            provider: body.provider ?? supplier?.provider,
            profileId: body.profileId,
          },
        }),
      })
      captured.push({ role: String(body.profileId), body, responseMeta: { baseUrl: String(body.baseUrl ?? supplier?.baseUrl) } })
    })

    for (const supplier of SUPPLIERS) {
      const fetchBtn = page.getByTestId(`${supplier.testId}-model-fetch`)
      await expect(fetchBtn).toBeEnabled()
      await fetchBtn.click()
      await expect(page.getByTestId(`${supplier.testId}-model`)).toBeVisible({ timeout: 10_000 })
    }

    expect(captured).toHaveLength(3)

    for (const supplier of SUPPLIERS) {
      const hit = captured.find((c) => String(c.body.baseUrl) === supplier.baseUrl)
      expect(hit, `missing fetch for ${supplier.name} (${supplier.baseUrl})`).toBeTruthy()
      expect(String(hit!.body.provider)).toBe(supplier.provider)
      expect(hit!.body.profileId).toBe(supplier.id)
    }
  })

  test('服务端 meta.baseUrl 与供应商配置一致', async ({ request }) => {
    const login = await request.post(`${E2E_API_BASE}/api/character-arc/v1/auth/login`, {
      data: { email: 'admin@characterarc.local', password: '123456' },
    })
    const { accessToken } = await login.json()

    for (const supplier of SUPPLIERS) {
      const res = await request.post(`${E2E_API_BASE}/api/character-arc/v1/users/me/ai-config/models`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        data: {
          profileId: supplier.id,
          provider: supplier.provider,
          baseUrl: supplier.baseUrl,
        },
      })
      const data = await res.json()
      expect(data.meta?.baseUrl, `${supplier.name} meta.baseUrl`).toBe(supplier.baseUrl)
      expect(data.meta?.profileId, `${supplier.name} meta.profileId`).toBe(supplier.id)
    }
  })
})
