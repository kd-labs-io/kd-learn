// Screenshots of every screen for UX review (plan cai-thien-ux.md, step 1 and the `ux-check`
// skill). Same servers as the e2e config; only `*.shots.ts` run, on a desktop and a phone.
// Run: `pnpm --filter @kd-learn/web build && pnpm --filter @kd-learn/web shots`.
// Pictures land in `apps/web/ux-shots/<project>/` (git-ignored).
import { defineConfig, devices } from '@playwright/test';
import base from './playwright.config';

export default defineConfig({
  ...base,
  testMatch: '**/*.shots.ts',
  fullyParallel: false,
  retries: 0,
  reporter: 'list',
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
    { name: 'phone', use: { ...devices['Pixel 7'] } },
  ],
});
