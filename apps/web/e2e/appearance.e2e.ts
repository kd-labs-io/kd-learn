// Browser tests of the appearance (plan theme-va-dien-thoai.md step 3): color mode and built-in
// theme apply at once, survive a reload with no flash (the server render reads the cookie), follow
// the OS in `system`, reach elements outside the app's wrapper (portals), and follow an account to
// another device.
import { expect, test, type Page } from '@playwright/test';
import { accountsPort } from './accounts-env';

test.use({ locale: 'en-US' });

const KD_LIGHT_BG = 'rgb(250, 249, 245)';
const KD_DARK_BG = 'rgb(26, 25, 21)';
const OCEAN_DARK_BG = 'rgb(15, 24, 32)';
const OCEAN_DARK_ACCENT = 'rgb(124, 196, 236)';

/** Colors as an element at the end of `<body>` sees them: outside the app, like a portal. */
const outside = (page: Page) =>
  page.evaluate(() => {
    const probe = document.createElement('i');
    probe.style.background = 'var(--color-background-body)';
    probe.style.color = 'var(--color-accent)';
    document.body.appendChild(probe);
    const style = getComputedStyle(probe);
    const colors = { bg: style.backgroundColor, accent: style.color };
    probe.remove();
    return colors;
  });

const html = (page: Page) => page.locator('html');

test('dark mode and a theme apply at once, survive a reload, and reach portals', async ({
  page,
}) => {
  await page.goto('/settings');
  await expect(page.getByTestId('appearance')).toBeVisible();
  expect((await outside(page)).bg).toBe(KD_LIGHT_BG);

  await page.getByTestId('appearance-mode-dark').click();
  await expect(html(page)).toHaveAttribute('data-theme', 'dark');
  expect((await outside(page)).bg).toBe(KD_DARK_BG);

  await page.getByText('Ocean', { exact: true }).click();
  await expect(html(page)).toHaveAttribute('data-kd-theme', 'ocean');
  expect(await outside(page)).toEqual({ bg: OCEAN_DARK_BG, accent: OCEAN_DARK_ACCENT });

  // The server render already has the choice: no flash before hydration.
  const served = await (await page.context().request.get('/settings')).text();
  expect(served).toMatch(/<html[^>]*data-theme="dark"/);
  expect(served).toMatch(/<html[^>]*data-kd-theme="ocean"/);

  await page.reload({ waitUntil: 'commit' });
  await page.waitForLoadState('domcontentloaded');
  expect((await outside(page)).bg).toBe(OCEAN_DARK_BG);
  await expect(page.getByTestId('appearance-mode-dark')).toBeVisible();
  await expect(page.getByRole('radio', { name: 'Ocean' })).toBeChecked();
});

test('system mode follows the OS, live', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/settings');
  await page.getByTestId('appearance-mode-light').click();
  expect((await outside(page)).bg).toBe(KD_LIGHT_BG);
  await page.getByTestId('appearance-mode-system').click();
  await expect(html(page)).not.toHaveAttribute('data-theme', /./);
  expect((await outside(page)).bg).toBe(KD_DARK_BG);
  await page.emulateMedia({ colorScheme: 'light' });
  expect((await outside(page)).bg).toBe(KD_LIGHT_BG);
});

test('a damaged cookie shows the default appearance', async ({ page, context, baseURL }) => {
  await context.addCookies([{ name: 'kd_appearance', value: 'dark.<script>', url: baseURL ?? '' }]);
  const served = await (await context.request.get('/settings')).text();
  expect(served).not.toContain('<script>"');
  expect(served).toMatch(/<html[^>]*data-kd-theme="kd"/);
  await page.goto('/settings');
  await expect(html(page)).toHaveAttribute('data-kd-theme', 'kd');
});

test.describe('account', () => {
  test.use({ baseURL: `http://localhost:${accountsPort}` });

  let address = 200;
  test.beforeEach(async ({ context }, info) => {
    address += 1;
    await context.setExtraHTTPHeaders({
      'x-forwarded-for': `10.${200 + (info.workerIndex % 50)}.${(address >> 8) % 250}.${address % 250}`,
    });
  });

  test('the appearance follows the account to another device', async ({ page, browser }) => {
    const email = `look-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}@e2e.test`;
    await page.goto('/register');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill('learner-password-1');
    await page.getByTestId('auth-submit').click();
    await expect(page.getByTestId('who')).toHaveText(email);

    await page.goto('/settings');
    await page.getByTestId('appearance-mode-dark').click();
    await page.getByText('Ocean', { exact: true }).click();
    await expect(html(page)).toHaveAttribute('data-kd-theme', 'ocean');

    // A second device: fresh cookies, same account. The saved value wins once signed in.
    const other = await browser.newContext({
      locale: 'en-US',
      baseURL: `http://localhost:${accountsPort}`,
      extraHTTPHeaders: { 'x-forwarded-for': `10.249.${address % 250}.1` },
    });
    const second = await other.newPage();
    await second.goto('/login');
    await expect(html(second)).toHaveAttribute('data-kd-theme', 'kd');
    await second.getByLabel('Email').fill(email);
    await second.getByLabel('Password').fill('learner-password-1');
    await second.getByTestId('auth-submit').click();
    await expect(second.getByTestId('who')).toHaveText(email);
    await expect(html(second)).toHaveAttribute('data-kd-theme', 'ocean');
    await expect(html(second)).toHaveAttribute('data-theme', 'dark');
    // Stored on that device too, so its next load has no flash.
    const cookies = await other.cookies();
    expect(cookies.find((c) => c.name === 'kd_appearance')?.value).toBe('dark.ocean');
    await other.close();
  });
});
