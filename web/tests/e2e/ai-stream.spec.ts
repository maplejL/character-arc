import { test, expect } from '@playwright/test'
import { E2E_API_BASE } from '../../playwright.config'

const OPENCODE_KEY = process.env.E2E_OPENCODE_API_KEY ?? ''
const DEEPSEEK_KEY = process.env.E2E_DEEPSEEK_API_KEY ?? ''
const API_KEY = OPENCODE_KEY || DEEPSEEK_KEY
const USE_OPENCODE = Boolean(OPENCODE_KEY)

test.describe('AI SSE 流式（web-ai-sse-streaming）', () => {
  test('stream/start + SSE events 完成 chapter-first-draft', async ({ page, request }) => {
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

    const title = `Stream UI ${Date.now()}`
    await page.getByTestId('project-title').fill(title)
    await page.getByTestId('project-create').click()
    await expect(page.getByTestId('project-item').filter({ hasText: title })).toBeVisible()

    const projects = await request.get(`${E2E_API_BASE}/api/character-arc/v1/projects`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    const project = ((await projects.json()) as Array<{ id: string; title: string }>).find((p) => p.title === title)
    expect(project?.id).toBeTruthy()

    const start = await request.post(`${E2E_API_BASE}/api/character-arc/v1/ai/stream/start`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: {
        task: 'chapter-first-draft',
        context: {
          projectId: project!.id,
          projectTitle: title,
          projectGenre: '科幻',
          chapterTitle: '第一章 测试',
          chapterIndex: 1,
          chapterSummary: '主角在测试场景里完成一次 SSE 流式初稿生成。',
          chapterWordTarget: '600',
          targetWordCount: '600',
        },
        clientKey: 'chapter-first-draft',
      },
    })
    const started = (await start.json()) as { result?: { streamId?: string } }
    expect(started.result?.streamId).toBeTruthy()

    const streamRes = await request.get(
      `${E2E_API_BASE}/api/character-arc/v1/ai/stream/${started.result!.streamId}/events`,
      { headers: { Authorization: `Bearer ${token}` } },
    )
    expect(streamRes.ok()).toBeTruthy()
    const body = await streamRes.text()
    expect(body).toMatch(/"type":"(done|chunk)"/)
    expect(body.length).toBeGreaterThan(50)
  })
})
