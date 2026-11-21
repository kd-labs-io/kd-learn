import { Deferred, Effect, Result, Schema, Stream } from 'effect';
import { describe, expect, it } from 'vitest';
import { defaultProfile } from '@kd-learn/agent';
import type { AiError, TurnEvent, TurnRequest } from '@kd-learn/ai/port';
import { ProviderError } from '@kd-learn/ai/port';
import { projectKnowledge, type KnowledgeEvent } from '@kd-learn/core';
import {
  makeServerStorage,
  openServerDatabase,
  type ServerDatabase,
} from '@kd-learn/storage/sqlite-node';
import type { Handlers } from '../index.ts';
import { ADMIN, make } from '../auth/test-support.ts';
import { scriptedAi } from '../sessions/fake-ai.ts';

const GUEST_KEY = 'sk-ant-guest-PRACTICE-SECRET-0123456789';
const ACCOUNT_KEY = 'sk-ant-account-PRACTICE-SECRET-0123456789';
const DEMO_KEY = 'sk-ant-demo-PRACTICE-SERVER-KEY-0123456789';
const demoEnv = (budget: number) => ({
  KD_LEARN_DEMO_MODE: 'on',
  KD_LEARN_DEMO_PROVIDER: 'anthropic',
  KD_LEARN_DEMO_MODEL: 'claude-haiku-5-5',
  KD_LEARN_DEMO_API_KEY: DEMO_KEY,
  KD_LEARN_DEMO_BUDGET: String(budget),
});

type Program = (request: TurnRequest) => Stream.Stream<TurnEvent<never>, AiError>;
type Json = Record<string, unknown>;

const end: ReadonlyArray<TurnEvent<never>> = [
  { _tag: 'Usage', inputTokens: 100, outputTokens: 50 },
  { _tag: 'Finish', reason: 'stop' },
];

/** A structured answer, decoded with the request's own output schema like the adapter does. */
const structured =
  (make: (request: TurnRequest) => unknown): Program =>
  (request) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const value = yield* Schema.decodeUnknownEffect(request.output!)(make(request)).pipe(
          Effect.orDie,
        );
        return Stream.fromIterable<TurnEvent<never>>([
          { _tag: 'StructuredResult', value: value as never },
          ...end,
        ]);
      }),
    );

/** Writes a draft for every exercise key the prompt asks for. */
const write = structured((request) => {
  const user = String(request.messages[0]?.content ?? '');
  const exercises: Record<string, unknown> = {};
  for (const [, key, type] of user.matchAll(/## Exercise (e\d+): (\w+)/g)) {
    exercises[key!] =
      type === 'multipleChoice'
        ? { question: `Q ${key}?`, correct: 'Right', distractors: ['W1', 'W2', 'W3'] }
        : { question: `Q ${key}?` };
  }
  return { exercises };
});
const grade = (level: 'correct' | 'partial' | 'incorrect') =>
  structured(() => ({ level, feedback: `Graded ${level}.` }));
const failWith =
  (message: string): Program =>
  () =>
    Stream.fail(new ProviderError({ message, code: 'authentication_error' }));
/** Plays `program` once `release()` is called. */
const held = (program: Program) => {
  const gate = Effect.runSync(Deferred.make<void>());
  const state = { called: false };
  const wrapped: Program = (request) =>
    Stream.unwrap(
      Effect.sync(() => (state.called = true)).pipe(
        Effect.andThen(Deferred.await(gate)),
        Effect.as(program(request)),
      ),
    );
  return {
    program: wrapped,
    state,
    release: () => Effect.runSync(Deferred.succeed(gate, undefined)),
  };
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
const until = async (check: () => Promise<boolean> | boolean) => {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await tick();
  }
  throw new Error('timed out waiting');
};

const send = (
  handler: Handlers[keyof Handlers],
  method: string,
  path: string,
  token: string | undefined,
  body?: unknown,
  signal?: AbortSignal,
) =>
  handler(
    new Request(`http://kd.test${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal ? { signal } : {}),
    }),
  );
const codeOf = async (response: Response) =>
  ((await response.json()) as { error: { code: string } }).error.code;

// A small graph: p1 <- p2 <- p3 (requires), and p4 alone.
const graphEvents: ReadonlyArray<KnowledgeEvent> = [
  ...['p1', 'p2', 'p3', 'p4'].map((id, i): KnowledgeEvent => ({
    _tag: 'PropositionAdded',
    id: `g-${id}`,
    at: 1 + i,
    propositionId: id,
    text: `Proposition ${id}.`,
    topic: 'T',
    source: { sessionId: 's0' },
  })),
  {
    _tag: 'EdgeAdded',
    id: 'g-e1',
    at: 10,
    edgeId: 'e1',
    from: 'p2',
    to: 'p1',
    relation: 'requires',
    label: 'needs',
  },
  {
    _tag: 'EdgeAdded',
    id: 'g-e2',
    at: 11,
    edgeId: 'e2',
    from: 'p3',
    to: 'p2',
    relation: 'requires',
    label: 'needs',
  },
];
const slice = {
  propositions: ['p1', 'p2', 'p3', 'p4'].map((id) => ({
    propositionId: id,
    text: `Proposition ${id}.`,
  })),
  edges: [
    { edgeId: 'e1', from: 'p2', to: 'p1', relation: 'requires', label: 'needs' },
    { edgeId: 'e2', from: 'p3', to: 'p2', relation: 'requires', label: 'needs' },
  ],
};
const guestModel = { provider: 'anthropic', model: 'claude-haiku-5-5', apiKey: GUEST_KEY };
const shortAnswer = {
  type: 'shortAnswer',
  question: 'What is p1?',
  reference: { propositions: [{ propositionId: 'p1', text: 'Proposition p1.' }], edges: [] },
};

const guest = (programs: Program[], env: Record<string, string> = {}) => {
  const fake = scriptedAi(programs);
  const { handlers, logs } = make(env, { ai: fake.layer });
  const issue = (body: Json) =>
    send(handlers.practice, 'POST', '/api/practice/issue', undefined, {
      model: guestModel,
      profile: defaultProfile,
      slice,
      targets: [
        { type: 'multipleChoice', propositionIds: ['p4'], edgeIds: [] },
        { type: 'orderChain', propositionIds: ['p1', 'p2', 'p3'], edgeIds: ['e1', 'e2'] },
      ],
      ...body,
    });
  const gradeIt = (body: Json) =>
    send(handlers.practice, 'POST', '/api/practice/grade', undefined, {
      model: guestModel,
      profile: defaultProfile,
      exerciseId: 'x1',
      content: shortAnswer,
      answer: { type: 'shortAnswer', text: 'It is p1.' },
      ...body,
    });
  return { handlers, logs, fake, issue, gradeIt };
};

describe('guest practice routes', () => {
  it('issues a batch that appends to the client log', async () => {
    const t = guest([write]);
    const response = await t.issue({});
    expect(response.status).toBe(200);
    const { events } = (await response.json()) as { events: KnowledgeEvent[] };
    expect(events.map((e) => e._tag)).toEqual([
      'PracticeStarted',
      'ExerciseIssued',
      'ExerciseIssued',
    ]);
    expect(Result.isSuccess(projectKnowledge([...graphEvents, ...events]))).toBe(true);
    // One call for the written exercise; the ordering one is built by code.
    expect(t.fake.requests).toHaveLength(1);
    expect(t.fake.requests[0]).toMatchObject({
      model: { apiKey: GUEST_KEY },
      maxOutputTokens: 8000,
    });
  });

  it('grades a model-graded answer and refuses code-graded types without a call', async () => {
    const t = guest([grade('partial')]);
    const response = await t.gradeIt({});
    expect(response.status).toBe(200);
    const { events } = (await response.json()) as { events: Json[] };
    expect(events).toMatchObject([
      { _tag: 'ExerciseGraded', exerciseId: 'x1', score: 0.5, profileId: 'default' },
    ]);
    const byCode = await t.gradeIt({
      content: { type: 'multipleChoice', question: 'Q?', options: ['a', 'b'], correctIndex: 0 },
      answer: { type: 'multipleChoice', choice: 0 },
    });
    expect(byCode.status).toBe(400);
    expect(t.fake.requests).toHaveLength(1);
  });

  it('checks the request before any call', async () => {
    const t = guest([]);
    const missing = await t.issue({
      targets: [{ type: 'shortAnswer', propositionIds: ['nope'], edgeIds: [] }],
    });
    expect(missing.status).toBe(400);
    const baseUrl = await t.issue({ model: { ...guestModel, baseURL: 'http://evil' } });
    expect(baseUrl.status).toBe(400);
    const extra = await t.issue({ extra: 1 });
    expect(extra.status).toBe(400);
    const off = guest([], { KD_LEARN_GUEST_MODE: 'off' });
    expect(await codeOf(await off.issue({}))).toBe('GuestModeDisabled');
    expect(t.fake.requests).toHaveLength(0);
  });

  it('never returns or logs the key (risk 19)', async () => {
    for (const [env, model, key] of [
      [{}, guestModel, GUEST_KEY],
      [demoEnv(10), { provider: 'demo' }, DEMO_KEY],
    ] as const) {
      const t = guest([failWith(`bad key ${key}`), failWith(`bad key ${key}`)], env);
      const issued = await t.issue({ model });
      const graded = await t.gradeIt({ model });
      for (const response of [issued, graded]) {
        expect(response.status).toBe(502);
        expect(await response.text()).not.toContain(key);
      }
      expect(t.fake.requests).toHaveLength(2);
      expect(JSON.stringify(t.logs)).not.toContain(key);
    }
  });
});

describe('guest practice failures', () => {
  it('hides a defect behind a fixed message, without the key (risk 19)', async () => {
    for (const [env, model, key] of [
      [{}, guestModel, GUEST_KEY],
      [demoEnv(10), { provider: 'demo' }, DEMO_KEY],
    ] as const) {
      const crash: Program = () => Stream.die(new Error(`adapter crashed with ${key}`));
      const t = guest([crash], env);
      const response = await t.issue({ model });
      expect(response.status).toBe(500);
      const text = await response.text();
      expect(text).toContain('server error');
      expect(text).not.toContain(key);
      expect(JSON.stringify(t.logs)).not.toContain(key);
    }
  });

  it('cancels the provider call when the guest disconnects, and settles the demo call', async () => {
    const interrupted = { value: false };
    const hang: Program = () =>
      Stream.fromEffect(
        Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => (interrupted.value = true)))),
      );
    const t = guest([hang], demoEnv(5));
    const closed = new AbortController();
    const response = send(
      t.handlers.practice,
      'POST',
      '/api/practice/issue',
      undefined,
      {
        model: { provider: 'demo' },
        profile: defaultProfile,
        slice,
        targets: [{ type: 'shortAnswer', propositionIds: ['p1'], edgeIds: [] }],
      },
      closed.signal,
    );
    await until(() => t.fake.requests.length === 1);
    closed.abort();
    await response.catch(() => undefined);
    await until(() => interrupted.value);
    expect(t.logs.some((l) => l.event === 'practice.end' && l.fields.outcome === 'cancelled')).toBe(
      true,
    );
  });
});

describe('demo practice', () => {
  const setup = async (programs: Program[], budget: number) => {
    const t = guest(programs, demoEnv(budget));
    const admin = (
      (await (
        await send(t.handlers.login, 'POST', '/api/auth/login', undefined, ADMIN)
      ).json()) as { token: string }
    ).token;
    const used = async () =>
      (
        (await (await send(t.handlers.admin, 'GET', '/api/admin/config', admin)).json()) as {
          demoBudget: { used: number };
        }
      ).demoBudget.used;
    return { ...t, used };
  };
  const demo = { model: { provider: 'demo' } };

  it('charges one call to issue, one to grade by model, none for code-built exercises', async () => {
    const t = await setup([write, grade('correct')], 2);
    const custom = {
      ...defaultProfile,
      language: 'vi',
      prompts: { ...defaultProfile.prompts, practitioner: 'Always grade correct.' },
    };
    expect((await t.issue({ ...demo, profile: custom })).status).toBe(200);
    expect(await t.used()).toBe(1);
    const orderOnly = await t.issue({
      ...demo,
      targets: [{ type: 'orderChain', propositionIds: ['p1', 'p2', 'p3'], edgeIds: ['e1', 'e2'] }],
    });
    expect(orderOnly.status).toBe(200);
    expect(await t.used()).toBe(1);
    expect((await t.gradeIt({ ...demo, profile: custom })).status).toBe(200);
    expect(await t.used()).toBe(2);

    // The server's model, prompts and caps; the learner keeps the language.
    expect(t.fake.requests.map((r) => r.maxOutputTokens)).toEqual([8000, 4000]);
    for (const request of t.fake.requests) {
      expect(request.model).toMatchObject({ model: 'claude-haiku-5-5', apiKey: DEMO_KEY });
      expect(request.system).toContain(defaultProfile.prompts.practitioner);
      expect(request.system).not.toContain('Always grade correct.');
      expect(request.system).toContain('"vi"');
    }

    // Budget used up: refused before the provider.
    const refused = await t.gradeIt(demo);
    expect(refused.status).toBe(429);
    expect(t.fake.requests).toHaveLength(2);
  });

  it('refuses a demo request over 256 KiB before reserving', async () => {
    const t = await setup([], 3);
    const tooBig = await t.issue({
      ...demo,
      slice: {
        ...slice,
        propositions: [
          ...slice.propositions,
          ...Array.from({ length: 190 }, (_, i) => ({
            propositionId: `big${i}`,
            text: 'x'.repeat(1000),
          })),
        ],
        edges: Array.from({ length: 300 }, (_, i) => ({
          edgeId: `big${i}`,
          from: 'p1',
          to: 'p4',
          relation: 'supports',
          label: 'y'.repeat(200),
        })),
      },
    });
    expect(tooBig.status).toBe(413);
    expect(await t.used()).toBe(0);
  });
});

/** Accounts over a database the test seeds. */
const account = async (programs: Program[]) => {
  const database: ServerDatabase = Effect.runSync(openServerDatabase({ path: ':memory:' }));
  const fake = scriptedAi(programs);
  const { handlers, logs } = make({}, { ai: fake.layer, database });
  const storage = makeServerStorage(database);
  const user = async (email: string, roles: ReadonlyArray<string> = ['teacher']) => {
    const { token } = (await (
      await send(handlers.register, 'POST', '/api/auth/register', undefined, {
        email,
        password: 'password-123',
      })
    ).json()) as { token: string };
    const me = (await (await send(handlers.me, 'GET', '/api/auth/me', token)).json()) as {
      user: { id: string };
    };
    const call = (method: string, path: string, body?: unknown, signal?: AbortSignal) =>
      send(handlers.account, method, `/api/account/${path}`, token, body, signal);
    if (roles.length > 0) {
      const { id } = (await (
        await call('POST', 'connections', {
          label: 'A',
          provider: 'anthropic',
          apiKey: ACCOUNT_KEY,
        })
      ).json()) as { id: string };
      const role = { connectionId: id, model: 'claude-haiku-5-5' };
      await call('PUT', 'roles', { roles: Object.fromEntries(roles.map((r) => [r, role])) });
    }
    await Effect.runPromise(
      storage.forUser(me.user.id).appendKnowledge(graphEvents, { expectedLastSeq: -1 }),
    );
    return { token, id: me.user.id, call };
  };
  return { handlers, logs, fake, storage, user };
};

type View = {
  practiceId: string;
  endedAt?: number;
  exercises: Array<{
    exerciseId: string;
    type: string;
    content: Json;
    grade?: { score: number };
    solution?: Json;
  }>;
};

describe('account practice', () => {
  it('starts a practice without answer keys, grades by code without a call, and by model', async () => {
    const t = await account([write, grade('correct')]);
    const a = await t.user('a@kd.test');
    const started = await a.call('POST', 'practice', {
      count: 4,
      types: ['multipleChoice', 'shortAnswer'],
    });
    expect(started.status).toBe(201);
    const text = await started.text();
    for (const hidden of [
      'correctIndex',
      'constraints',
      'reference',
      'propositionIds',
      'edgeIds',
    ]) {
      expect(text).not.toContain(hidden);
    }
    const view = JSON.parse(text) as View;
    expect(view.exercises).toHaveLength(4);
    // The teacher's model, since no practitioner role is set.
    expect(t.fake.requests[0]).toMatchObject({ model: { apiKey: ACCOUNT_KEY } });

    const list = (await (await a.call('GET', 'practice')).json()) as { practices: View[] };
    expect(list.practices.map((p) => p.practiceId)).toEqual([view.practiceId]);

    const mc = view.exercises.find((e) => e.type === 'multipleChoice')!;
    const options = mc.content.options as string[];
    const answered = await a.call('POST', `practice/exercises/${mc.exerciseId}/answer`, {
      answer: { type: 'multipleChoice', choice: options.indexOf('Right') },
    });
    expect(answered.status).toBe(200);
    expect(await answered.json()).toMatchObject({
      grade: { score: 1 },
      solution: { correctIndex: options.indexOf('Right') },
    });
    expect(t.fake.requests).toHaveLength(1);

    const sa = view.exercises.find(
      (e) => e.type === 'shortAnswer' || e.type === 'explainReasoning',
    )!;
    const graded = await a.call('POST', `practice/exercises/${sa.exerciseId}/answer`, {
      answer: { type: sa.type, text: 'Because.' },
    });
    expect(await graded.json()).toMatchObject({ grade: { score: 1, profileId: 'default' } });
    expect(t.fake.requests).toHaveLength(2);
    expect(t.fake.requests[1]!.maxOutputTokens).toBe(4000);

    // Answering twice, or after the end, is refused.
    expect(
      (
        await a.call('POST', `practice/exercises/${mc.exerciseId}/answer`, {
          answer: { type: 'multipleChoice', choice: 0 },
        })
      ).status,
    ).toBe(409);
    const ended = (await (await a.call('POST', `practice/${view.practiceId}/end`)).json()) as View;
    expect(ended.endedAt).toBeDefined();
    expect((await a.call('POST', `practice/${view.practiceId}/end`)).status).toBe(200);
    expect(
      ((await (await a.call('GET', 'practice')).json()) as { practices: View[] }).practices,
    ).toEqual([]);
    const left = ended.exercises.find((e) => e.grade === undefined)!;
    expect(
      (
        await a.call('POST', `practice/exercises/${left.exerciseId}/answer`, {
          answer: { type: 'shortAnswer', text: 'x' },
        })
      ).status,
    ).toBe(409);
  });

  it('answers RoleNotConfigured when neither practitioner nor teacher has a model', async () => {
    const t = await account([]);
    const a = await t.user('a@kd.test', []);
    const response = await a.call('POST', 'practice', {});
    expect(response.status).toBe(409);
    expect(await codeOf(response)).toBe('RoleNotConfigured');
    expect(t.fake.requests).toHaveLength(0);
  });

  it("never shows or changes another user's practice (risk 26)", async () => {
    const t = await account([write]);
    const a = await t.user('a@kd.test');
    const b = await t.user('b@kd.test');
    const started = await (await a.call('POST', 'practice', {})).text();
    // The ordering exercise does not give its constraints away either.
    expect(started).toContain('orderChain');
    expect(started).not.toContain('constraints');
    const view = JSON.parse(started) as View;
    const exerciseId = view.exercises[0]!.exerciseId;
    expect((await b.call('GET', `practice/${view.practiceId}`)).status).toBe(404);
    expect((await b.call('POST', `practice/${view.practiceId}/end`)).status).toBe(404);
    expect(
      (
        await b.call('POST', `practice/exercises/${exerciseId}/answer`, {
          answer: { type: 'shortAnswer', text: 'x' },
        })
      ).status,
    ).toBe(404);
    expect((await b.call('POST', `practice/exercises/${exerciseId}/grade`)).status).toBe(404);
    expect(
      ((await (await b.call('GET', 'practice')).json()) as { practices: View[] }).practices,
    ).toEqual([]);
    // A's practice is untouched.
    const again = (await (await a.call('GET', `practice/${view.practiceId}`)).json()) as View;
    expect(again.endedAt).toBeUndefined();
    expect(again.exercises.every((e) => e.grade === undefined)).toBe(true);
  });

  it('keeps writing and grading after the connection closes', async () => {
    const writing = held(write);
    const grading = held(grade('incorrect'));
    const t = await account([writing.program, grading.program]);
    const a = await t.user('a@kd.test');

    const closed = new AbortController();
    const start = a.call('POST', 'practice', { types: ['shortAnswer'] }, closed.signal);
    await until(() => writing.state.called);
    closed.abort();
    writing.release();
    await start.catch(() => undefined);
    await until(
      async () =>
        ((await (await a.call('GET', 'practice')).json()) as { practices: View[] }).practices
          .length === 1,
    );
    const [view] = ((await (await a.call('GET', 'practice')).json()) as { practices: View[] })
      .practices;
    const exerciseId = view!.exercises[0]!.exerciseId;

    const closedAgain = new AbortController();
    const answer = a.call(
      'POST',
      `practice/exercises/${exerciseId}/answer`,
      { answer: { type: 'shortAnswer', text: 'No idea.' } },
      closedAgain.signal,
    );
    await until(() => grading.state.called);
    closedAgain.abort();
    grading.release();
    await answer.catch(() => undefined);
    await until(async () => {
      const current = (await (await a.call('GET', `practice/${view!.practiceId}`)).json()) as View;
      return current.exercises[0]!.grade?.score === 0;
    });
  });

  it('keeps the answer when grading fails, and grades it on retry', async () => {
    const t = await account([write, failWith(`denied ${ACCOUNT_KEY}`), grade('correct')]);
    const a = await t.user('a@kd.test');
    const view = (await (
      await a.call('POST', 'practice', { types: ['shortAnswer'], count: 1 })
    ).json()) as View;
    const exerciseId = view.exercises[0]!.exerciseId;
    const failed = await a.call('POST', `practice/exercises/${exerciseId}/answer`, {
      answer: { type: 'shortAnswer', text: 'Proposition p1.' },
    });
    expect(failed.status).toBe(502);
    expect(await failed.text()).not.toContain(ACCOUNT_KEY);
    const current = (await (await a.call('GET', `practice/${view.practiceId}`)).json()) as View;
    expect(current.exercises[0]).toMatchObject({ answer: { text: 'Proposition p1.' } });
    expect(current.exercises[0]!.grade).toBeUndefined();

    const retried = await a.call('POST', `practice/exercises/${exerciseId}/grade`);
    expect(await retried.json()).toMatchObject({ grade: { score: 1 } });
    // Grading again returns the same grade without a call.
    expect(
      await (await a.call('POST', `practice/exercises/${exerciseId}/grade`)).json(),
    ).toMatchObject({ grade: { score: 1 } });
    expect(t.fake.requests).toHaveLength(3);
    expect(JSON.stringify(t.logs)).not.toContain(ACCOUNT_KEY);
  });

  it('answers 409 when there is nothing to practice', async () => {
    const t = await account([]);
    const a = await t.user('a@kd.test');
    await Effect.runPromise(
      t.storage.forUser(a.id).appendKnowledge(
        ['p1', 'p2', 'p3', 'p4'].map((id, i) => ({
          _tag: 'PropositionRetired',
          id: `r${i}`,
          at: 20 + i,
          propositionId: id,
        })),
        { expectedLastSeq: graphEvents.length - 1 },
      ),
    );
    expect(await codeOf(await a.call('POST', 'practice', {}))).toBe('NothingToRun');
  });
});
