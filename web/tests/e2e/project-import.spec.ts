import { test, expect } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_CARC = path.resolve(
  __dirname,
  '../../../samples/projects/国家以为我在吹牛直到我造出恒星引擎.carc',
)

test.describe('项目导入', () => {
  test('Admin 可导入 .carc 并在列表显示', async ({ page }) => {
    await page.goto('login')
    await page.evaluate(() => localStorage.clear())
    await page.getByTestId('login-email').fill('admin@characterarc.local')
    await page.getByTestId('login-password').fill('123456')
    await page.getByTestId('login-submit').click()
    await expect(page.getByTestId('home-welcome')).toBeVisible({ timeout: 15_000 })

    const importInput = page.getByTestId('project-import-input')
    await importInput.setInputFiles(SAMPLE_CARC)
    await expect(page.getByTestId('project-import-message')).toContainText(/已导入|恒星引擎/, {
      timeout: 30_000,
    })
    await expect(
      page.getByTestId('project-item').filter({ hasText: '恒星引擎' }).first(),
    ).toBeVisible({ timeout: 10_000 })
  })
})
