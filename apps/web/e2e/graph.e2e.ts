// The graph screen (phase 3 step 9) in both modes, against the production build with accounts on
// and the fake model (e2e/fake-openai.ts). A session is learned to its end in the browser; the
// extraction it starts is held by the fake model (`slow-extract` in the key) until the graph
// screen is open, so the test sees the screen update by itself, without a reload or a click.
import { expect, test, type Page } from '@playwright/test';
import { accountsPort, fakeModelPort } from './accounts-env';

test.use({ locale: 'en-US', baseURL: `http://localhost:${accountsPort}` });

test.skip(
  ({ browserName }) => browserName === 'webkit',
  'No OPFS in this browser context: guest storage falls back to memory',
);

const unique = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

let address = 0;
/** A client address of its own, outside the ranges of the other account tests. */
test.beforeEach(async ({ context }, info) => {
  address += 1;
  await context.setExtraHTTPHeaders({
    'x-forwarded-for': `12.${info.workerIndex % 250}.${(address >> 8) % 250}.${address % 250}`,
  });
});

const release = (key: string) =>
  fetch(`http://localhost:${fakeModelPort}/release/${encodeURIComponent(key)}`, {
    method: 'POST',
  });

const answer = async (page: Page, text: string) => {
  await page.getByTestId('composer-input').fill(text);
  await page.getByTestId('composer-send').click();
};

/** From the home screen: a session learned to its end (assessment, plan, the one step done). */
async function learnToTheEnd(page: Page, topic: string) {
  await page.getByLabel('What do you want to learn?').fill(topic);
  await page.getByTestId('start-session').click();
  await expect(page.getByText('What do you already know?')).toBeVisible();
  await answer(page, '#assess');
  await expect(page.getByTestId('composer-input')).toBeEditable();
  await expect(page.getByText('Basics').first()).toBeVisible();
  await answer(page, '#done');
  await expect(page.getByTestId('composer-input')).toHaveCount(0);
}

/** The screen shows the extraction, then its statements once the fake model answers. */
async function seesGraphUpdate(page: Page, key: string) {
  await page.getByTestId('nav-home').click();
  await page.getByTestId('nav-graph').click();
  await expect(page).toHaveURL(/\/graph$/);
  await expect(page.getByTestId('graph-extracting')).toBeVisible();
  await expect(page.getByTestId('graph-item')).toHaveCount(0);
  expect((await release(key)).status).toBe(204);
  await expect(page.getByTestId('graph-item')).toHaveCount(2);
  await expect(page.getByTestId('graph-extracting')).toHaveCount(0);

  // Detail: the edge "a requires b" of the fake extractor, in both directions.
  await page.getByTestId('graph-item').filter({ hasText: 'states the basics' }).click();
  await expect(page.getByTestId('graph-detail')).toContainText('requires');
  // Search narrows the list; removing a statement takes it out.
  await page.getByTestId('graph-search').fill('builds');
  await expect(page.getByTestId('graph-item')).toHaveCount(1);
  await page.getByTestId('graph-search').fill('');
  await page.getByTestId('graph-item').first().click();
  await page.getByTestId('graph-retire').click();
  await page.getByTestId('graph-retire-confirm').click();
  await expect(page.getByTestId('graph-item')).toHaveCount(1);
  await page.reload();
  await expect(page.getByTestId('graph-item')).toHaveCount(1);
}

test('guest: a finished session shows up on the graph screen by itself', async ({ page }) => {
  const key = `slow-extract-guest-${unique()}-0123456789`;
  await page.goto('/');
  await page.getByTestId('choose-guest').click();
  await page.getByTestId('nav-settings').click();
  await page.getByTestId('provider').click();
  await page.getByRole('option', { name: 'OpenAI-compatible' }).click();
  await page.getByTestId('endpoint').click();
  await page.getByRole('option', { name: 'Fake model' }).click();
  await page.getByLabel('Model').fill('fake-model');
  await page.getByLabel('API key').fill(key);
  await page.getByTestId('save-settings').click();
  await expect(page.getByTestId('settings-message')).toContainText('Saved');
  await page.getByTestId('nav-graph').click();
  await expect(page.getByRole('heading', { name: 'No knowledge yet' })).toBeVisible();
  await page.getByTestId('nav-home').click();

  await learnToTheEnd(page, 'Binary search');
  await seesGraphUpdate(page, key);
});

test('account: a finished session shows up on the graph screen by itself', async ({ page }) => {
  const key = `slow-extract-acct-${unique()}-0123456789`;
  await page.goto('/register');
  const email = `graph-${unique()}@e2e.test`;
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('learner-password-1');
  await page.getByTestId('auth-submit').click();
  await expect(page.getByTestId('who')).toHaveText(email);

  await page.getByTestId('nav-settings').click();
  await page.getByTestId('connection-provider').click();
  await page.getByRole('option', { name: 'OpenAI-compatible' }).click();
  await page.getByTestId('connection-endpoint').click();
  await page.getByRole('option', { name: 'Fake model' }).click();
  await page.getByLabel('API key').fill(key);
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

  await learnToTheEnd(page, 'Fractions');
  await seesGraphUpdate(page, key);
});
