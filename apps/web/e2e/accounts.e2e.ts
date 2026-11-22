// Browser tests of account mode (plan tai-khoan.md step 8) against the production build with
// accounts on. Nothing is intercepted: the page talks to the real server, which runs the turns and
// calls a fake OpenAI-compatible model (e2e/fake-openai.ts). A turn whose answer contains `hold`
// waits until the test releases it, keyed by the connection's own API key.
import { expect, test, type Page } from '@playwright/test';
import { E2E_ADMIN, accountsPort, fakeModelPort } from './accounts-env';

test.use({ locale: 'en-US', baseURL: `http://localhost:${accountsPort}` });

const unique = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

let address = 0;
/** A client address of its own for this test (the server trusts the header in these tests). */
test.beforeEach(async ({ context }, info) => {
  address += 1;
  await context.setExtraHTTPHeaders({
    'x-forwarded-for': `10.${info.workerIndex % 250}.${(address >> 8) % 250}.${address % 250}`,
  });
});

const release = (key: string) =>
  fetch(`http://localhost:${fakeModelPort}/release/${encodeURIComponent(key)}`, {
    method: 'POST',
  });

async function register(page: Page): Promise<string> {
  const email = `learner-${unique()}@e2e.test`;
  await page.goto('/register');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('learner-password-1');
  await page.getByTestId('auth-submit').click();
  await expect(page.getByTestId('who')).toHaveText(email);
  return email;
}

/** Adds a connection to the fake model and gives every role to it. Returns the key. */
async function connectFakeModel(page: Page): Promise<string> {
  const key = `key-${unique()}-0123456789`;
  await page.getByTestId('nav-settings').click();
  await page.getByTestId('connection-provider').click();
  await page.getByRole('option', { name: 'OpenAI-compatible' }).click();
  await page.getByTestId('connection-endpoint').click();
  await page.getByRole('option', { name: 'Fake model' }).click();
  await page.getByLabel('API key').fill(key);
  await page.getByLabel('Name').fill('Fake');
  await page.getByTestId('connection-save').click();
  await expect(page.getByTestId('connection-item')).toContainText(key.slice(-4));
  // The key itself never comes back to the page.
  await expect(page.locator('body')).not.toContainText(key);

  await page.getByTestId('role-prober-connection').click();
  await page.getByRole('option', { name: 'Fake' }).click();
  await page.getByTestId('role-prober-model').fill('fake-model');
  await page.getByTestId('roles-copy').click();
  await page.getByTestId('roles-save').click();
  await expect(page.getByTestId('roles-message')).toContainText('Saved');
  return key;
}

async function startSession(page: Page, topic: string) {
  await page.getByTestId('nav-home').click();
  await page.getByLabel('What do you want to learn?').fill(topic);
  await page.getByTestId('start-session').click();
  await expect(page).toHaveURL(/\/a\//);
  await expect(page.getByTestId('session-topic')).toHaveText(topic);
  // The first Prober turn starts by itself.
  await expect(page.getByTestId('msg-tutor').first()).toContainText('What do you already know?');
}

const answer = async (page: Page, text: string) => {
  await page.getByLabel('Your answer').fill(text);
  await page.getByTestId('composer-send').click();
};

test('sign in, learn a turn, close the tab mid-turn, reopen: the turn finished on the server', async ({
  page,
  context,
}) => {
  await register(page);
  const key = await connectFakeModel(page);
  await startSession(page, 'Fractions');
  const url = page.url();

  // A turn that waits on the model: the first words stream in, then the tab closes.
  await answer(page, 'please hold');
  await expect(page.getByTestId('msg-live')).toContainText('Thinking it over');
  await page.close();
  await release(key);

  const again = await context.newPage();
  await again.goto('/');
  await again.getByTestId('session-item').filter({ hasText: 'Fractions' }).click();
  await expect(again).toHaveURL(url);
  await expect(again.getByTestId('msg-tutor').last()).toHaveText(
    /Thinking it over, and here is the answer\./,
  );
  await expect(again.getByTestId('turn-interrupted')).toHaveCount(0);
  await expect(again.getByTestId('msg-user')).toContainText('please hold');
  await expect(again.getByTestId('composer-input')).toBeEnabled();
});

test('a tab opened mid-turn shows the text so far and follows the turn to the end', async ({
  page,
  context,
}) => {
  await register(page);
  const key = await connectFakeModel(page);
  await startSession(page, 'Rust ownership');

  await answer(page, 'hold on please');
  await expect(page.getByTestId('msg-live')).toContainText('Thinking it over');

  // Reattach: the `running` frame carries the text written so far.
  const second = await context.newPage();
  await second.goto(page.url());
  await expect(second.getByTestId('msg-live')).toContainText('Thinking it over');
  await expect(second.getByTestId('composer-input')).toBeDisabled();
  await expect(second.getByTestId('turn-interrupted')).toHaveCount(0);

  await release(key);
  for (const tab of [page, second]) {
    await expect(tab.getByTestId('msg-tutor').last()).toHaveText(/and here is the answer\./);
    await expect(tab.getByTestId('composer-input')).toBeEnabled();
  }
});

test('without models for the roles, the home screen points to settings and nothing runs', async ({
  page,
}) => {
  await register(page);
  await expect(page.getByTestId('need-roles')).toBeVisible();
  await page.getByLabel('What do you want to learn?').fill('Chess');
  await page.getByTestId('start-session').click();
  await expect(page.getByTestId('turn-failed')).toHaveAttribute('data-code', 'RoleNotConfigured');
  await expect(page.getByTestId('msg-tutor')).toHaveCount(0);
});

test('signing out forgets the token; the sessions are back after signing in again', async ({
  page,
}) => {
  const email = await register(page);
  // Opening the menu before home settles loses it to that re-render.
  await page.waitForLoadState('networkidle');
  await page.getByTestId('who').click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page.getByTestId('welcome')).toBeVisible();
  await page.goto('/a/whatever');
  await expect(page).toHaveURL(/\/login$/);

  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('wrong-password');
  await page.getByTestId('auth-submit').click();
  await expect(page.getByTestId('auth-error')).toHaveText('Wrong email or password.');
  await page.getByLabel('Password').fill('learner-password-1');
  await page.getByTestId('auth-submit').click();
  await expect(page.getByTestId('who')).toHaveText(email);
});

test('the admin screen: users, an invite code, and a warning when the build has no ACP', async ({
  page,
  request,
}) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill(E2E_ADMIN.email);
  await page.getByLabel('Password').fill(E2E_ADMIN.password);
  await page.getByTestId('auth-submit').click();
  // Signed in and home rendered: opening the menu earlier loses it to that re-render.
  await expect(page.getByTestId('who')).toHaveText(E2E_ADMIN.email);
  await page.waitForLoadState('networkidle');
  await page.getByTestId('who').click();
  await page.getByRole('menuitem', { name: 'Admin' }).click();

  await expect(page.getByTestId('admin-user').filter({ hasText: E2E_ADMIN.email })).toBeVisible();
  await page.getByTestId('admin-invite').click();
  await expect(page.getByTestId('admin-invite-code')).toBeVisible();

  // Whether the build can load the ACP adapter depends on where it runs (an installed
  // node_modules next to `.output` can provide it); the warning follows the server's answer.
  const login = await request.post('/api/auth/login', { data: E2E_ADMIN });
  const { token } = (await login.json()) as { token: string };
  const config = (await (
    await request.get('/api/admin/config', { headers: { authorization: `Bearer ${token}` } })
  ).json()) as { acpAvailable: boolean };
  await page.getByRole('switch', { name: 'Claude Code' }).click();
  await expect(page.getByTestId('admin-acp-models-claude-code')).toBeVisible();
  await expect(page.getByTestId('admin-acp-unavailable')).toHaveCount(config.acpAvailable ? 0 : 1);
  await page.getByRole('switch', { name: 'Claude Code' }).click();
  await expect(page.getByTestId('admin-acp-models-claude-code')).toHaveCount(0);
  await expect(page.getByTestId('admin-acp-unavailable')).toHaveCount(0);
});

test('demo mode: no key, the server model answers, and the shared budget runs out', async ({
  page,
  request,
}) => {
  // Leave room for exactly two model calls.
  const login = await request.post('/api/auth/login', { data: E2E_ADMIN });
  const { token } = (await login.json()) as { token: string };
  const headers = { authorization: `Bearer ${token}` };
  const config = (await (await request.get('/api/admin/config', { headers })).json()) as {
    demoBudget: { used: number };
  };
  await request.put('/api/admin/config', {
    headers,
    data: { demoBudgetLimit: config.demoBudget.used + 2 },
  });

  await page.goto('/');
  await page.getByTestId('choose-demo').click();
  await expect(page.getByTestId('demo-banner')).toBeVisible();
  await page.getByLabel('What do you want to learn?').fill('Tides');
  await page.getByTestId('start-session').click();
  await expect(page).toHaveURL(/\/s\//);
  await expect(page.getByTestId('msg-tutor').first()).toContainText('What do you already know?');

  await answer(page, 'The moon?');
  await expect(page.getByTestId('msg-tutor').last()).toContainText('You said: The moon?');

  await answer(page, 'And the sun?');
  await expect(page.getByTestId('turn-failed')).toHaveAttribute('data-code', 'DemoQuotaExceeded');
  await expect(page.getByTestId('turn-failed')).toContainText('The demo has used up its turns');

  await request.put('/api/admin/config', { headers, data: { demoBudgetLimit: 1000 } });
});

test('a turn the server refuses keeps the answer in the box and says why', async ({ page }) => {
  await register(page);
  await connectFakeModel(page);
  await startSession(page, 'Volcanoes');

  // The only intercepted request in these tests: the server refuses this one start.
  await page.route('**/api/account/sessions/*/turns', (route) =>
    route.fulfill({
      status: 409,
      json: { error: { code: 'TurnInProgress', message: 'busy', retryable: true } },
    }),
  );
  await answer(page, 'Magma, I think');
  await expect(page.getByTestId('turn-failed')).toHaveAttribute('data-code', 'TurnInProgress');
  await expect(page.getByLabel('Your answer')).toHaveValue('Magma, I think');

  await page.unroute('**/api/account/sessions/*/turns');
  await page.getByTestId('composer-send').click();
  await expect(page.getByTestId('msg-tutor').last()).toContainText('You said: Magma, I think');
});

test('Stop cancels the running turn on the server; retry sends the same answer again', async ({
  page,
}) => {
  await register(page);
  const key = await connectFakeModel(page);
  await startSession(page, 'Glaciers');

  await answer(page, 'hold this one');
  await expect(page.getByTestId('msg-live')).toContainText('Thinking it over');
  await page.getByTestId('turn-stop').click();
  await expect(page.getByTestId('turn-interrupted')).toBeVisible();

  await page.getByTestId('turn-retry').click();
  await expect(page.getByTestId('msg-live')).toContainText('Thinking it over');
  await release(key);
  await expect(page.getByTestId('msg-tutor').last()).toHaveText(/and here is the answer\./);
  await expect(page.getByTestId('turn-interrupted')).toHaveCount(0);
});
