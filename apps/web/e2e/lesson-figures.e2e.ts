// Figures in a lesson (phase 5 steps 7 and 8), against the production build with accounts on and
// the fake model (e2e/fake-openai.ts): the real agent tools, server, storage and screen. `#diagram`,
// `#mermaid`, `#demo` and `#hostile` in a learner message make the fake Teacher call a figure tool.
import { expect, test, type Page } from '@playwright/test';
import { accountsPort } from './accounts-env';

test.use({ locale: 'en-US', baseURL: `http://localhost:${accountsPort}` });

const unique = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

let address = 0;
test.beforeEach(async ({ context }, info) => {
  address += 1;
  await context.setExtraHTTPHeaders({
    'x-forwarded-for': `13.${info.workerIndex % 250}.${(address >> 8) % 250}.${address % 250}`,
  });
});

/** Requests to hosts other than the app; all refused. */
async function watchOutside(page: Page) {
  const outside: Array<string> = [];
  await page.route(
    (url) => url.protocol.startsWith('http') && url.hostname !== 'localhost',
    (route) => {
      outside.push(route.request().url());
      return route.abort();
    },
  );
  return outside;
}

const answer = async (page: Page, text: string) => {
  await page.getByTestId('composer-input').fill(text);
  await page.getByTestId('composer-send').click();
  await expect(page.getByTestId('composer-input')).toBeEditable();
};

/** From the home screen: a session in its teaching phase. */
async function startTeaching(page: Page, topic: string) {
  await page.getByLabel('What do you want to learn?').fill(topic);
  await page.getByTestId('start-session').click();
  await expect(page.getByText('What do you already know?')).toBeVisible();
  await answer(page, '#assess');
  await expect(page.getByText('Basics').first()).toBeVisible();
}

const tutor = (page: Page) => page.getByTestId('msg-tutor');

async function hostileDemoStaysInside(page: Page, outside: Array<string>) {
  await answer(page, '#hostile');
  const demo = tutor(page).last().getByTestId('figure-demo');
  await expect(demo).toBeVisible();
  // Never runs by itself.
  await expect(demo.getByTestId('figure-frame')).toHaveCount(0);
  await demo.getByRole('button', { name: 'Run' }).click();
  const out = page.frameLocator('[data-testid="figure-frame"]').locator('#out');
  await expect(out).toContainText('fetch:blocked');
  const text = (await out.textContent()) ?? '';
  for (const note of ['ls:blocked', 'parent:blocked', 'api:blocked']) {
    expect(text).toContain(note);
  }
  // Reading cookies throws in Chromium and Firefox; WebKit gives an empty string. Never the app's.
  expect(text).toMatch(/cookie:(blocked)? /);
  await expect(demo.getByTestId('figure-demo-error')).toContainText('Blocked by the sandbox');
  // It then tries to navigate itself away (risk 43).
  await page.waitForTimeout(2000);
  expect(outside).toEqual([]);
  await expect(page.getByTestId('composer-input')).toBeEditable();
}

test.describe('guest', () => {
  test.skip(
    ({ browserName }) => browserName === 'webkit',
    'No OPFS in this browser context: guest storage falls back to memory',
  );

  test('the Teacher draws a diagram, it survives a reload, and a hostile demo stays in its frame', async ({
    page,
  }) => {
    const outside = await watchOutside(page);
    await page.goto('/');
    await page.getByTestId('choose-guest').click();
    await page.getByTestId('nav-settings').click();
    await page.getByTestId('provider').click();
    await page.getByRole('option', { name: 'OpenAI-compatible' }).click();
    await page.getByTestId('endpoint').click();
    await page.getByRole('option', { name: 'Fake model' }).click();
    await page.getByLabel('Model').fill('fake-model');
    await page.getByLabel('API key').fill(`guest-figures-${unique()}-0123456789`);
    await page.getByTestId('save-settings').click();
    await expect(page.getByTestId('settings-message')).toContainText('Saved');
    await page.getByTestId('nav-home').click();

    await startTeaching(page, 'Halves');
    await answer(page, '#diagram');
    const image = tutor(page).last().getByTestId('figure-image');
    await expect(image).toBeVisible();
    await expect(tutor(page).last()).toContainText('Two halves');
    await expect(tutor(page).last()).toContainText('Noted.');
    await page.reload();
    await expect(tutor(page).getByTestId('figure-image')).toBeVisible();

    await hostileDemoStaysInside(page, outside);
  });
});

test('account: Mermaid and a demo come from the server, and stay after a reload', async ({
  page,
}) => {
  const outside = await watchOutside(page);
  await page.goto('/register');
  const email = `figures-${unique()}@e2e.test`;
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('learner-password-1');
  await page.getByTestId('auth-submit').click();
  await expect(page.getByTestId('who')).toHaveText(email);
  await page.getByTestId('nav-settings').click();
  await page.getByTestId('connection-provider').click();
  await page.getByRole('option', { name: 'OpenAI-compatible' }).click();
  await page.getByTestId('connection-endpoint').click();
  await page.getByRole('option', { name: 'Fake model' }).click();
  await page.getByLabel('API key').fill(`acct-figures-${unique()}-0123456789`);
  await page.getByLabel('Name').fill('Fake');
  await page.getByTestId('connection-save').click();
  await expect(page.getByTestId('connection-item')).toBeVisible();
  await page.getByTestId('role-prober-connection').click();
  await page.getByRole('option', { name: 'Fake' }).click();
  await page.getByTestId('role-prober-model').fill('fake-model');
  await page.getByTestId('roles-copy').click();
  await page.getByTestId('roles-save').click();
  await expect(page.getByTestId('roles-message')).toContainText('Saved');
  await page.getByTestId('nav-home').click();

  await startTeaching(page, 'Steps');
  await answer(page, '#mermaid');
  await expect(tutor(page).last().getByTestId('figure-image')).toBeVisible({ timeout: 20_000 });
  await answer(page, '#demo');
  const demo = tutor(page).last().getByTestId('figure-demo');
  await demo.getByRole('button', { name: 'Run' }).click();
  const frame = page.frameLocator('[data-testid="figure-frame"]');
  await frame.locator('#inc').click();
  await expect(frame.locator('#count')).toHaveText('1');

  await page.reload();
  await expect(tutor(page).getByTestId('figure-image')).toBeVisible({ timeout: 20_000 });
  await expect(tutor(page).getByTestId('figure-demo')).toBeVisible();
  await hostileDemoStaysInside(page, outside);
});
