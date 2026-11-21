// Browser tests of the guest UI (plan step 7) on the production SSR build. `/api/turns` is replaced
// with a fake server (e2e/fake-server.ts) by route interception: the page, the local DB (OPFS in a
// Worker), the turn flow and the Markdown renderer all run for real; no model is called.
import { expect, test, type Page } from '@playwright/test';
import { TUTOR_RICH_TEXT, mockTurns, sse } from './fake-server';

test.use({ locale: 'en-US' });

const KEY = 'sk-test-0123456789abcdef';

/** Saves provider, model and key on the settings screen. */
async function saveSettings(page: Page) {
  await page.goto('/settings');
  await page.getByLabel('Model').fill('claude-test');
  await page.getByLabel('API key').fill(KEY);
  await page.getByTestId('save-settings').click();
  await expect(page.getByTestId('settings-message')).toContainText('Saved');
}

/** Creates a session from the home screen and waits for the first tutor message. */
async function startSession(page: Page, topic = 'Fractions') {
  await page.goto('/');
  await page.getByLabel('What do you want to learn?').fill(topic);
  await page.getByTestId('start-session').click();
  await expect(page).toHaveURL(/\/s\//);
  await expect(page.getByTestId('session-topic')).toHaveText(topic);
}

const answer = async (page: Page, text: string) => {
  await page.getByLabel('Your answer').fill(text);
  await page.getByTestId('composer-send').click();
};

const tutorMessages = (page: Page) => page.getByTestId('msg-tutor');

test('a session goes from probing to done, with the plan, a skipped step and safe Markdown', async ({
  page,
}) => {
  const outside: string[] = [];
  page.on('request', (request) => {
    if (/\.invalid/.test(request.url())) outside.push(request.url());
  });
  const server = await mockTurns(page);
  await saveSettings(page);
  await startSession(page);

  // The Prober speaks first, without the learner typing anything.
  await expect(tutorMessages(page)).toHaveCount(1);
  await expect(tutorMessages(page).first()).toContainText('What do you already know?');
  await expect(page.getByTestId('plan-phase')).toHaveText('Getting to know what you already know');

  // The answer ends probing; the planning turn starts by itself and writes the plan.
  await answer(page, 'Not much');
  await expect(page.getByTestId('plan-steps')).toBeVisible();
  await expect(page.getByTestId('plan-step-one')).toHaveAttribute('data-status', 'current');
  await expect(page.getByTestId('plan-step-two')).toHaveAttribute('data-status', 'waiting');
  // 1 first question + 1 assessment + 1 plan = 3 requests, the third with empty input
  expect(server.requests).toHaveLength(3);
  expect(server.requests[2]!.log.at(-1)).toMatchObject({ _tag: 'TurnStarted', input: '' });
  // the key travels in the request body and nowhere else
  expect(server.requests.every((r) => r.model.apiKey === KEY)).toBe(true);

  // Markdown from the model: a formula renders, the image and links are constrained.
  const plan = tutorMessages(page).filter({ hasText: 'Energy is' });
  await expect(plan.locator('.katex').first()).toBeVisible();
  await expect(plan.locator('.katex-display')).toHaveCount(1);
  await expect(plan.locator('img')).toHaveCount(0);
  await expect(plan).toContainText('image not loaded: tracking pixel');
  const link = plan.getByRole('link', { name: /docs/ });
  await expect(link).toHaveAttribute('href', 'https://docs.invalid/guide');
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', /noopener/);
  await expect(plan.getByRole('link', { name: /mail/ })).toHaveCount(0);
  await expect(plan).toContainText('mail');
  expect(TUTOR_RICH_TEXT).toContain('tracker.invalid'); // the text really asks for the image

  // M = 6 turns on a step without finishing it unlock "skip".
  await expect(page.getByTestId('skip-step')).toHaveCount(0);
  for (let i = 0; i < 6; i++) {
    await answer(page, `try ${i}`);
    await expect(page.getByTestId('composer-send')).toBeDisabled(); // empty again after sending
    await expect(page.getByText(`try ${i}`)).toBeVisible();
    await expect(page.getByTestId('msg-live')).toHaveCount(0);
  }
  await expect(page.getByTestId('skip-step')).toBeVisible();
  await page.getByTestId('skip-step').click();
  await expect(page.getByTestId('plan-step-one')).toHaveAttribute('data-status', 'skipped');
  await expect(page.getByTestId('plan-step-two')).toHaveAttribute('data-status', 'current');

  await answer(page, 'ok');
  await expect(page.getByTestId('lesson-done')).toBeVisible();
  await expect(page.getByTestId('plan-step-two')).toHaveAttribute('data-status', 'done');
  await expect(page.getByTestId('composer-send')).toHaveCount(0);
  expect(outside).toEqual([]);

  // Reload after done: everything is still there.
  await page.reload();
  await expect(page.getByTestId('lesson-done')).toBeVisible();
  await expect(page.getByTestId('plan-step-one')).toHaveAttribute('data-status', 'skipped');
  await expect(page.getByTestId('plan-step-two')).toHaveAttribute('data-status', 'done');
  await expect(page.getByText('try 5')).toBeVisible();
  await expect(plan.locator('.katex').first()).toBeVisible();

  // and the session is in the list
  await page.getByTestId('nav-home').click();
  await expect(page.getByTestId('session-item')).toHaveCount(1);
  await expect(page.getByTestId('session-item')).toContainText('Fractions');
});

test('reload in the middle of a turn shows it as interrupted, and retry sends the same answer', async ({
  page,
}) => {
  let hang = false;
  const server = await mockTurns(page, (request) => {
    // A request that never ends: the page is reloaded while the turn is in flight.
    if (hang && request.log.at(-1)?._tag === 'TurnStarted') return new Promise(() => undefined);
    return undefined;
  });
  await saveSettings(page);
  await startSession(page);
  await expect(tutorMessages(page)).toHaveCount(1);

  hang = true;
  await answer(page, 'my careful answer');
  await expect(page.getByTestId('msg-user')).toContainText('my careful answer');
  await expect.poll(() => server.requests.length).toBe(2);

  await page.reload();
  await expect(page.getByTestId('turn-interrupted')).toBeVisible();
  // the learner's answer was written before the request, so it survived
  await expect(page.getByTestId('msg-user')).toContainText('my careful answer');
  await expect(page.getByTestId('composer-send')).toBeDisabled();
  expect(server.requests).toHaveLength(2); // nothing resent by itself

  hang = false;
  await page.getByTestId('turn-retry').click();
  await expect(page.getByTestId('turn-interrupted')).toHaveCount(0);
  await expect(page.getByTestId('plan-steps')).toBeVisible();
  // the retry carried the same input once, and the answer shows once
  expect(server.requests[2]!.log.at(-1)).toMatchObject({
    _tag: 'TurnStarted',
    input: 'my careful answer',
  });
  await expect(page.getByTestId('msg-user').filter({ hasText: 'my careful answer' })).toHaveCount(
    1,
  );
});

test('a lost connection keeps the turn open and offers a retry', async ({ page }) => {
  let down = false;
  await mockTurns(page, async (request, route) => {
    if (down && request.log.at(-1)?._tag === 'TurnStarted') {
      await route.abort('connectionreset');
      return 'handled';
    }
    return undefined;
  });
  await saveSettings(page);
  await startSession(page);
  await expect(tutorMessages(page)).toHaveCount(1);

  down = true;
  await answer(page, 'hello?');
  await expect(page.getByTestId('turn-failed')).toHaveAttribute('data-code', 'Network');
  down = false;
  await page.getByTestId('turn-retry').click();
  await expect(page.getByTestId('plan-steps')).toBeVisible();
});

test('a turn running in another tab is not sent twice', async ({ page, context }) => {
  let hang = false;
  const server = await mockTurns(page, (request) => {
    if (hang && request.log.at(-1)?._tag === 'TurnStarted') return new Promise(() => undefined);
    return undefined;
  });
  await saveSettings(page);
  await startSession(page);
  await expect(tutorMessages(page)).toHaveCount(1);
  hang = true;
  await answer(page, 'slow answer');
  await expect.poll(() => server.requests.length).toBe(2);

  const other = await context.newPage();
  const otherServer = await mockTurns(other);
  await other.goto(page.url());
  await expect(other.getByTestId('turn-elsewhere')).toBeVisible();
  await expect(other.getByTestId('turn-retry')).toHaveCount(0);
  await expect(other.getByTestId('composer-send')).toBeDisabled();
  expect(otherServer.requests).toHaveLength(0);
});

test('server errors say what to do next', async ({ page }) => {
  let tooLarge = false;
  await mockTurns(page, async (request, route) => {
    if (!tooLarge || request.log.at(-1)?._tag !== 'TurnStarted') return undefined;
    await route.fulfill({
      status: 413,
      contentType: 'application/json',
      body: JSON.stringify({
        error: { code: 'HistoryTooLarge', message: 'x', retryable: false },
      }),
    });
    return 'handled';
  });
  await saveSettings(page);
  await startSession(page);
  await expect(tutorMessages(page)).toHaveCount(1);

  tooLarge = true;
  await answer(page, 'one');
  const failed = page.getByTestId('turn-failed');
  await expect(failed).toHaveAttribute('data-code', 'HistoryTooLarge');
  await expect(failed).toContainText('Start a new session');
  await expect(failed.getByRole('button', { name: 'Start a new session' })).toBeVisible();
  // the failure is part of the log: it is still there after a reload
  await page.reload();
  await expect(page.getByTestId('turn-failed')).toHaveAttribute('data-code', 'HistoryTooLarge');
  await expect(page.getByTestId('turn-retry')).toHaveCount(0);
});

test('an endpoint that is gone sends the learner to settings', async ({ page }) => {
  await mockTurns(page, async (request, route) => {
    if (request.log.at(-1)?._tag !== 'TurnStarted') return undefined;
    await route.fulfill({
      status: 400,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'UnknownEndpoint', message: 'x', retryable: false } }),
    });
    return 'handled';
  });
  await saveSettings(page);
  await startSession(page);
  await expect(page.getByTestId('turn-failed')).toHaveAttribute('data-code', 'UnknownEndpoint');
  await page.getByRole('button', { name: 'Open settings' }).first().click();
  await expect(page).toHaveURL(/\/settings/);
});

test('without a key nothing is sent or written', async ({ page }) => {
  const server = await mockTurns(page);
  await startSession(page);
  await expect(page.getByTestId('turn-failed')).toHaveAttribute('data-code', 'NoKey');
  expect(server.requests).toHaveLength(0);
  // still no TurnStarted after a reload: opening the session did not write anything
  await page.reload();
  await expect(page.getByTestId('turn-failed')).toHaveAttribute('data-code', 'NoKey');
  expect(server.requests).toHaveLength(0);
  await expect(page.getByTestId('turn-interrupted')).toHaveCount(0);
});

test('the side chat answers about the current step and keeps out of the lesson', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  const server = await mockTurns(page);
  await saveSettings(page);
  await startSession(page);
  await answer(page, 'Not much');
  await expect(page.getByTestId('plan-steps')).toBeVisible();

  const side = page.getByTestId('side-chat');
  await expect(side.getByTestId('side-step')).toContainText('First idea');
  await side.getByLabel('Your question').fill('What is a fraction?');
  await side.getByTestId('side-send').click();
  await expect(side.getByTestId('side-messages')).toContainText('Short side answer.');
  const request = server.requests.at(-1)!;
  expect(request.turn).toEqual({ kind: 'side', threadId: 'step:one' });
  expect(request.log.at(-1)).toMatchObject({
    role: 'user',
    content: 'What is a fraction?',
    stepId: 'one',
  });
  // the question is not in the main conversation
  await expect(page.getByTestId('conversation')).not.toContainText('What is a fraction?');

  await page.reload();
  await expect(page.getByTestId('side-chat')).toContainText('What is a fraction?');
  await expect(page.getByTestId('side-chat')).toContainText('Short side answer.');
});

test('on a phone the plan folds away, the side chat is a drawer and nothing overflows', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 780 });
  await mockTurns(page);
  await saveSettings(page);
  await startSession(page);
  await answer(page, 'Not much');
  await expect(tutorMessages(page).last()).toContainText('Energy is');

  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.getByRole('button', { name: 'Plan' }).click();
  await expect(page.getByTestId('plan-step-one')).toBeVisible();

  await page.getByTestId('side-open').click();
  const side = page.getByTestId('side-chat');
  await expect(side).toBeVisible();
  await side.getByLabel('Your question').fill('Quick question');
  await side.getByTestId('side-send').click();
  await expect(side).toContainText('Short side answer.');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test('settings: save, keep after reload, delete the key', async ({ page }) => {
  await page.goto('/settings');
  // the OpenAI-compatible choice only exists when the server offers an endpoint
  await page.getByTestId('provider').click();
  await expect(page.getByRole('option', { name: 'Anthropic' })).toBeVisible();
  await expect(page.getByRole('option', { name: 'OpenAI-compatible' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('not-persistent')).toHaveCount(0);

  // an empty form is refused
  await page.getByLabel('Model').fill('');
  await page.getByTestId('save-settings').click();
  await expect(page.getByTestId('settings-message')).toContainText('Enter a model and a key');
  await expect(page.getByTestId('delete-key')).toHaveCount(0);

  await page.getByLabel('Model').fill('claude-test');
  await page.getByLabel('API key').fill(KEY);
  await expect(page.getByLabel('API key')).toHaveAttribute('type', 'password');
  await page.getByTestId('save-settings').click();
  await expect(page.getByTestId('settings-message')).toContainText('Saved');
  await expect(page.getByTestId('delete-key')).toBeVisible();

  await page.reload();
  await expect(page.getByLabel('Model')).toHaveValue('claude-test');
  await expect(page.getByTestId('delete-key')).toBeVisible();
  // the key is not shown back; the screen only says one is saved
  await expect(page.getByLabel('API key')).toHaveValue('');
  await expect(page.getByText('A key is saved on this device')).toBeVisible();

  // saving again without typing the key keeps it
  await page.getByLabel('Model').fill('claude-test-2');
  await page.getByTestId('save-settings').click();
  await expect(page.getByTestId('settings-message')).toContainText('Saved');
  await expect(page.getByTestId('delete-key')).toBeVisible();

  await page.getByTestId('delete-key').click();
  await expect(page.getByTestId('settings-message')).toContainText('Key deleted');
  await expect(page.getByTestId('delete-key')).toHaveCount(0);
  await page.reload();
  await expect(page.getByLabel('Model')).toHaveValue('claude-test-2');
  await expect(page.getByTestId('delete-key')).toHaveCount(0);

  // home asks for a key again
  await page.goto('/');
  await expect(page.getByTestId('need-key')).toBeVisible();
});

test('the endpoint choice appears when the server offers endpoints', async ({ page }) => {
  await page.route('**/api/endpoints', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ endpoints: [{ id: 'acme', label: 'Acme AI' }] }),
    }),
  );
  await page.goto('/settings');
  await page.getByTestId('provider').click();
  await page.getByRole('option', { name: 'OpenAI-compatible' }).click();
  await page.getByTestId('endpoint').click();
  await page.getByRole('option', { name: 'Acme AI' }).click();
  await page.getByLabel('Model').fill('some-model');
  await page.getByLabel('API key').fill(KEY);
  await page.getByTestId('save-settings').click();
  await expect(page.getByTestId('settings-message')).toContainText('Saved');
  await page.reload();
  await expect(page.getByTestId('endpoint')).toContainText('Acme AI');
});

// Keeps `sse` referenced: it is the helper other specs use to hand-build streams.
test('the fake server speaks the real frame format', () => {
  expect(sse([{ _tag: 'done', outcome: 'completed' }])).toBe(
    'event: done\ndata: {"_tag":"done","outcome":"completed"}\n\n',
  );
});
