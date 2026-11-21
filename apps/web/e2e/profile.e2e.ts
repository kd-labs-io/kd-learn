// Browser tests of the teaching profile screen in guest mode (phase 3 step 11). `/api/turns` is
// replaced by the fake server, so the test reads the log the page sends: its `SessionCreated`
// must hold the edited profile.
import { expect, test, type Page } from '@playwright/test';
import { mockTurns } from './fake-server';

test.use({ locale: 'en-US' });

test.skip(
  ({ browserName }) => browserName === 'webkit',
  'No OPFS in this browser context: storage falls back to memory',
);

const prompt = (page: Page, name: string) => page.getByRole('textbox', { name, exact: true });
/** A field's own status message (the live region repeats it for screen readers). */
const fieldStatus = (page: Page, text: string) =>
  page.locator('.astryx-field-status').filter({ hasText: text });

test('duplicate the default profile, edit a prompt, and a new session snapshots it', async ({
  page,
}) => {
  const turns = await mockTurns(page);
  await page.goto('/settings');
  await page.getByLabel('Model').fill('claude-test');
  await page.getByLabel('API key').fill('sk-test-0123456789abcdef');
  await page.getByTestId('save-settings').click();
  await expect(page.getByTestId('settings-message')).toContainText('Saved');

  await page.getByTestId('profile-link').click();
  await expect(page).toHaveURL(/\/profile$/);
  // The default profile is shown, read-only.
  await expect(prompt(page, 'Prober')).not.toBeEditable();
  await expect(page.getByTestId('profile-save')).toHaveCount(0);

  await page.getByTestId('profile-duplicate').click();
  await expect(page.getByLabel('Name')).toHaveValue('Default (copy)');
  await expect(prompt(page, 'Prober')).toBeEditable();

  // An empty prompt and a bad language tag are blocked, with a message on each field.
  await prompt(page, 'Teacher').fill('');
  await page.getByLabel('Language').fill('not a tag');
  await expect(page.getByTestId('profile-invalid')).toBeVisible();
  await expect(page.getByTestId('profile-save')).toBeDisabled();
  await expect(prompt(page, 'Teacher')).toHaveAttribute('aria-invalid', 'true');
  await expect(fieldStatus(page, 'Must not be empty, and at most 20000 characters.')).toBeVisible();
  await expect(page.getByLabel('Language')).toHaveAttribute('aria-invalid', 'true');
  await expect(fieldStatus(page, 'Use a language tag such as vi, en or pt-BR.')).toBeVisible();

  await prompt(page, 'Teacher').fill('Teach step by step.');
  await page.getByLabel('Language').fill('en');
  await prompt(page, 'Prober').fill('MARKER-GUEST: ask one short question at a time.');
  await expect(page.getByTestId('profile-invalid')).toHaveCount(0);
  await page.getByTestId('profile-save').click();
  await expect(page.getByTestId('profile-message')).toContainText('Profile saved');
  await expect(page.getByTestId('profile-reset')).toBeVisible();

  // Kept after a reload.
  await page.reload();
  await expect(prompt(page, 'Prober')).toHaveValue(/MARKER-GUEST/);

  await page.goto('/');
  await page.getByLabel('What do you want to learn?').fill('Fractions');
  await page.getByTestId('start-session').click();
  await expect(page).toHaveURL(/\/s\//);
  await expect.poll(() => turns.requests.length).toBeGreaterThan(0);
  const created = turns.requests[0]!.log[0]!;
  expect(created._tag).toBe('SessionCreated');
  if (created._tag !== 'SessionCreated') return;
  expect(created.profile.id).not.toBe('default');
  expect(created.profile.name).toBe('Default (copy)');
  expect(created.profile.prompts.prober).toContain('MARKER-GUEST');
  expect(created.profile.prompts.teacher).toBe('Teach step by step.');

  // Back to default: the read-only view again, and the next session snapshots the default.
  await page.goto('/profile');
  await page.getByTestId('profile-reset').click();
  await expect(page.getByTestId('profile-message')).toContainText('Back to the default');
  await expect(page.getByTestId('profile-duplicate')).toBeVisible();
  await expect(prompt(page, 'Prober')).not.toHaveValue(/MARKER-GUEST/);
});
