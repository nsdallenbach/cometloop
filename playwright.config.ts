import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  expect: {
    timeout: 15_000,
  },
  use: {
    baseURL: `http://localhost:${process.env.DATABRICKS_APP_PORT || process.env.PORT || 8000}`,
    trace: 'on-first-retry',
  },
  projects: [
    {
      // Edge channel: Playwright's Chromium download stalls on this network,
      // and msedge is preinstalled on Windows.
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], channel: 'msedge' },
    },
  ],
  webServer: {
    command: 'npm run dev',
    url: `http://localhost:${process.env.DATABRICKS_APP_PORT || process.env.PORT || 8000}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120 * 1000,
  },
});
