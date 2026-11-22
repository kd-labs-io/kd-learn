// Screenshots of every screen, light and dark, for UX review (plan cai-thien-ux.md step 1).
// Not a test of behaviour: it only fails when a screen cannot be reached. Look at the pictures.
import { expect, test, type Page } from '@playwright/test';
import { E2E_ADMIN, accountsPort } from '../accounts-env';

test.use({ locale: 'en-US', baseURL: `http://localhost:${accountsPort}` });
test.setTimeout(480_000);

const unique = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const modes = ['light', 'dark'] as const;

let address = 0;
test.beforeEach(async ({ context }, info) => {
  address += 1;
  await context.setExtraHTTPHeaders({
    'x-forwarded-for': `14.${info.workerIndex % 250}.${(address >> 8) % 250}.${address % 250}`,
  });
});

/** Reloads in each mode and saves a full-page picture; `then` runs after each reload. */
async function shoot(page: Page, name: string, then?: () => Promise<void>) {
  const project = test.info().project.name;
  for (const mode of modes) {
    // An account keeps its own appearance ("system" by default), so the cookie alone is not enough.
    await page.emulateMedia({ colorScheme: mode });
    await page
      .context()
      .addCookies([{ name: 'kd_appearance', value: `${mode}.kd`, url: page.url() }]);
    await page.reload();
    // A lesson keeps a stream open, so it never goes network-idle: wait a little at most.
    await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => undefined);
    if (then !== undefined) await then();
    // Let drawers and fonts settle.
    await page.waitForTimeout(400);
    await page.screenshot({ path: `ux-shots/${project}/${name}-${mode}.png`, fullPage: true });
  }
}

async function connectFakeModel(page: Page) {
  const key = `key-${unique()}-0123456789`;
  await page.goto('/settings');
  await page.getByTestId('connection-provider').click();
  await page.getByRole('option', { name: 'OpenAI-compatible' }).click();
  await page.getByTestId('connection-endpoint').click();
  await page.getByRole('option', { name: 'Fake model' }).click();
  await page.getByLabel('API key').fill(key);
  await page.getByLabel('Name').fill('Fake');
  await page.getByTestId('connection-save').click();
  await expect(page.getByTestId('connection-item')).toContainText(key.slice(-4));
  await page.getByTestId('role-prober-connection').click();
  await page.getByRole('option', { name: 'Fake' }).click();
  await page.getByTestId('role-prober-model').fill('fake-model');
  await page.getByTestId('roles-copy').click();
  await page.getByTestId('roles-save').click();
  await expect(page.getByTestId('roles-message')).toContainText('Saved');
}

async function send(page: Page, text: string) {
  const composer = page.getByTestId('composer-input');
  await composer.fill(text);
  await page.getByTestId('composer-send').click();
  await expect(composer).toBeEditable();
}

test('signed out', async ({ page }) => {
  for (const path of ['/', '/login', '/register']) {
    await page.goto(path);
    await shoot(page, `signed-out${path === '/' ? '-home' : path.replace('/', '-')}`);
  }
});

test('guest', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('kd-learn.mode', 'guest'));
  await page.goto('/');
  await shoot(page, 'guest-home');
  await page.goto('/settings');
  await shoot(page, 'guest-settings');
});

test('account', async ({ page }) => {
  const email = `shots-${unique()}@e2e.test`;
  await page.goto('/register');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('learner-password-1');
  await page.getByTestId('auth-submit').click();
  await expect(page.getByTestId('who')).toHaveText(email);
  await page.waitForLoadState('networkidle');
  await page.goto('/');
  await shoot(page, 'home-new-account');

  await connectFakeModel(page);
  await shoot(page, 'settings');

  await page.goto('/');
  await shoot(page, 'home-empty');
  await page.getByTestId('topic-input').fill('Binary search');
  await page.getByTestId('start-session').click();
  await expect(page).toHaveURL(/\/a\//);
  await expect(page.getByTestId('msg-tutor').first()).toBeVisible();
  await shoot(page, 'lesson-probing');

  await send(page, 'I know arrays and loops');
  await send(page, '#assess');
  await shoot(page, 'lesson-plan');
  await shoot(page, 'lesson-side-chat', async () => {
    const open = page.getByTestId('side-open');
    if (!(await page.getByTestId('side-chat').isVisible())) await open.click();
    await page.getByTestId('side-input').fill('What does O(log n) mean?');
    await page.getByTestId('side-send').click();
    await expect(page.getByTestId('side-input')).toBeEditable();
  });
  await page.reload();
  await page.getByTestId('composer-input').fill('#done');
  await page.getByTestId('composer-send').click();
  await expect(page.getByTestId('lesson-done')).toBeVisible();
  await shoot(page, 'lesson-done');

  await page.goto('/');
  await page.getByTestId('topic-input').fill('TypeScript generics');
  await page.getByTestId('start-session').click();
  await expect(page.getByTestId('msg-tutor').first()).toBeVisible();
  await page.goto('/');
  await shoot(page, 'home-sessions');

  for (const path of ['/graph', '/practice', '/sources', '/profile']) {
    await page.goto(path);
    await shoot(page, path.slice(1));
  }
});

test('admin', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill(E2E_ADMIN.email);
  await page.getByLabel('Password').fill(E2E_ADMIN.password);
  await page.getByTestId('auth-submit').click();
  await expect(page.getByTestId('who')).toHaveText(E2E_ADMIN.email);
  await page.goto('/admin');
  await shoot(page, 'admin');
});
