import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:8787',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
