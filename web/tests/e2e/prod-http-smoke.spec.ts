import { test, expect } from '@playwright/test'

const BASE = 'http://124.222.218.97/character-arc/'

test('http stale token shows login after fix', async ({ page }) => {
  await page.goto(`${BASE}login`)
  await page.evaluate(() => {
    localStorage.setItem('ca_access_token', 'invalid-token')
    localStorage.setItem('ca_refresh_token', 'invalid-token')
  })
  await page.goto(BASE)
  await expect(page.getByRole('heading', { name: '欢迎回来' })).toBeVisible({ timeout: 10_000 })
})

test('http admin home renders', async ({ page }) => {
  await page.goto(`${BASE}login`)
  await page.getByTestId('login-email').fill('admin@characterarc.local')
  await page.getByTestId('login-password').fill('123456')
  await page.getByTestId('login-submit').click()
  await expect(page.getByTestId('home-welcome')).toBeVisible({ timeout: 15_000 })
})
