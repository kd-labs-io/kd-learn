// Learning sources in the browser (phase 4 step 10), in guest mode (local DB) and account mode
// (server), against the production build, the fake model and the fake SearXNG. Notes and PDFs are
// read for real (pdf.js in the tab, or the server's reader); a turn whose input has `#cite` gets an
// answer citing [S1] when the turn carries excerpts.
import { expect, test, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { accountsPort } from './accounts-env';

test.use({ locale: 'en-US', baseURL: `http://localhost:${accountsPort}` });
test.describe.configure({ timeout: 90_000 });

const unique = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const pdfPath = fileURLToPath(
  new URL('../../../packages/server/test/fixtures/pdf/vi-5pages.pdf', import.meta.url),
);

let address = 0;
test.beforeEach(async ({ context }, info) => {
  address += 1;
  await context.setExtraHTTPHeaders({
    'x-forwarded-for': `10.${150 + (info.workerIndex % 50)}.${address % 250}.11`,
  });
});

const note = (name: string, text: string) => ({
  name,
  mimeType: 'text/markdown',
  buffer: Buffer.from(text, 'utf-8'),
});

/** Closes the open drawer and waits until it is gone (the page behind is inert until then). */
async function closeDrawer(page: Page) {
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

const notesText = (topic: string) =>
  `# ${topic}\n\nTides rise and fall twice a day because of the moon's gravity.\n\n## Spring tides\n\nWhen the sun and the moon line up, the tides are larger.\n`;

async function addNotes(page: Page, title: string, topic: string) {
  await page.getByTestId('nav-sources').click();
  await expect(page.getByRole('heading', { name: 'Learning sources' })).toBeVisible();
  await page
    .locator('input[type=file][multiple]')
    .setInputFiles([note(`${title}.md`, notesText(topic))]);
  const row = page.getByTestId('source-row').filter({ hasText: title });
  await expect(row).toHaveAttribute('data-state', 'ready');
  await row.getByTestId('source-view').click();
  await expect(page.getByTestId('source-chunk').first()).toContainText('moon');
  await closeDrawer(page);
}

async function research(page: Page, question: string) {
  await page.getByLabel('Research the web').fill(question);
  await page.getByTestId('sources-research-start').click();
  const row = page.getByTestId('source-row').filter({ hasText: question });
  await expect(row).toHaveAttribute('data-state', 'ready', { timeout: 20_000 });
  await expect(row).toContainText('Web research');
}

/** Starts a lesson with the source `title` attached, then a turn that cites it opens the chunk. */
async function learnWithSource(page: Page, topic: string, title: string, url: RegExp) {
  await page.getByTestId('nav-home').click();
  await page.getByLabel('What do you want to learn?').fill(topic);
  await page.getByTestId('home-source').filter({ hasText: title }).click();
  await page.getByTestId('start-session').click();
  await expect(page).toHaveURL(url);
  await expect(page.getByTestId('lesson-sources-open')).toHaveText('Sources (1)');
  await expect(page.getByTestId('msg-tutor').first()).toContainText('What do you already know?');

  await page.getByLabel('Your answer').fill('Tell me about the moon #cite');
  await page.getByTestId('composer-send').click();
  await expect(page.getByTestId('msg-tutor').last()).toContainText('From your own source [S1].');
  const citation = page.getByTestId('citation').first();
  await expect(citation).toContainText(title);
  await citation.click();
  await expect(page.getByTestId('source-chunk').first()).toBeVisible();
  await closeDrawer(page);

  // Detach from the lesson panel: the next turn has no excerpts, so no citation.
  await page.getByTestId('lesson-sources-open').click();
  await page.getByTestId('lesson-source').filter({ hasText: title }).click();
  await expect(page.getByTestId('lesson-sources-open')).toHaveText('Sources (0)');
  await closeDrawer(page);
  await expect(page.getByTestId('lesson-sources-open')).toHaveText('Sources (0)');
}

test('guest: notes and a web research become sources; a lesson cites them', async ({ page }) => {
  const key = `sources-guest-${unique()}-0123456789`;
  const title = `Tides ${unique()}`;
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

  await addNotes(page, title, 'Tides');
  // A PDF is read in this tab (pdf.js), with page locators.
  await page.locator('input[type=file]:not([multiple])').setInputFiles(pdfPath);
  const pdf = page.getByTestId('source-row').filter({ hasText: 'vi-5pages' });
  await expect(pdf).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
  await pdf.getByTestId('source-view').click();
  await expect(page.getByTestId('source-chunk').first()).toContainText('Page 1');
  await closeDrawer(page);
  await research(page, `Moon phases ${unique()}`);
  // The key never shows on the page.
  await expect(page.locator('body')).not.toContainText(key);

  await learnWithSource(page, 'Tides', title, /\/s\//);

  // Delete from the library: the row goes.
  await page.getByTestId('nav-home').click();
  await page.getByTestId('nav-sources').click();
  const row = page.getByTestId('source-row').filter({ hasText: title });
  await row.getByTestId('source-delete').click();
  await expect(row).toHaveCount(0);
});

test('account: a PDF and notes on the server; a lesson cites them', async ({ page }) => {
  const key = `sources-acct-${unique()}-0123456789`;
  const email = `sources-${unique()}@e2e.test`;
  await page.goto('/register');
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
  await expect(page.getByTestId('connection-item')).toContainText(key.slice(-4));
  await page.getByTestId('role-prober-connection').click();
  await page.getByRole('option', { name: 'Fake' }).click();
  await page.getByTestId('role-prober-model').fill('fake-model');
  await page.getByTestId('roles-copy').click();
  await page.getByTestId('roles-save').click();
  await expect(page.getByTestId('roles-message')).toContainText('Saved');

  // A PDF is read on the server: pending, then ready with page locators.
  await page.getByTestId('nav-sources').click();
  await page.locator('input[type=file]:not([multiple])').setInputFiles(pdfPath);
  const pdf = page.getByTestId('source-row').filter({ hasText: 'vi-5pages' });
  await expect(pdf).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
  await pdf.getByTestId('source-view').click();
  await expect(page.getByTestId('source-chunk').first()).toContainText('Page 1');
  await closeDrawer(page);

  const title = `Tides ${unique()}`;
  await addNotes(page, title, 'Tides');
  await research(page, `Moon phases ${unique()}`);
  await learnWithSource(page, 'Tides', title, /\/a\//);
});
