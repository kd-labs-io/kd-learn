// The server render and the client agree (plan theme-va-dien-thoai.md step 5, React #418): the
// client takes the locale the server rendered in (`data-ssr-locale`), even when the request had no
// `Accept-Language` (headless Chromium) or one that differs from the browser's languages.
import { expect, test, type Browser } from '@playwright/test';

const pages = ['/', '/login', '/settings'];

const errorsOn = async (browser: Browser, options: Parameters<Browser['newContext']>[0]) => {
  const context = await browser.newContext(options);
  const errors: Array<string> = [];
  for (const path of pages) {
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(`${path}: ${error.message.slice(0, 120)}`));
    await page.goto(path);
    await expect(page.locator('html')).toHaveAttribute('data-ssr-locale', /^(vi|en)$/);
    await page.waitForLoadState('networkidle');
    await page.close();
  }
  await context.close();
  return errors;
};

test('no hydration error without Accept-Language', async ({ browser, baseURL }) => {
  expect(await errorsOn(browser, { baseURL: baseURL ?? '' })).toEqual([]);
});

test('no hydration error when Accept-Language and the browser disagree', async ({
  browser,
  baseURL,
}) => {
  const errors = await errorsOn(browser, {
    baseURL: baseURL ?? '',
    locale: 'en-US',
    extraHTTPHeaders: { 'accept-language': 'vi' },
  });
  expect(errors).toEqual([]);
});
