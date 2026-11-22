import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import { E2E_ADMIN, accountsPort, fakeModelPort, fakeSearchPort } from './e2e/accounts-env';

// Browser tests run against the production SSR build (`pnpm build`, then `node .output/server`).
// CI installs Chromium only; Firefox and WebKit run locally (`pnpm exec playwright install`).
//
// Two servers run the same build:
// - `port`: guest mode only (no accounts), as a server without `KD_LEARN_SECRET_KEY`;
// - `accountsPort`: accounts on, with a fresh database and a fake OpenAI-compatible model
//   (e2e/fake-openai.ts on `fakeModelPort`), so account turns run through the real server.
// Both use a fake SearXNG (e2e/fake-searxng.ts on `fakeSearchPort`) for research.
const port = 4173;
const dbDir = join(tmpdir(), 'kd-learn-e2e');

export default defineConfig({
  testDir: 'e2e',
  testMatch: '**/*.e2e.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: { baseURL: `http://localhost:${port}`, trace: 'retain-on-failure' },
  webServer: [
    {
      command: 'node .output/server/index.mjs',
      url: `http://localhost:${port}`,
      reuseExistingServer: !process.env.CI,
      env: { PORT: String(port), KD_SEARXNG_URL: `http://localhost:${fakeSearchPort}` },
    },
    {
      command: 'node e2e/fake-searxng.ts',
      url: `http://localhost:${fakeSearchPort}`,
      reuseExistingServer: !process.env.CI,
      env: { FAKE_SEARXNG_PORT: String(fakeSearchPort) },
    },
    {
      command: 'node e2e/fake-openai.ts',
      url: `http://localhost:${fakeModelPort}`,
      reuseExistingServer: !process.env.CI,
      env: { FAKE_OPENAI_PORT: String(fakeModelPort) },
    },
    {
      // A fresh database on every start.
      command: `rm -rf "${dbDir}" && mkdir -p "${dbDir}" && node .output/server/index.mjs`,
      url: `http://localhost:${accountsPort}/api/config`,
      reuseExistingServer: !process.env.CI,
      env: {
        PORT: String(accountsPort),
        KD_LEARN_DB_PATH: join(dbDir, 'accounts.db'),
        // A throwaway key for the test database only.
        KD_LEARN_SECRET_KEY: Buffer.alloc(32, 42).toString('base64'),
        KD_LEARN_ADMIN_EMAIL: E2E_ADMIN.email,
        KD_LEARN_ADMIN_PASSWORD: E2E_ADMIN.password,
        KD_LEARN_REGISTRATION: 'open',
        // Each test sends its own X-Forwarded-For, so the per-address sign-up limit (10 an hour)
        // does not make parallel tests fail each other.
        KD_LEARN_TRUST_PROXY: '1',
        KD_OPENAI_COMPATIBLE_ENDPOINTS: JSON.stringify([
          { id: 'fake', label: 'Fake model', baseURL: `http://localhost:${fakeModelPort}/v1` },
          {
            id: 'fake-images',
            label: 'Fake images',
            baseURL: `http://localhost:${fakeModelPort}/v1`,
            images: true,
          },
        ]),
        KD_LEARN_DEMO_MODE: 'on',
        KD_LEARN_DEMO_PROVIDER: 'openai-compatible',
        KD_LEARN_DEMO_ENDPOINT: 'fake',
        KD_LEARN_DEMO_MODEL: 'fake-demo',
        KD_LEARN_DEMO_API_KEY: 'demo-key-e2e',
        KD_LEARN_DEMO_BUDGET: '1000',
        KD_SEARXNG_URL: `http://localhost:${fakeSearchPort}`,
      },
    },
  ],
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
});
