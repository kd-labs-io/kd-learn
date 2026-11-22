// Figures in a lesson (phase 5 steps 7 and 8), against the production build with accounts on and
// the fake model (e2e/fake-openai.ts): the real agent tools, server, storage and screen. `#diagram`,
// `#mermaid`, `#demo` and `#hostile` in a learner message make the fake Teacher call a figure tool.
import { expect, test, type Page } from '@playwright/test';
import { accountsPort, fakeModelPort } from './accounts-env';

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
    await page.getByTestId('who').click();
    await page.getByRole('menuitem', { name: /^(Cài đặt|Settings)$/ }).click();
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

  test('the image model draws with its own key, and the image survives a reload', async ({
    page,
  }) => {
    await page.goto('/');
    await page.getByTestId('choose-guest').click();
    await page.getByTestId('who').click();
    await page.getByRole('menuitem', { name: /^(Cài đặt|Settings)$/ }).click();
    await page.getByTestId('provider').click();
    await page.getByRole('option', { name: 'OpenAI-compatible' }).click();
    await page.getByTestId('endpoint').click();
    await page.getByRole('option', { name: 'Fake model' }).click();
    await page.getByLabel('Model').fill('fake-model');
    await page.getByLabel('API key').fill(`guest-text-${unique()}-0123456789`);
    await page.getByTestId('save-settings').click();
    await expect(page.getByTestId('settings-message')).toContainText('Saved');

    const imageKey = `guest-image-${unique()}-0123456789`;
    await page.getByTestId('image-provider').click();
    await page.getByRole('option', { name: 'OpenAI-compatible' }).click();
    await page.getByTestId('image-endpoint').click();
    // Only endpoints that make images are offered.
    await expect(page.getByRole('option', { name: 'Fake model' })).toHaveCount(0);
    await page.getByRole('option', { name: 'Fake images' }).click();
    await page.getByTestId('image-model').fill('fake-image');
    await page.getByTestId('image-api-key').fill(imageKey);
    await page.getByTestId('image-save').click();
    await expect(page.getByTestId('image-settings-message')).toContainText('Saved');
    // Saving the text model again keeps the image model.
    await page.getByTestId('save-settings').click();
    await page.reload();
    await expect(page.getByTestId('image-delete-key')).toBeVisible();
    await page.getByTestId('nav-home').click();

    await startTeaching(page, 'Colors');
    await answer(page, '#image');
    const image = tutor(page).last().getByRole('img', { name: 'A red square' });
    await expect(image).toBeVisible({ timeout: 20_000 });
    await expect
      .poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth))
      .toBe(16);
    const calls = await fetch(`http://localhost:${fakeModelPort}/calls/${imageKey}`);
    expect(((await calls.json()) as { calls: number }).calls).toBe(1);
    await page.reload();
    await expect(tutor(page).getByRole('img', { name: 'A red square' })).toBeVisible();
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
  await page.getByTestId('who').click();
  await page.getByRole('menuitem', { name: /^(Cài đặt|Settings)$/ }).click();
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

test('account: the illustrator draws an image, only from an image endpoint, and it stays after a reload', async ({
  page,
}) => {
  await page.goto('/register');
  const email = `images-${unique()}@e2e.test`;
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('learner-password-1');
  await page.getByTestId('auth-submit').click();
  await expect(page.getByTestId('who')).toHaveText(email);
  await page.getByTestId('who').click();
  await page.getByRole('menuitem', { name: /^(Cài đặt|Settings)$/ }).click();
  const connect = async (endpoint: string, name: string) => {
    await page.getByTestId('connection-provider').click();
    await page.getByRole('option', { name: 'OpenAI-compatible' }).click();
    await page.getByTestId('connection-endpoint').click();
    await page.getByRole('option', { name: endpoint }).click();
    await page.getByLabel('API key').fill(`acct-images-${unique()}-0123456789`);
    await page.getByLabel('Name').fill(name);
    await page.getByTestId('connection-save').click();
  };
  await connect('Fake model', 'Fake');
  await expect(page.getByTestId('connection-item')).toHaveCount(1);
  // A text-only endpoint cannot be the illustrator.
  await expect(page.getByTestId('role-illustrator-none')).toBeVisible();
  await connect('Fake images', 'Pics');
  await expect(page.getByTestId('connection-item')).toHaveCount(2);
  await expect(page.getByTestId('role-illustrator-none')).toHaveCount(0);

  await page.getByTestId('role-prober-connection').click();
  await page.getByRole('option', { name: 'Fake' }).click();
  await page.getByTestId('role-prober-model').fill('fake-model');
  await page.getByTestId('roles-copy').click();
  // Copying never sets the illustrator.
  await expect(page.getByTestId('role-illustrator-model')).toHaveValue('');
  await page.getByTestId('role-illustrator-connection').click();
  await expect(page.getByRole('option', { name: 'Fake', exact: true })).toHaveCount(0);
  await page.getByRole('option', { name: 'Pics' }).click();
  await page.getByTestId('role-illustrator-model').fill('fake-image');
  await page.getByTestId('roles-save').click();
  await expect(page.getByTestId('roles-message')).toContainText('Saved');
  await page.getByTestId('nav-home').click();

  await startTeaching(page, 'Colors');
  await answer(page, '#image');
  const image = tutor(page).last().getByRole('img', { name: 'A red square' });
  await expect(image).toBeVisible({ timeout: 20_000 });
  await expect
    .poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth))
    .toBe(16);
  await tutor(page).last().getByRole('button', { name: 'Enlarge' }).click();
  await expect(page.getByRole('dialog').getByRole('img', { name: 'A red square' })).toBeVisible();
  await page.keyboard.press('Escape');

  await page.reload();
  await expect(tutor(page).getByRole('img', { name: 'A red square' })).toBeVisible({
    timeout: 20_000,
  });
});
