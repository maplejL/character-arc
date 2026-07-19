import { test, expect } from '@playwright/test'
import { E2E_API_BASE } from '../../playwright.config'

const OPENCODE_KEY = process.env.E2E_OPENCODE_API_KEY ?? ''
const DEEPSEEK_KEY = process.env.E2E_DEEPSEEK_API_KEY ?? ''
const API_KEY = OPENCODE_KEY || DEEPSEEK_KEY
const USE_OPENCODE = Boolean(OPENCODE_KEY)

test.describe('AI 管线（web-ai-pipeline-port）', () => {
  test('API 非流式 generate + 写作台 UI 触发', async ({ page, request }) => {
    test.skip(!API_KEY, 'E2E_OPENCODE_API_KEY / E2E_DEEPSEEK_API_KEY 未配置')
    test.setTimeout(180_000)

    await page.goto('login')
    await page.evaluate(() => localStorage.clear())
    await page.getByTestId('login-email').fill('admin@characterarc.local')
    await page.getByTestId('login-password').fill('123456')
    await page.getByTestId('login-submit').click()
    await expect(page.getByTestId('home-welcome')).toBeVisible({ timeout: 15_000 })

    if (USE_OPENCODE) {
      await page.getByTestId('ai-preset-opencode').click()
    } else {
      await page.getByTestId('ai-preset-deepseek').click()
    }
    await page.getByTestId('ai-api-key').fill(API_KEY)
    await page.getByTestId('ai-save').click()

    const token = await page.evaluate(() => localStorage.getItem('ca_access_token'))
    expect(token).toBeTruthy()

    const title = `AI Studio ${Date.now()}`
    await page.getByTestId('project-title').fill(title)
    await page.getByTestId('project-genre').fill('科幻')
    await page.getByTestId('project-create').click()
    await expect(page.getByTestId('project-item').filter({ hasText: title })).toBeVisible({ timeout: 15_000 })

    const projects = await request.get(`${E2E_API_BASE}/api/character-arc/v1/projects`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    const projectList = (await projects.json()) as Array<{ id: string; title: string }>
    const project = projectList.find((p) => p.title === title)
    expect(project?.id).toBeTruthy()

    const apiGen = await request.post(`${E2E_API_BASE}/api/character-arc/v1/ai/generate`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: {
        task: 'worldview-entry',
        context: {
          projectId: project!.id,
          projectTitle: title,
          projectGenre: '科幻',
          worldviewTitles: [],
        },
        clientKey: 'worldview-entry',
        clientTaskId: `e2e-api-${Date.now()}`,
      },
    })
    expect(apiGen.ok()).toBeTruthy()
    const apiBody = (await apiGen.json()) as { result?: { title?: string; content?: string } }
    expect(apiBody.result?.title?.trim()).toBeTruthy()
    expect(apiBody.result?.content?.trim()).toBeTruthy()

    await page.getByTestId('project-item').filter({ hasText: title }).getByTestId('project-open').click()
    await expect(page.getByTestId('workbench-page')).toBeVisible({ timeout: 30_000 })
    await page.getByRole('button', { name: '世界观设定' }).click()

    const aiButton = page.getByRole('button', { name: 'AI 扩写' })
    await expect(aiButton).toBeVisible({ timeout: 15_000 })
    await aiButton.click()
    await expect(page.getByText('AI 已生成新的世界观词条草稿')).toBeVisible({ timeout: 120_000 })
  })
})
