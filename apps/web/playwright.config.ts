import { defineConfig, devices } from '@playwright/test';

// Browser tests run against the production SSR build (`pnpm build`, then `node .output/server`).
// CI installs Chromium only; Firefox and WebKit run locally (`pnpm exec playwright install`).
const port = 4173;

export default defineConfig({
  testDir: 'e2e',
  testMatch: '**/*.e2e.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: { baseURL: `http://localhost:${port}`, trace: 'retain-on-failure' },
  webServer: {
    command: 'node .output/server/index.mjs',
    url: `http://localhost:${port}`,
    reuseExistingServer: !process.env.CI,
    env: { PORT: String(port) },
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
});
