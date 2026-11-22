// The web app on a phone (plan theme-va-dien-thoai.md A6, step 5), in Playwright's device
// emulation: an iPhone on WebKit and a Pixel on Chromium (projects `iphone` and `pixel`). It cannot
// show the on-screen keyboard or OPFS on WebKit: those are checked on real phones (step 7).
import { expect, test, type Page } from '@playwright/test';
import { E2E_ADMIN, accountsPort } from './accounts-env';
import { expectWho } from './rail';

test.use({ locale: 'en-US', baseURL: `http://localhost:${accountsPort}` });

const unique = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

let address = 0;
test.beforeEach(async ({ context }, info) => {
  address += 1;
  await context.setExtraHTTPHeaders({
    'x-forwarded-for': `13.${info.workerIndex % 250}.${(address >> 8) % 250}.${address % 250}`,
  });
});

/**
 * Fails when the page scrolls sideways, or when a visible control is cut off at the right edge
 * (an overflow that is clipped scrolls nothing but hides the control).
 */
async function fitsWidth(page: Page, label: string) {
  const overflow = await page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const cut: Array<string> = [];
    for (const element of document.body.querySelectorAll(
      'button, a, input, textarea, [role="button"]',
    )) {
      const box = element.getBoundingClientRect();
      if (box.width === 0 || box.height === 0 || element.closest('[inert], [aria-hidden="true"]')) {
        continue;
      }
      if (box.left < width && box.right > width + 1) {
        const id = element.getAttribute('data-testid');
        cut.push(
          `${element.tagName.toLowerCase()}${id ? `[${id}]` : ''} "${(element.textContent ?? '').trim().slice(0, 20)}" ${Math.round(box.right)}px`,
        );
      }
    }
    const scroll = document.documentElement.scrollWidth;
    return scroll <= width && cut.length === 0 ? null : { width, scroll, cut };
  });
  expect(overflow, `${label} does not fit the phone width`).toBeNull();
}

/** The main buttons are big enough for a finger (44 CSS px, WCAG 2.5.5 / Apple HIG). */
async function tappable(page: Page, testId: string) {
  const box = await page.getByTestId(testId).boundingBox();
  expect(box, testId).not.toBeNull();
  expect(Math.max(box!.height, box!.width), testId).toBeGreaterThanOrEqual(44);
  expect(Math.min(box!.height, box!.width), testId).toBeGreaterThanOrEqual(32);
}

test('guest screens fit the phone width', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('kd-learn.mode', 'guest'));
  for (const path of ['/', '/settings', '/practice', '/graph', '/sources', '/profile']) {
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    await fitsWidth(page, path);
  }
  await page.goto('/');
  await page.evaluate(() => localStorage.removeItem('kd-learn.mode'));
  for (const path of ['/', '/login', '/register']) {
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    await fitsWidth(page, `${path} (signed out)`);
  }
});

test('sign up and learn a session to its end on a phone, in dark mode', async ({
  page,
  context,
  baseURL,
}) => {
  await context.addCookies([{ name: 'kd_appearance', value: 'dark.kd', url: baseURL ?? '' }]);
  const email = `phone-${unique()}@e2e.test`;
  await page.goto('/register');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('learner-password-1');
  await tappable(page, 'auth-submit');
  await page.getByTestId('auth-submit').click();
  await expectWho(page, email);
  await page.waitForLoadState('networkidle');

  const key = `key-${unique()}-0123456789`;
  await page.goto('/settings');
  await fitsWidth(page, '/settings (account)');
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

  await page.goto('/');
  await fitsWidth(page, '/ (account)');
  await page.getByLabel('What do you want to learn?').fill('Binary search');
  await tappable(page, 'start-session');
  await page.getByTestId('start-session').click();
  await expect(page).toHaveURL(/\/a\//);
  await expect(page.getByTestId('msg-tutor').first()).toContainText('What do you already know?');
  await fitsWidth(page, 'lesson');

  const composer = page.getByTestId('composer-input');
  await expect(composer).toBeInViewport();
  await tappable(page, 'composer-send');
  await composer.fill('#assess');
  await page.getByTestId('composer-send').click();
  await expect(composer).toBeEditable();
  // No rail on a phone: the plan is in the rail drawer behind the menu button.
  await page.getByRole('button', { name: 'Open navigation' }).click();
  const plan = page.getByTestId('plan-panel').filter({ visible: true });
  await expect(plan.getByText('Basics').first()).toBeVisible();
  await expect(async () => fitsWidth(page, 'lesson with the plan open')).toPass({ timeout: 3000 });
  await page.keyboard.press('Escape');

  // The side chat opens over the lesson and closes again.
  await page.getByTestId('side-open').click();
  await expect(page.getByTestId('side-chat')).toBeInViewport();
  // The drawer slides in: measure once it has settled.
  await expect(async () => fitsWidth(page, 'side chat')).toPass({ timeout: 3000 });
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('side-chat')).toBeHidden();

  await composer.fill('#done');
  await page.getByTestId('composer-send').click();
  await expect(page.getByTestId('lesson-done')).toBeVisible();
  await fitsWidth(page, 'lesson done');

  await page.goto('/graph');
  await fitsWidth(page, '/graph (account)');
  await page.goto('/practice');
  await fitsWidth(page, '/practice (account)');
});

test('the admin screen fits the phone width', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill(E2E_ADMIN.email);
  await page.getByLabel('Password').fill(E2E_ADMIN.password);
  await page.getByTestId('auth-submit').click();
  await expectWho(page, E2E_ADMIN.email);
  await page.waitForLoadState('networkidle');
  await page.goto('/admin');
  await page.waitForLoadState('networkidle');
  await fitsWidth(page, '/admin');
});
