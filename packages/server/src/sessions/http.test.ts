import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Effect } from 'effect';
import type { ImagePort } from '@kd-learn/ai/port';
import { makeSseParser } from '@kd-learn/api';
import type { Handlers } from '../index.ts';
import { make, type MakeOptions } from '../auth/test-support.ts';
import { callTool, die, failWith, gated, say, scriptedAi } from './fake-ai.ts';

const KEY = 'sk-ant-session-SECRET-0123456789';
const dir = mkdtempSync(join(tmpdir(), 'kd-sessions-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

type Json = Record<string, unknown>;

const request = (
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

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
const until = async (check: () => Promise<boolean>) => {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await tick();
  }
  throw new Error('timed out waiting');
};

/** A user with a configured connection for every role, and one session. */
const setup = async (programs: Parameters<typeof scriptedAi>[0], options: MakeOptions = {}) => {
  const fake = scriptedAi(programs);
  const { handlers, logs } = make({}, { ai: fake.layer, ...options });
  const signUp = async (email: string) => {
    const response = await request(handlers.register, 'POST', '/api/auth/register', undefined, {
      email,
      password: 'password-123',
    });
    return ((await response.json()) as { token: string }).token;
  };
  const token = await signUp('a@kd.test');
  const account = (
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
    as = token,
  ) => request(handlers.account, method, `/api/account/${path}`, as, body, signal);
  const { id } = (await (
    await account('POST', 'connections', { label: 'A', provider: 'anthropic', apiKey: KEY })
  ).json()) as { id: string };
  const role = { connectionId: id, model: 'claude-haiku-5-5' };
  await account('PUT', 'roles', { roles: { prober: role, teacher: role, sideChat: role } });
  const { sessionId } = (await (
    await account('POST', 'sessions', { topic: 'Fractions', language: 'en' })
  ).json()) as { sessionId: string };
  const snapshot = async (as = token) =>
    (await (await account('GET', `sessions/${sessionId}`, undefined, undefined, as)).json()) as {
      events: Array<{ seq: number; event: { _tag: string } & Json }>;
      running: Array<{ turnId: string; text: Array<{ text: string }> }>;
    };
  const idle = () => until(async () => (await snapshot()).running.length === 0);
  const tags = async () => (await snapshot()).events.map((e) => e.event._tag);
  return { handlers, logs, fake, token, account, sessionId, snapshot, idle, tags, signUp };
};

/** Reads SSE frames from a response until `stop` returns true. */
const readFrames = async (response: Response, stop: (frames: Json[]) => boolean) => {
  const reader = response.body!.getReader();
  const parser = makeSseParser();
  const decoder = new TextDecoder();
  const frames: Json[] = [];
  while (!stop(frames)) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const message of parser.push(decoder.decode(value, { stream: true }))) {
      frames.push(JSON.parse(message.data) as Json);
    }
  }
  return { frames, reader };
};

describe('account turns', () => {
  it('runs a turn detached from the request and refuses a second one meanwhile', async () => {
    const gate = gated('Hello, ', 'what do you know?');
    const t = await setup([gate.program]);
    const started = await t.account('POST', `sessions/${t.sessionId}/turns`, { kind: 'auto' });
    expect(started.status).toBe(202);
    const { turnId } = (await started.json()) as { turnId: string };

    const [a, b] = await Promise.all([
      t.account('POST', `sessions/${t.sessionId}/turns`, { kind: 'send', input: 'x' }),
      t.account('POST', `sessions/${t.sessionId}/turns`, { kind: 'retry' }),
    ]);
    expect([a.status, b.status]).toEqual([409, 409]);

    const mid = await t.snapshot();
    expect(mid.running).toHaveLength(1);
    expect(mid.running[0]).toMatchObject({ turnId, kind: 'main', text: [{ text: 'Hello, ' }] });
    gate.release();
    await t.idle();
    expect(await t.tags()).toEqual([
      'SessionCreated',
      'TurnStarted',
      'MessageAppended',
      'UsageRecorded',
      'TurnCompleted',
    ]);
  });

  it('finishes and stores the turn when the stream is closed mid-turn', async () => {
    const gate = gated('Hello, ', 'there.');
    const t = await setup([gate.program]);
    const controller = new AbortController();
    const stream = await t.account(
      'GET',
      `sessions/${t.sessionId}/stream`,
      undefined,
      controller.signal,
    );
    await t.account('POST', `sessions/${t.sessionId}/turns`, { kind: 'auto' });
    await readFrames(stream, (frames) => frames.some((f) => f._tag === 'delta'));
    controller.abort();
    gate.release();
    await t.idle();
    expect((await t.tags()).at(-1)).toBe('TurnCompleted');
  });

  it('reattaches mid-turn: text so far first, then each event exactly once', async () => {
    const gate = gated('Hello, ', 'there.');
    const t = await setup([gate.program]);
    await t.account('POST', `sessions/${t.sessionId}/turns`, { kind: 'auto' });
    const stream = await t.account('GET', `sessions/${t.sessionId}/stream?after=0`);
    const first = await readFrames(stream, (frames) => frames.length >= 2);
    expect(first.frames[0]).toMatchObject({
      _tag: 'running',
      turns: [{ kind: 'main', text: [{ text: 'Hello, ' }] }],
    });
    expect(first.frames[1]).toMatchObject({ _tag: 'log', seq: 1, event: { _tag: 'TurnStarted' } });
    gate.release();
    const frames = [...first.frames];
    const parser = makeSseParser();
    const decoder = new TextDecoder();
    while (!frames.some((f) => f._tag === 'turn' && f.status === 'completed')) {
      const { value } = await first.reader.read();
      for (const message of parser.push(decoder.decode(value, { stream: true }))) {
        frames.push(JSON.parse(message.data) as Json);
      }
    }
    await first.reader.cancel();
    const seqs = frames.filter((f) => f._tag === 'log').map((f) => f.seq);
    expect(seqs).toEqual([1, 2, 3, 4]);
    expect(frames.filter((f) => f._tag === 'delta').map((f) => f.delta)).toEqual(['there.']);
  });

  it('cancels: the provider is interrupted, nothing is written, the slot is free', async () => {
    const gate = gated('Hello', '');
    const t = await setup([gate.program, say('Again.')]);
    const { turnId } = (await (
      await t.account('POST', `sessions/${t.sessionId}/turns`, { kind: 'auto' })
    ).json()) as { turnId: string };
    const cancelled = await t.account('POST', `sessions/${t.sessionId}/turns/${turnId}/cancel`);
    expect(cancelled.status).toBe(204);
    await t.idle();
    expect(gate.state.interrupted).toBe(true);
    expect(await t.tags()).toEqual(['SessionCreated', 'TurnStarted']);
    const retry = await t.account('POST', `sessions/${t.sessionId}/turns`, { kind: 'retry' });
    expect(retry.status).toBe(202);
    await t.idle();
    expect((await t.tags()).at(-1)).toBe('TurnCompleted');
    expect((await t.account('POST', `sessions/${t.sessionId}/turns/${turnId}/cancel`)).status).toBe(
      404,
    );
  });

  it('closes a turn that crashed or failed, without the key, and frees the slot', async () => {
    const t = await setup([die(`boom ${KEY}`), failWith(`bad key ${KEY}`), say('ok')]);
    await t.account('POST', `sessions/${t.sessionId}/turns`, { kind: 'auto' });
    await t.idle();
    await t.account('POST', `sessions/${t.sessionId}/turns`, { kind: 'retry' });
    await t.idle();
    const events = (await t.snapshot()).events.map((e) => e.event);
    const failures = events.filter((e) => e._tag === 'TurnFailed');
    expect(failures.map((e) => e.code)).toEqual(['InternalError', 'ProviderError']);
    const everything = JSON.stringify([events, t.logs]);
    expect(everything).not.toContain(KEY);
    expect(everything).toContain('[redacted]');
    expect(
      (await t.account('POST', `sessions/${t.sessionId}/turns`, { kind: 'retry' })).status,
    ).toBe(202);
    await t.idle();
  });

  it('ends a hung turn with a retryable timeout', async () => {
    const gate = gated('Hello', '');
    const t = await setup([gate.program], { turnTimeoutMs: 50 });
    await t.account('POST', `sessions/${t.sessionId}/turns`, { kind: 'auto' });
    await t.idle();
    const last = (await t.snapshot()).events.at(-1)!.event;
    expect(last).toMatchObject({ _tag: 'TurnFailed', code: 'TurnTimeout', retryable: true });
  });

  it('chains the planning turn after the assessment, with the teacher model', async () => {
    const assessment = { level: 'beginner', summary: 's', strengths: [], gaps: ['adding'] };
    const plan = { nodes: [{ id: 'add', title: 'Add', goal: 'Add fractions', dependsOn: [] }] };
    const t = await setup([
      say('Q1?'),
      callTool('submit_assessment', assessment, 'Thanks.'),
      callTool('create_plan', plan, 'Here is the plan.'),
    ]);
    // A profile with N = 4 probing questions: answer until the assessment is allowed.
    await t.account('POST', `sessions/${t.sessionId}/turns`, { kind: 'auto' });
    await t.idle();
    t.fake.programs.unshift(say('Q2?'), say('Q3?'), say('Q4?'));
    for (const answer of ['a1', 'a2', 'a3']) {
      await t.account('POST', `sessions/${t.sessionId}/turns`, { kind: 'send', input: answer });
      await t.idle();
    }
    await t.account('POST', `sessions/${t.sessionId}/turns`, { kind: 'send', input: 'a4' });
    await t.idle();
    const tags = await t.tags();
    expect(tags).toContain('AssessmentRecorded');
    expect(tags).toContain('PlanCreated');
    expect(t.fake.requests.at(-1)?.system).toContain('Phase: planning');
  });

  it('stores the figures of a teaching turn and serves them to their owner only', async () => {
    const assessment = { level: 'beginner', summary: 's', strengths: [], gaps: ['adding'] };
    const plan = { nodes: [{ id: 'add', title: 'Add', goal: 'Add fractions', dependsOn: [] }] };
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"><rect width="2" height="2"/></svg>';
    const t = await setup([
      say('Q1?'),
      say('Q2?'),
      say('Q3?'),
      say('Q4?'),
      callTool('submit_assessment', assessment, 'Thanks.'),
      callTool('create_plan', plan, 'Here is the plan.'),
      callTool('show_diagram', { kind: 'svg', title: 'Halves', source: svg }, 'See the halves.'),
    ]);
    await t.account('POST', `sessions/${t.sessionId}/turns`, { kind: 'auto' });
    await t.idle();
    for (const answer of ['a1', 'a2', 'a3', 'a4', 'teach me']) {
      await t.account('POST', `sessions/${t.sessionId}/turns`, { kind: 'send', input: answer });
      await t.idle();
    }
    const events = (await t.snapshot()).events.map((e) => e.event);
    const added = events.find((e) => e._tag === 'FigureAdded') as Json | undefined;
    expect(added).toMatchObject({ kind: 'svg', title: 'Halves', mime: 'image/svg+xml' });
    const message = events.filter((e) => e._tag === 'MessageAppended').at(-1) as Json;
    expect(String(message.content)).toContain(`[[figure:${String(added?.figureId)}]]`);

    const got = await t.account('GET', `figures/${String(added?.figureId)}`);
    expect(got.status).toBe(200);
    expect(got.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(got.headers.get('content-security-policy')).toContain('sandbox');
    expect(await got.text()).toBe(svg);

    const other = await t.signUp('b@kd.test');
    const foreign = await t.account(
      'GET',
      `figures/${String(added?.figureId)}`,
      undefined,
      undefined,
      other,
    );
    expect(foreign.status).toBe(404);

    // A body that holds the key is never written, nor its FigureAdded (risk 19).
    const leak = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"><text>${KEY}</text></svg>`;
    t.fake.programs.push(
      callTool('show_diagram', { kind: 'svg', title: 'Leak', source: leak }, 'Done.'),
    );
    await t.account('POST', `sessions/${t.sessionId}/turns`, { kind: 'send', input: 'more' });
    await t.idle();
    const after = (await t.snapshot()).events.map((e) => e.event);
    expect(after.filter((e) => e._tag === 'FigureAdded')).toHaveLength(1);
    expect(JSON.stringify(after)).toContain('Done.');
    expect(JSON.stringify(after)).not.toContain(KEY);
    expect((await t.account('GET', 'figures/nope')).status).toBe(404);
    expect(
      (await request(t.handlers.account, 'GET', `/api/account/figures/x`, undefined)).status,
    ).toBe(401);
  });

  it('makes an image with the illustrator, stores its bytes, and keeps the image key out', async () => {
    const GKEY = 'AIza-image-SECRET-0123456789abcdef';
    const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
    const asked: Array<{ model: string; apiKey: string; prompt: string }> = [];
    const images: ImagePort['Service'] = {
      generate: (request) =>
        Effect.sync(() => {
          asked.push({
            model: request.model.model,
            apiKey: request.model.apiKey,
            prompt: request.prompt,
          });
          return {
            mime: 'image/jpeg' as const,
            bytes: JPEG,
            usage: { inputTokens: 30, outputTokens: 1120 },
          };
        }),
    };
    const assessment = { level: 'beginner', summary: 's', strengths: [], gaps: ['adding'] };
    const plan = { nodes: [{ id: 'add', title: 'Add', goal: 'Add fractions', dependsOn: [] }] };
    const t = await setup(
      [
        say('Q1?'),
        say('Q2?'),
        say('Q3?'),
        say('Q4?'),
        callTool('submit_assessment', assessment, 'Thanks.'),
        callTool('create_plan', plan, 'Here is the plan.'),
        callTool('generate_image', { title: 'A pizza', prompt: 'A pizza cut in eighths' }, 'Look.'),
      ],
      { images },
    );
    const settings = (await (await t.account('GET', 'settings')).json()) as {
      connections: Array<{ id: string }>;
      roles: Json;
    };
    const anthropic = settings.connections[0]!.id;
    // Anthropic has no image API: refused, and the roles stay as they were.
    const refused = await t.account('PUT', 'roles', {
      roles: {
        ...settings.roles,
        illustrator: { connectionId: anthropic, model: 'claude-haiku-5-5' },
      },
    });
    expect(refused.status).toBe(409);
    expect(JSON.stringify(await refused.json())).toContain('RoleNotSupported');
    const { id: gemini } = (await (
      await t.account('POST', 'connections', { label: 'G', provider: 'gemini', apiKey: GKEY })
    ).json()) as { id: string };
    const saved = await t.account('PUT', 'roles', {
      roles: {
        ...settings.roles,
        illustrator: { connectionId: gemini, model: 'gemini-3.1-flash-lite-image' },
      },
    });
    expect(saved.status).toBe(200);

    await t.account('POST', `sessions/${t.sessionId}/turns`, { kind: 'auto' });
    await t.idle();
    for (const answer of ['a1', 'a2', 'a3', 'a4', 'teach me']) {
      await t.account('POST', `sessions/${t.sessionId}/turns`, { kind: 'send', input: answer });
      await t.idle();
    }
    expect(asked).toEqual([
      { model: 'gemini-3.1-flash-lite-image', apiKey: GKEY, prompt: 'A pizza cut in eighths' },
    ]);
    const events = (await t.snapshot()).events.map((e) => e.event);
    const added = events.find((e) => e._tag === 'FigureAdded') as Json | undefined;
    expect(added).toMatchObject({ kind: 'image', mime: 'image/jpeg', bytes: JPEG.length });
    expect(events).toContainEqual(
      expect.objectContaining({ _tag: 'UsageRecorded', model: 'gemini-3.1-flash-lite-image' }),
    );
    const got = await t.account('GET', `figures/${String(added?.figureId)}`);
    expect(got.headers.get('content-type')).toBe('application/octet-stream');
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(JPEG);
    expect(JSON.stringify(events)).not.toContain(GKEY);
    expect(JSON.stringify(t.logs)).not.toContain(GKEY);
  });

  it('runs a side turn next to a main turn, and refuses a second side turn', async () => {
    const gate = gated('Main', ' turn.');
    const side = gated('Side', ' answer.');
    const t = await setup([gate.program, side.program]);
    await t.account('POST', `sessions/${t.sessionId}/turns`, { kind: 'auto' });
    const s = await t.account('POST', `sessions/${t.sessionId}/turns`, {
      kind: 'side',
      threadId: 'general',
      content: 'What is a numerator?',
    });
    expect(s.status).toBe(202);
    const again = await t.account('POST', `sessions/${t.sessionId}/turns`, {
      kind: 'side',
      threadId: 'general',
    });
    expect(again.status).toBe(409);
    side.release();
    gate.release();
    await t.idle();
    const tags = await t.tags();
    expect(tags.filter((tag) => tag === 'SideMessageAppended')).toHaveLength(2);
    expect(tags.at(-1)).toBe('TurnCompleted');
  });

  it('refuses a role with no model before writing anything', async () => {
    const t = await setup([]);
    await t.account('PUT', 'roles', { roles: {} });
    const response = await t.account('POST', `sessions/${t.sessionId}/turns`, { kind: 'auto' });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'RoleNotConfigured',
    );
    expect(await t.tags()).toEqual(['SessionCreated']);
  });

  it("answers 404 for another user's session on every route, and claims nothing", async () => {
    const gate = gated('Hi', '');
    const t = await setup([gate.program]);
    const { turnId } = (await (
      await t.account('POST', `sessions/${t.sessionId}/turns`, { kind: 'auto' })
    ).json()) as { turnId: string };
    const bob = await t.signUp('bob@kd.test');
    const as = (method: string, path: string, body?: unknown) =>
      t.account(method, path, body, undefined, bob);
    const base = `sessions/${t.sessionId}`;
    const statuses = [
      (await as('GET', base)).status,
      (await as('GET', `${base}/stream`)).status,
      (await as('POST', `${base}/turns`, { kind: 'send', input: 'x' })).status,
      (await as('POST', `${base}/turns/${turnId}/cancel`)).status,
      (await as('POST', `${base}/skip`, { stepId: 'x' })).status,
      (await as('POST', `sessions/unknown-id/turns`, { kind: 'auto' })).status,
    ];
    expect(statuses).toEqual([404, 404, 404, 404, 404, 404]);
    const list = (await (await as('GET', 'sessions')).json()) as { sessions: unknown[] };
    expect(list.sessions).toEqual([]);
    gate.release();
    await t.idle();
  });

  it('after a restart, the open turn is interrupted and can be retried', async () => {
    const dbPath = join(dir, 'restart.db');
    const hung = gated('Hi', '');
    const before = await setup([hung.program], { dbPath });
    await before.account('POST', `sessions/${before.sessionId}/turns`, { kind: 'auto' });
    await until(async () => (await before.snapshot()).running[0]?.text.length === 1);

    // A new process over the same file: the old registry is gone.
    const fake = scriptedAi([say('Back again.')]);
    const after = make({}, { ai: fake.layer, dbPath });
    const login = (await (
      await request(after.handlers.login, 'POST', '/api/auth/login', undefined, {
        email: 'a@kd.test',
        password: 'password-123',
      })
    ).json()) as { token: string };
    const path = `/api/account/sessions/${before.sessionId}`;
    const snap = (await (
      await request(after.handlers.account, 'GET', path, login.token)
    ).json()) as {
      running: unknown[];
      events: Array<{ event: { _tag: string } }>;
    };
    expect(snap.running).toEqual([]);
    expect(snap.events.at(-1)?.event._tag).toBe('TurnStarted');
    const retry = await request(after.handlers.account, 'POST', `${path}/turns`, login.token, {
      kind: 'retry',
    });
    expect(retry.status).toBe(202);
    await until(async () => {
      const s = (await (
        await request(after.handlers.account, 'GET', path, login.token)
      ).json()) as {
        running: unknown[];
      };
      return s.running.length === 0;
    });
  });
});
