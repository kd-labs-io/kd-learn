// Browser test of the teaching profile screen in account mode (phase 3 step 11), against the
// production build with accounts on. The profile is saved on the server; the new session's
// snapshot (`GET /api/account/sessions/:id`) must hold the edited profile.
import { expect, test, type Page } from '@playwright/test';
import { accountsPort } from './accounts-env';

test.use({ locale: 'en-US', baseURL: `http://localhost:${accountsPort}` });

const unique = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

let address = 0;
/** A client address of its own, outside the range of accounts.e2e.ts. */
test.beforeEach(async ({ context }, info) => {
  address += 1;
  await context.setExtraHTTPHeaders({
    'x-forwarded-for': `11.${info.workerIndex % 250}.${(address >> 8) % 250}.${address % 250}`,
  });
});

const prompt = (page: Page, name: string) => page.getByRole('textbox', { name, exact: true });
/** A field's own status message (the live region repeats it for screen readers). */
const fieldStatus = (page: Page, text: string) =>
  page.locator('.astryx-field-status').filter({ hasText: text });

test('account: duplicate the default profile, edit a prompt, and a new session snapshots it', async ({
  page,
}) => {
  await page.goto('/register');
  const email = `profile-${unique()}@e2e.test`;
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('learner-password-1');
  await page.getByTestId('auth-submit').click();
  await expect(page.getByTestId('who')).toHaveText(email);

  // A connection to the fake model for every role.
  await page.getByTestId('nav-settings').click();
  await page.getByTestId('connection-provider').click();
  await page.getByRole('option', { name: 'OpenAI-compatible' }).click();
  await page.getByTestId('connection-endpoint').click();
  await page.getByRole('option', { name: 'Fake model' }).click();
  await page.getByLabel('API key').fill(`key-${unique()}-0123456789`);
  await page.getByLabel('Name').fill('Fake');
  await page.getByTestId('connection-save').click();
  await expect(page.getByTestId('connection-item')).toBeVisible();
  await page.getByTestId('role-prober-connection').click();
  await page.getByRole('option', { name: 'Fake' }).click();
  await page.getByTestId('role-prober-model').fill('fake-model');
  await page.getByTestId('roles-copy').click();
  await page.getByTestId('roles-save').click();
  await expect(page.getByTestId('roles-message')).toContainText('Saved');

  await page.getByTestId('profile-link').click();
  await expect(page).toHaveURL(/\/profile$/);
  await expect(prompt(page, 'Prober')).not.toBeEditable();
  await page.getByTestId('profile-duplicate').click();

  // An empty prompt is blocked.
  await prompt(page, 'Side chat').fill('');
  await expect(page.getByTestId('profile-save')).toBeDisabled();
  await expect(prompt(page, 'Side chat')).toHaveAttribute('aria-invalid', 'true');
  await expect(fieldStatus(page, 'Must not be empty, and at most 20000 characters.')).toBeVisible();
  await prompt(page, 'Side chat').fill('Answer side questions briefly.');
  await prompt(page, 'Prober').fill('MARKER-ACCOUNT: ask one short question at a time.');
  await page.getByLabel('Name').fill('My profile');
  await page.getByTestId('profile-save').click();
  await expect(page.getByTestId('profile-message')).toContainText('Profile saved');

  // Saved on the server: a reload reads it back.
  await page.reload();
  await expect(page.getByLabel('Name')).toHaveValue('My profile');
  await expect(prompt(page, 'Prober')).toHaveValue(/MARKER-ACCOUNT/);

  await page.getByTestId('nav-home').click();
  await page.getByLabel('What do you want to learn?').fill('Fractions');
  const snapshot = page.waitForResponse(
    (response) =>
      response.request().method() === 'GET' &&
      /\/api\/account\/sessions\/[^/?]+$/.test(new URL(response.url()).pathname),
  );
  await page.getByTestId('start-session').click();
  await expect(page).toHaveURL(/\/a\//);
  const body = (await (await snapshot).json()) as {
    events: ReadonlyArray<{ event: { _tag: string; profile?: Record<string, unknown> } }>;
  };
  const created = body.events[0]!.event;
  expect(created._tag).toBe('SessionCreated');
  expect(created.profile?.['id']).not.toBe('default');
  expect(created.profile?.['name']).toBe('My profile');
  expect((created.profile?.['prompts'] as Record<string, string>)['prober']).toContain(
    'MARKER-ACCOUNT',
  );
  // The fake model answered the first turn, run with the edited Prober prompt.
  await expect(page.getByTestId('msg-tutor').first()).toContainText('What do you already know?');

  await page.goto('/profile');
  await page.getByTestId('profile-reset').click();
  await expect(page.getByTestId('profile-message')).toContainText('Back to the default');
  await expect(page.getByTestId('profile-duplicate')).toBeVisible();
});
