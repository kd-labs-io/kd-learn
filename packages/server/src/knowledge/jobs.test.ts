import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect } from 'effect';
import { afterAll, describe, expect, it } from 'vitest';
import { defaultProfile } from '@kd-learn/agent';
import type { DomainEvent, KnowledgeEvent } from '@kd-learn/core';
import { makeServerStorage, openServerDatabase } from '@kd-learn/storage/sqlite-node';
import { make } from '../auth/test-support.ts';
import type { Handlers } from '../index.ts';
import { callTool, failWith, held, scriptedAi, structured } from '../sessions/fake-ai.ts';

const KEY = 'sk-ant-extract-SECRET-0123456789';
const dir = mkdtempSync(join(tmpdir(), 'kd-extract-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const request = (
  handler: Handlers[keyof Handlers],
  method: string,
  path: string,
  token?: string,
  body?: unknown,
) =>
  handler(
    new Request(`http://kd.test${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
const until = async (check: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 400; i++) {
    if (await check()) return;
    await tick();
  }
  throw new Error('timed out waiting');
};

/** A session on its last step, one teaching turn in: it may be skipped, or completed by a turn. */
const lastStep = (sessionId: string, topic: string): DomainEvent[] => [
  {
    _tag: 'SessionCreated',
    id: `${sessionId}-e1`,
    at: 1,
    sessionId,
    topic,
    profile: { ...defaultProfile, language: 'en', maxTurnsPerStep: 1 },
  },
  { _tag: 'TurnStarted', id: `${sessionId}-e2`, at: 2, turnId: `${sessionId}-t1`, input: 'Hi' },
  {
    _tag: 'AssessmentRecorded',
    id: `${sessionId}-e3`,
    at: 3,
    turnId: `${sessionId}-t1`,
    level: 'beginner',
    summary: 'New to it.',
    strengths: [],
    gaps: [],
  },
  {
    _tag: 'PlanCreated',
    id: `${sessionId}-e4`,
    at: 4,
    turnId: `${sessionId}-t1`,
    plan: { nodes: [{ id: 'n1', title: topic, goal: `Explain ${topic}`, dependsOn: [] }] },
  },
  {
    _tag: 'TurnCompleted',
    id: `${sessionId}-e5`,
    at: 5,
    turnId: `${sessionId}-t1`,
    reason: 'stop',
  },
  { _tag: 'TurnStarted', id: `${sessionId}-e6`, at: 6, turnId: `${sessionId}-t2`, input: 'Go on' },
  {
    _tag: 'MessageAppended',
    id: `${sessionId}-e7`,
    at: 7,
    turnId: `${sessionId}-t2`,
    messageId: `${sessionId}-m1`,
    agent: 'teacher',
    content: `${topic} needs a sorted array.`,
  },
  {
    _tag: 'TurnCompleted',
    id: `${sessionId}-e8`,
    at: 8,
    turnId: `${sessionId}-t2`,
    reason: 'stop',
  },
];

/** The three answers of one extraction that adds one proposition. */
const extraction = (text: string) => [
  structured({ propositions: [{ key: 'p', text, stepId: 'n1' }], edges: [] }),
  structured({
    propositions: [{ key: 'p', verdict: 'keep', text: '', parts: [], reason: '' }],
    edges: [],
  }),
];

const setup = async (
  programs: Parameters<typeof scriptedAi>[0],
  options: { dbPath?: string; roles?: boolean } = {},
) => {
  const dbPath = options.dbPath ?? join(dir, `${crypto.randomUUID()}.db`);
  const fake = scriptedAi(programs);
  const { handlers, logs } = make({}, { ai: fake.layer, dbPath });
  const registered = (await (
    await request(handlers.register, 'POST', '/api/auth/register', undefined, {
      email: 'a@kd.test',
      password: 'password-123',
    })
  ).json()) as { token: string; user: { id: string } };
  const token = registered.token;
  const userId = registered.user.id;
  const account = (method: string, path: string, body?: unknown, as = token) =>
    request(handlers.account, method, `/api/account/${path}`, as, body);
  if (options.roles !== false) {
    const { id } = (await (
      await account('POST', 'connections', { label: 'A', provider: 'anthropic', apiKey: KEY })
    ).json()) as { id: string };
    await account('PUT', 'roles', {
      roles: { teacher: { connectionId: id, model: 'claude-haiku-5-5' } },
    });
  }
  // A second connection to the same file, as another process would see it.
  const storage = makeServerStorage(Effect.runSync(openServerDatabase({ path: dbPath })));
  const user = storage.forUser(userId);
  const seed = (sessionId: string, topic: string) =>
    Effect.runSync(user.appendEvents(sessionId, lastStep(sessionId, topic)));
  const knowledge = () => Effect.runSync(user.readKnowledge) as ReadonlyArray<KnowledgeEvent>;
  const tagsOf = () => knowledge().map((e) => e._tag);
  const list = async () =>
    (
      (await (await account('GET', 'knowledge/extractions')).json()) as {
        sessions: Array<{
          sessionId: string;
          state: string;
          completed: boolean;
          failure?: unknown;
        }>;
      }
    ).sessions;
  return { handlers, logs, fake, token, account, seed, knowledge, tagsOf, list, dbPath, userId };
};

describe('account extraction', () => {
  it('extracts a session completed by skipping its last step, detached from the request', async () => {
    const t = await setup(extraction('Binary search needs a sorted array.'));
    t.seed('s1', 'Binary search');
    const skipped = await t.account('POST', 'sessions/s1/skip', { stepId: 'n1' });
    expect(skipped.status).toBe(204);
    await until(() => t.tagsOf().includes('SessionExtracted'));
    expect(t.tagsOf()).toEqual(['ExtractionStarted', 'PropositionAdded', 'SessionExtracted']);
    // The role falls back to the teacher's model; the extractor prompt runs; no merge (empty graph).
    expect(t.fake.requests.map((r) => r.system)).toEqual([
      defaultProfile.prompts.extractor,
      defaultProfile.prompts.auditor,
    ]);
    expect(t.fake.requests[0]!.maxOutputTokens).toBe(16_384);
    expect((await t.list())[0]).toMatchObject({
      sessionId: 's1',
      state: 'extracted',
      completed: true,
    });
    // Extracted already: nothing more to run.
    expect((await t.account('POST', 'knowledge/extractions', { sessionId: 's1' })).status).toBe(
      409,
    );
  });

  it('extracts after a turn that completes the last step', async () => {
    const t = await setup([
      callTool('complete_step', { stepId: 'n1' }, 'Well done.'),
      ...extraction('Binary search halves the interval.'),
    ]);
    t.seed('s1', 'Binary search');
    const started = await t.account('POST', 'sessions/s1/turns', { kind: 'send', input: 'Done' });
    expect(started.status).toBe(202);
    await until(() => t.tagsOf().includes('SessionExtracted'));
    const added = t.knowledge().find((e) => e._tag === 'PropositionAdded');
    expect(added).toMatchObject({
      text: 'Binary search halves the interval.',
      source: { sessionId: 's1' },
    });
  });

  it('runs two sessions that complete together one after the other', async () => {
    const first = held(
      structured({ propositions: [{ key: 'p', text: 'A first claim.' }], edges: [] }),
    );
    const t = await setup([
      first.program,
      structured({
        propositions: [{ key: 'p', verdict: 'keep', text: '', parts: [], reason: '' }],
        edges: [],
      }),
      ...extraction('A second claim.'),
    ]);
    t.seed('s1', 'First topic');
    t.seed('s2', 'Second topic');
    await t.account('POST', 'sessions/s1/skip', { stepId: 'n1' });
    await t.account('POST', 'sessions/s2/skip', { stepId: 'n1' });
    await until(() => t.fake.requests.length === 1);
    // Both attempts exist; the second waits for the first.
    expect(t.tagsOf()).toEqual(['ExtractionStarted', 'ExtractionStarted']);
    const states = Object.fromEntries((await t.list()).map((s) => [s.sessionId, s.state]));
    expect(states).toEqual({ s1: 'running', s2: 'queued' });
    expect((await t.account('POST', 'knowledge/extractions', { sessionId: 's2' })).status).toBe(
      409,
    );
    await tick();
    expect(t.fake.requests).toHaveLength(1);
    first.release();
    await until(() => t.tagsOf().filter((tag) => tag === 'SessionExtracted').length === 2);
    const extracted = t.knowledge().filter((e) => e._tag === 'SessionExtracted');
    expect(extracted.map((e) => e.sessionId)).toEqual(['s1', 's2']);
  });

  it('writes a failure without the key, does not run again by itself, and retries on request', async () => {
    const t = await setup([failWith(`bad key ${KEY}`), ...extraction('Retried claim.')]);
    t.seed('s1', 'Binary search');
    await t.account('POST', 'sessions/s1/skip', { stepId: 'n1' });
    await until(() => t.tagsOf().includes('ExtractionFailed'));
    expect(JSON.stringify(t.knowledge())).not.toContain(KEY);
    expect(JSON.stringify(t.logs)).not.toContain(KEY);
    expect((await t.list())[0]).toMatchObject({ state: 'failed' });
    expect(t.fake.requests).toHaveLength(1);

    const retry = await t.account('POST', 'knowledge/extractions', { sessionId: 's1' });
    expect(retry.status).toBe(202);
    await until(() => t.tagsOf().includes('SessionExtracted'));
    expect(t.tagsOf()).toEqual([
      'ExtractionStarted',
      'ExtractionFailed',
      'ExtractionStarted',
      'PropositionAdded',
      'SessionExtracted',
    ]);
  });

  it('writes no attempt when no model is set, and answers 409 to "extract now"', async () => {
    const t = await setup([], { roles: false });
    t.seed('s1', 'Binary search');
    await t.account('POST', 'sessions/s1/skip', { stepId: 'n1' });
    await tick();
    expect(t.tagsOf()).toEqual([]);
    const now = await t.account('POST', 'knowledge/extractions', { sessionId: 's1' });
    expect(now.status).toBe(409);
    expect(((await now.json()) as { error: { code: string } }).error.code).toBe(
      'RoleNotConfigured',
    );
  });

  it('does not extract a session completed before phase 3, but extracts it on request', async () => {
    const t = await setup(extraction('An old claim.'));
    t.seed('old', 'Old topic');
    // Completed by an earlier version: written straight to the log, no hook ran.
    const db = makeServerStorage(Effect.runSync(openServerDatabase({ path: t.dbPath })));
    Effect.runSync(
      db.forUser(t.userId).appendEvents('old', [
        { _tag: 'StepSkipped', id: 'old-skip', at: 9, stepId: 'n1' },
        { _tag: 'SessionCompleted', id: 'old-done', at: 9 },
      ]),
    );
    await tick();
    expect(t.tagsOf()).toEqual([]);
    expect((await t.list())[0]).toMatchObject({ state: 'none', completed: true });
    expect((await t.account('POST', 'knowledge/extractions', { sessionId: 'old' })).status).toBe(
      202,
    );
    await until(() => t.tagsOf().includes('SessionExtracted'));
  });

  it("answers 404 for another user's session and writes nothing", async () => {
    const t = await setup([]);
    t.seed('s1', 'Binary search');
    const other = (await (
      await request(t.handlers.register, 'POST', '/api/auth/register', undefined, {
        email: 'b@kd.test',
        password: 'password-123',
      })
    ).json()) as { token: string };
    const response = await t.account(
      'POST',
      'knowledge/extractions',
      { sessionId: 's1' },
      other.token,
    );
    expect(response.status).toBe(404);
    expect(t.tagsOf()).toEqual([]);
  });

  /** A new process over the same file, logged in as the first user. */
  const restart = async (dbPath: string, programs: Parameters<typeof scriptedAi>[0]) => {
    const fake = scriptedAi(programs);
    const after = make({}, { ai: fake.layer, dbPath });
    const login = (await (
      await request(after.handlers.login, 'POST', '/api/auth/login', undefined, {
        email: 'a@kd.test',
        password: 'password-123',
      })
    ).json()) as { token: string };
    const list = async () =>
      (
        (await (
          await request(
            after.handlers.account,
            'GET',
            '/api/account/knowledge/extractions',
            login.token,
          )
        ).json()) as { sessions: Array<{ state: string; failure?: { code: string } }> }
      ).sessions;
    return { fake, list };
  };

  it('after a restart, a running extraction runs again with the same attempt and completes', async () => {
    const hung = held(structured({ propositions: [], edges: [] }));
    const before = await setup([hung.program]);
    before.seed('s1', 'Binary search');
    await before.account('POST', 'sessions/s1/skip', { stepId: 'n1' });
    await until(() => before.fake.requests.length === 1);

    const after = await restart(before.dbPath, extraction('Binary search needs a sorted array.'));
    await until(() => before.tagsOf().includes('SessionExtracted'));
    expect(before.tagsOf()).toEqual(['ExtractionStarted', 'PropositionAdded', 'SessionExtracted']);
    const [started, , extracted] = before.knowledge();
    expect(started).toMatchObject({ _tag: 'ExtractionStarted', sessionId: 's1' });
    expect(extracted).toMatchObject({
      _tag: 'SessionExtracted',
      extractionId: (started as { extractionId: string }).extractionId,
    });
    expect(after.fake.requests).toHaveLength(2);
    expect((await after.list())[0]).toMatchObject({ state: 'extracted' });
  });

  it('gives up after three starts cut by restarts: the attempt becomes Interrupted', async () => {
    const hang = () => held(structured({ propositions: [], edges: [] })).program;
    const before = await setup([hang()]);
    before.seed('s1', 'Binary search');
    await before.account('POST', 'sessions/s1/skip', { stepId: 'n1' });
    await until(() => before.fake.requests.length === 1);
    for (let start = 2; start <= 3; start++) {
      const again = await restart(before.dbPath, [hang()]);
      await until(() => again.fake.requests.length === 1);
    }
    const last = await restart(before.dbPath, []);
    expect((await last.list())[0]).toMatchObject({
      state: 'failed',
      failure: { code: 'Interrupted' },
    });
    expect(before.tagsOf()).toEqual(['ExtractionStarted', 'ExtractionFailed']);
    expect(last.fake.requests).toHaveLength(0);
  });

  it('after a restart, an open attempt without a job is interrupted and not run again', async () => {
    const before = await setup([]);
    before.seed('s1', 'Binary search');
    // Written by phase 3, or just before a crash that left no job row.
    const db = makeServerStorage(Effect.runSync(openServerDatabase({ path: before.dbPath })));
    Effect.runSync(
      db.forUser(before.userId).appendKnowledge(
        [{ _tag: 'ExtractionStarted', id: 'x1', at: 9, sessionId: 's1', extractionId: 'old' }],
        { expectedLastSeq: -1 },
      ),
    );
    const after = await restart(before.dbPath, []);
    expect((await after.list())[0]).toMatchObject({
      state: 'failed',
      failure: { code: 'Interrupted' },
    });
    expect(before.tagsOf()).toEqual(['ExtractionStarted', 'ExtractionFailed']);
    expect(after.fake.requests).toHaveLength(0);
  });
});
