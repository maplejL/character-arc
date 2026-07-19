import { test, expect } from '@playwright/test'

test.describe.configure({ mode: 'serial' })

test.describe('写作台（renderer 迁移）', () => {
  test('登录 → 创建作品 → 打开写作台', async ({ page }) => {
    await page.goto('login')
    await page.evaluate(() => localStorage.clear())

    await page.getByTestId('login-email').fill('admin@characterarc.local')
    await page.getByTestId('login-password').fill('123456')
    await page.getByTestId('login-submit').click()
    await expect(page.getByTestId('home-welcome')).toBeVisible({ timeout: 15_000 })

    const title = `E2E Studio ${Date.now()}`
    await page.getByTestId('project-title').fill(title)
    await page.getByTestId('project-genre').fill('科幻')
    await page.getByTestId('project-create').click()

    const projectItem = page.getByTestId('project-item').filter({ hasText: title })
    await expect(projectItem).toBeVisible({ timeout: 15_000 })

    await projectItem.getByTestId('project-open').click()

    await expect(page.getByTestId('studio-root')).toBeVisible({ timeout: 20_000 })
    await expect(page.getByTestId('workbench-page')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByRole('button', { name: '剧情大纲' })).toBeVisible({ timeout: 15_000 })
    await expect(page.getByRole('heading', { name: '作品概览' })).toBeVisible()
  })
})
