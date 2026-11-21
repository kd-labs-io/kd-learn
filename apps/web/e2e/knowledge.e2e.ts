// Extraction against the production build and the fake model (e2e/fake-openai.ts), which answers
// structured output and tool calls. Nothing is intercepted: the real server, its TanStack adapter
// and the agent run; only the model is replaced.
import { expect, test, type APIRequestContext } from '@playwright/test';
import { accountsPort, fakeModelPort } from './accounts-env';

const base = `http://localhost:${accountsPort}`;
const unique = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

let address = 0;
const headers = (info: { workerIndex: number }) => {
  address += 1;
  return { 'x-forwarded-for': `10.${200 + (info.workerIndex % 50)}.${address % 250}.7` };
};

const callsOf = async (key: string) =>
  (
    (await (
      await fetch(`http://localhost:${fakeModelPort}/calls/${encodeURIComponent(key)}`)
    ).json()) as { calls: number }
  ).calls;

/** The JSON of each SSE message of a response body. */
const frames = (text: string) =>
  text
    .split('\n\n')
    .map((block) => block.split('\n').find((line) => line.startsWith('data: ')))
    .filter((line): line is string => line !== undefined)
    .map((line) => JSON.parse(line.slice(6)) as { _tag: string } & Record<string, unknown>);

const sessionLog = (sessionId: string) => [
  {
    _tag: 'SessionCreated',
    id: `${sessionId}-1`,
    at: 1,
    sessionId,
    topic: 'Binary search',
    profile: {
      id: 'default',
      language: 'en',
      maxProbeQuestions: 4,
      maxTurnsPerStep: 6,
      prompts: { prober: 'p', teacher: 't', sideChat: 's' },
    },
  },
  { _tag: 'TurnStarted', id: `${sessionId}-2`, at: 2, turnId: 't1', input: 'Hi' },
  {
    _tag: 'MessageAppended',
    id: `${sessionId}-3`,
    at: 3,
    turnId: 't1',
    messageId: 'm1',
    agent: 'teacher',
    content: 'Binary search needs a sorted array.',
  },
  { _tag: 'TurnCompleted', id: `${sessionId}-4`, at: 4, turnId: 't1', reason: 'stop' },
];

test('the guest extraction route returns a valid batch from the fake model', async ({
  request,
}) => {
  const key = `guest-${unique()}-0123456789`;
  const model = {
    provider: 'openai-compatible',
    endpointId: 'fake',
    model: 'fake-model',
    apiKey: key,
  };
  const response = await request.post(`${base}/api/knowledge/extract`, {
    data: { model, extractionId: 'x1', log: sessionLog('s1'), slice: [] },
  });
  expect(response.status()).toBe(200);
  const body = frames(await response.text());
  expect(body.map((f) => f._tag)).toEqual(['result', 'done']);
  const events = (
    body[0] as unknown as { events: Array<{ _tag: string } & Record<string, unknown>> }
  ).events;
  expect(events.map((e) => e._tag)).toEqual([
    'PropositionAdded',
    'PropositionAdded',
    'EdgeAdded',
    'SessionExtracted',
  ]);
  expect(events.at(-1)).toMatchObject({
    sessionId: 's1',
    extractionId: 'x1',
    profileId: 'default',
  });
  // No candidate in an empty slice: extractor and auditor only, one provider call each.
  expect(await callsOf(key)).toBe(2);

  // With a slice, merge runs too: three calls.
  const again = await request.post(`${base}/api/knowledge/extract`, {
    data: {
      model,
      extractionId: 'x2',
      log: sessionLog('s2'),
      slice: [{ propositionId: 'old', text: 'Fake claim states the basics.', topic: 'Search' }],
    },
  });
  expect(frames(await again.text()).map((f) => f._tag)).toEqual(['result', 'done']);
  expect(await callsOf(key)).toBe(5);
});

/** Signs up, connects the fake model for every role, and returns an account API caller. */
async function account(request: APIRequestContext, extra: Record<string, string>) {
  const registered = await request.post(`${base}/api/auth/register`, {
    headers: extra,
    data: { email: `learner-${unique()}@e2e.test`, password: 'learner-password-1' },
  });
  expect(registered.status()).toBe(201);
  const { token } = (await registered.json()) as { token: string };
  const call = async (method: string, path: string, data?: unknown) => {
    const response = await request.fetch(`${base}/api/account/${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...extra },
      ...(data === undefined ? {} : { data }),
    });
    return { status: response.status(), json: (await response.json().catch(() => ({}))) as never };
  };
  const key = `acct-${unique()}-0123456789`;
  const connection = (await call('POST', 'connections', {
    label: 'Fake',
    provider: 'openai-compatible',
    endpointId: 'fake',
    apiKey: key,
  })) as { json: { id: string } };
  const role = { connectionId: connection.json.id, model: 'fake-model' };
  await call('PUT', 'roles', { roles: { prober: role, teacher: role, sideChat: role } });
  return { call, key };
}

test('an account session completed by a turn is extracted on the server by itself', async ({
  request,
}, info) => {
  const { call } = await account(request, headers(info));
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
  // The assessment is a tool call; the server chains the planning turn, which calls create_plan.
  expect(
    (await call('POST', `sessions/${id}/turns`, { kind: 'send', input: '#assess' })).status,
  ).toBe(202);
  await expect.poll(tags).toContain('PlanCreated');
  await idle();
  expect(
    (await call('POST', `sessions/${id}/turns`, { kind: 'send', input: '#done' })).status,
  ).toBe(202);
  await expect.poll(tags).toContain('SessionCompleted');

  await expect
    .poll(async () => {
      const list = (await call('GET', 'knowledge/extractions')) as {
        json: { sessions: Array<{ sessionId: string; state: string }> };
      };
      return list.json.sessions.find((s) => s.sessionId === id)?.state;
    })
    .toBe('extracted');
  // Extracted once: asking again is refused.
  expect((await call('POST', 'knowledge/extractions', { sessionId: id })).status).toBe(409);
});
