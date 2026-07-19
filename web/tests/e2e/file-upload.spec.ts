import { test, expect } from '@playwright/test'
import { E2E_API_BASE } from '../../playwright.config'

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

test.describe('文件上传（web-file-uploads）', () => {
  test('API 上传封面并下载', async ({ page, request }) => {
    await page.goto('login')
    await page.evaluate(() => localStorage.clear())
    await page.getByTestId('login-email').fill('admin@characterarc.local')
    await page.getByTestId('login-password').fill('123456')
    await page.getByTestId('login-submit').click()
    await expect(page.getByTestId('home-welcome')).toBeVisible({ timeout: 15_000 })

    const token = await page.evaluate(() => localStorage.getItem('ca_access_token'))
    expect(token).toBeTruthy()

    const title = `Upload ${Date.now()}`
    await page.getByTestId('project-title').fill(title)
    await page.getByTestId('project-create').click()
    await expect(page.getByTestId('project-item').filter({ hasText: title })).toBeVisible()

    const projects = await request.get(`${E2E_API_BASE}/api/character-arc/v1/projects`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    const project = ((await projects.json()) as Array<{ id: string; title: string }>).find((p) => p.title === title)
    expect(project?.id).toBeTruthy()

    const form = new FormData()
    form.append('purpose', 'cover')
    form.append('file', new Blob([PNG_1X1], { type: 'image/png' }), 'e2e-cover.png')

    const upload = await request.post(
      `${E2E_API_BASE}/api/character-arc/v1/projects/${project!.id}/files/upload`,
      {
        headers: { Authorization: `Bearer ${token}` },
        multipart: {
          purpose: 'cover',
          file: {
            name: 'e2e-cover.png',
            mimeType: 'image/png',
            buffer: PNG_1X1,
          },
        },
      },
    )
    expect(upload.ok()).toBeTruthy()
    const uploaded = (await upload.json()) as { fileId?: string; url?: string }
    expect(uploaded.fileId).toBeTruthy()

    const fileRes = await request.get(`${E2E_API_BASE}${uploaded.url}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(fileRes.ok()).toBeTruthy()
    expect((await fileRes.body()).length).toBe(PNG_1X1.length)
  })
})
