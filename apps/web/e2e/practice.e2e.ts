// Browser tests of the practice screen (phase 3 step 10) against the production build, the server
// with accounts on and the fake model (e2e/fake-openai.ts), which writes and grades exercises.
// Nothing is intercepted: the real practice routes, Practitioner and adapter run.
// - Guest: the graph is seeded in the local knowledge log through /dev/storage (one exercise of
//   each type), with the fake endpoint as the guest's own model.
// - Account: the graph comes from a session run to the end and extracted on the server.
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { practiceSeed } from '../src/practice/fixtures';
import { accountsPort } from './accounts-env';

const base = `http://localhost:${accountsPort}`;
test.use({ locale: 'en-US', baseURL: base });

const unique = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

let address = 0;
/** A client address of its own, outside the ranges of the other account tests. */
const forwarded = (info: { workerIndex: number }) => {
  address += 1;
  return {
    'x-forwarded-for': `12.${info.workerIndex % 250}.${(address >> 8) % 250}.${address % 250}`,
  };
};

const exercise = (page: Page, type: string) =>
  page.locator(`[data-testid="exercise"][data-type="${type}"]`);

/** Answers the exercise of `type`; `text` for the types graded by the model. */
async function answer(page: Page, type: string, text = 'Because it follows.') {
  const card = exercise(page, type);
  if (type === 'multipleChoice') {
    await card.getByText(/^Fake right option/).click();
  } else if (type === 'shortAnswer' || type === 'explainReasoning') {
    await card.getByRole('textbox', { name: 'Your answer' }).fill(text);
  }
  await card.getByTestId('exercise-submit').click();
  await expect(card.getByTestId('exercise-grade')).toBeVisible();
}

test('guest: practise a set drawn from the graph, mastery follows the grade, a reload keeps it', async ({
  page,
  browserName,
}) => {
  // The seeded graph lives in the guest database; without OPFS (WebKit's test context) it falls
  // back to memory and is gone after the next navigation (phase 6 step 5). Real Safari has OPFS.
  test.skip(
    browserName === 'webkit',
    'No OPFS in this browser context: storage falls back to memory',
  );
  await page.addInitScript(() => localStorage.setItem('kd-learn.mode', 'guest'));
  await page.goto('/practice');
  await expect(page.getByTestId('practice-empty')).toBeVisible();

  await page.goto('/dev/storage');
  await expect(page.locator('#storage-state')).toHaveText('ready');
  await page.evaluate(
    ([key, seed]) =>
      Promise.all([
        window.__kdStorage!.saveSettings({
          provider: 'openai-compatible',
          endpointId: 'fake',
          model: 'fake-model',
          apiKey: key,
        }),
        window.__kdStorage!.appendKnowledge(seed, -1),
      ]),
    [`guest-${unique()}-0123456789`, practiceSeed(Date.now() - 60_000)] as const,
  );

  await page.goto('/');
  await page.getByTestId('practice-link').click();
  await expect(page).toHaveURL(/\/practice$/);
  await page.getByTestId('practice-start').click();
  await expect(page.getByTestId('exercise')).toHaveCount(4);
  for (const type of ['orderChain', 'explainReasoning', 'multipleChoice', 'shortAnswer']) {
    await expect(exercise(page, type)).toHaveCount(1);
  }
  const practiceId = await page.getByTestId('practice').getAttribute('data-practice-id');

  // Graded by code on the client: right, so the proposition moves up to box 2.
  await answer(page, 'multipleChoice');
  const mc = exercise(page, 'multipleChoice');
  await expect(mc.getByTestId('exercise-grade')).toContainText('Correct');
  await expect(mc.getByTestId('exercise-solution')).toContainText('Fake right option');
  await expect(mc.getByTestId('exercise-mastery')).toContainText('box 2 of 5');

  // Graded by the model through the server: wrong, so box 1.
  await answer(page, 'shortAnswer', 'No idea #wrong');
  const sa = exercise(page, 'shortAnswer');
  await expect(sa.getByTestId('exercise-grade')).toContainText('Not correct');
  await expect(sa.getByTestId('exercise-feedback')).toHaveText('Fake feedback: incorrect.');
  await expect(sa.getByTestId('exercise-mastery')).toContainText('box 1 of 5');
  await expect(page.getByTestId('practice-progress')).toHaveText('2 of 4 graded');

  // A reload mid-set keeps the practice, its exercises and the answers.
  await page.reload();
  await expect(page.getByTestId('practice')).toHaveAttribute('data-practice-id', practiceId!);
  await expect(page.getByTestId('exercise')).toHaveCount(4);
  await expect(
    exercise(page, 'shortAnswer').getByRole('textbox', { name: 'Your answer' }),
  ).toHaveValue('No idea #wrong');
  await expect(exercise(page, 'multipleChoice').getByTestId('exercise-mastery')).toContainText(
    'box 2 of 5',
  );
  await expect(exercise(page, 'orderChain').getByTestId('exercise-submit')).toBeVisible();

  // The ordering as shown, moved once; any grade, with one valid order shown.
  await exercise(page, 'orderChain').getByTestId('order-down').first().click();
  await answer(page, 'orderChain');
  await expect(exercise(page, 'orderChain').getByTestId('exercise-solution')).toBeVisible();
  await answer(page, 'explainReasoning');
  await expect(exercise(page, 'explainReasoning').getByTestId('exercise-grade')).toContainText(
    'Correct',
  );
  await expect(page.getByTestId('practice-done')).toBeVisible();

  await page.getByTestId('practice-end').click();
  await expect(page.getByTestId('practice-start')).toBeVisible();
});

/** Signs up, connects the fake model and returns an account API caller and the sign-in. */
async function account(request: APIRequestContext, extra: Record<string, string>) {
  const registered = await request.post(`${base}/api/auth/register`, {
    headers: extra,
    data: { email: `practice-${unique()}@e2e.test`, password: 'learner-password-1' },
  });
  expect(registered.status()).toBe(201);
  const auth = (await registered.json()) as { token: string };
  const call = async (method: string, path: string, data?: unknown) => {
    const response = await request.fetch(`${base}/api/account/${path}`, {
      method,
      headers: { authorization: `Bearer ${auth.token}`, ...extra },
      ...(data === undefined ? {} : { data }),
    });
    return { status: response.status(), json: (await response.json().catch(() => ({}))) as never };
  };
  const connection = (await call('POST', 'connections', {
    label: 'Fake',
    provider: 'openai-compatible',
    endpointId: 'fake',
    apiKey: `acct-${unique()}-0123456789`,
  })) as { json: { id: string } };
  const role = { connectionId: connection.json.id, model: 'fake-model' };
  // No practitioner role: practice falls back to the teacher's model.
  await call('PUT', 'roles', { roles: { prober: role, teacher: role, sideChat: role } });
  return { call, auth };
}

/** Runs a session to the end; the server extracts it into the graph by itself. */
async function learnOneSession(call: Awaited<ReturnType<typeof account>>['call']) {
  const created = (await call('POST', 'sessions', { topic: 'Fractions', language: 'en' })) as {
    json: { sessionId: string };
  };
  const id = created.json.sessionId;
  const idle = () =>
    expect
      .poll(
        async () =>
          ((await call('GET', `sessions/${id}`)) as { json: { running: unknown[] } }).json.running
            .length,
      )
      .toBe(0);
  const tags = async () =>
    (
      (await call('GET', `sessions/${id}`)) as {
        json: { events: Array<{ event: { _tag: string } }> };
      }
    ).json.events.map((e) => e.event._tag);
  expect((await call('POST', `sessions/${id}/turns`, { kind: 'auto' })).status).toBe(202);
  await idle();
  expect(
    (await call('POST', `sessions/${id}/turns`, { kind: 'send', input: '#assess' })).status,
  ).toBe(202);
  await expect.poll(tags).toContain('PlanCreated');
  await idle();
  expect(
    (await call('POST', `sessions/${id}/turns`, { kind: 'send', input: '#done' })).status,
  ).toBe(202);
  await expect
    .poll(async () => {
      const list = (await call('GET', 'knowledge/extractions')) as {
        json: { sessions: Array<{ sessionId: string; state: string }> };
      };
      return list.json.sessions.find((s) => s.sessionId === id)?.state;
    })
    .toBe('extracted');
}

test('account: practise on the server graph, mastery follows the grade, a reload keeps it', async ({
  page,
  request,
}, info) => {
  const extra = forwarded(info);
  await page.context().setExtraHTTPHeaders(extra);
  const { call, auth } = await account(request, extra);
  await page.addInitScript(
    (value) => localStorage.setItem('kd-learn.auth', value),
    JSON.stringify(auth),
  );

  await page.goto('/practice');
  await expect(page.getByTestId('practice-empty')).toBeVisible();

  await learnOneSession(call);
  await page.goto('/');
  await page.getByTestId('practice-link').click();
  await page.getByTestId('practice-start').click();
  // Two propositions and one link: one exercise on the link.
  await expect(page.getByTestId('exercise')).toHaveCount(1);
  const card = exercise(page, 'explainReasoning');
  await expect(card).toContainText('Fake question');
  const practiceId = await page.getByTestId('practice').getAttribute('data-practice-id');

  // A reload before answering keeps the practice and its exercise.
  await page.reload();
  await expect(page.getByTestId('practice')).toHaveAttribute('data-practice-id', practiceId!);

  await answer(page, 'explainReasoning', 'Half right #partial');
  await expect(card.getByTestId('exercise-grade')).toContainText('Partly correct');
  await expect(card.getByTestId('exercise-feedback')).toHaveText('Fake feedback: partial.');
  // A first grade that is partly right: box 1, for both propositions of the link.
  await expect(card.getByTestId('exercise-mastery')).toHaveCount(2);
  await expect(card.getByTestId('exercise-mastery').first()).toContainText('box 1 of 5');

  await page.reload();
  await expect(card.getByTestId('exercise-grade')).toContainText('Partly correct');
  await expect(card.getByRole('textbox', { name: 'Your answer' })).toHaveValue(
    'Half right #partial',
  );
  await page.getByTestId('practice-end').click();
  await expect(page.getByTestId('practice-start')).toBeVisible();
  const list = (await call('GET', 'practice')) as {
    json: { practices: unknown[]; propositionCount: number };
  };
  expect(list.json).toEqual({ practices: [], propositionCount: 2 });
});
