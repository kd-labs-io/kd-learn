// Tests of the turn flow against a scripted "server" (a `fetch` that returns SSE) and the memory
// storage. The scripted server builds events the way the real one does, and the runner validates
// every batch with `projectSession`, so a mistake in the script shows up as a dropped batch.
import { Effect, Result } from 'effect';
import { describe, expect, it } from 'vitest';
import { defaultProfile } from '@kd-learn/agent/client';
import { encodeFrame, type Frame, type TurnRequest } from '@kd-learn/api';
import {
  currentStep,
  findInterruptedTurn,
  projectSession,
  type DomainEvent,
  type Session,
} from '@kd-learn/core';
import { makeMemoryStorage } from '@kd-learn/storage/memory';
import { StorageBusy, type GuestSettings, type StorageService } from '@kd-learn/storage/port';
import { SessionRunner, appendBatch, shouldAutoStart } from './runner';

const SESSION = 's1';

let counter = 0;
const id = () => `id${++counter}`;

const created = (profile = defaultProfile): DomainEvent => ({
  _tag: 'SessionCreated',
  id: id(),
  at: 1,
  sessionId: SESSION,
  topic: 'Rust',
  profile,
});

const settings: GuestSettings = {
  provider: 'anthropic',
  model: 'claude-test',
  apiKey: 'sk-test-key',
};

const body = (frames: ReadonlyArray<Frame>) =>
  new Response(frames.map(encodeFrame).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });

const ev = (turnId: string) => ({ id: id(), at: 5, turnId });

/** Events a well-behaved server sends for the open turn, by input: see `reply`. */
const reply = (request: TurnRequest): ReadonlyArray<Frame> => {
  const projected = projectSession(request.log);
  if (Result.isFailure(projected)) throw projected.failure;
  const session = projected.success;
  if (request.turn.kind === 'side') {
    const threadId = request.turn.threadId;
    return [
      { _tag: 'delta', messageId: 'sm', delta: 'Short answer.' },
      {
        _tag: 'event',
        event: {
          _tag: 'SideMessageAppended',
          id: id(),
          at: 6,
          threadId,
          messageId: id(),
          role: 'assistant',
          content: 'Short answer.',
        },
      },
      { _tag: 'done', outcome: 'completed' },
    ];
  }
  const turn = session.turns.at(-1)!;
  const turnId = turn.turnId;
  const say = (text: string): Frame => ({
    _tag: 'event',
    event: {
      _tag: 'MessageAppended',
      ...ev(turnId),
      messageId: id(),
      agent: 'teacher',
      content: text,
    },
  });
  const completed: Frame = {
    _tag: 'event',
    event: { _tag: 'TurnCompleted', ...ev(turnId), reason: 'stop' },
  };
  const done: Frame = { _tag: 'done', outcome: 'completed' };
  const delta = (text: string): Frame => ({ _tag: 'delta', messageId: 'm', delta: text });

  switch (session.state._tag) {
    case 'Probing':
      if (turn.input === 'ASSESS') {
        return [
          delta('Thanks.'),
          say('Thanks.'),
          {
            _tag: 'event',
            event: {
              _tag: 'AssessmentRecorded',
              ...ev(turnId),
              level: 'beginner',
              summary: 'Knows little.',
              strengths: [],
              gaps: ['borrowing'],
            },
          },
          completed,
          done,
        ];
      }
      return [delta('First question?'), say('First question?'), completed, done];
    case 'Planning':
      return [
        delta('Plan ready.'),
        {
          _tag: 'event',
          event: {
            _tag: 'PlanCreated',
            ...ev(turnId),
            plan: {
              nodes: [
                { id: 'a', title: 'A', goal: 'ga', dependsOn: [] },
                { id: 'b', title: 'B', goal: 'gb', dependsOn: ['a'] },
              ],
            },
          },
        },
        say('Plan ready.'),
        completed,
        done,
      ];
    case 'Teaching': {
      const stepId = session.state.stepId!;
      if (turn.input !== 'ok') return [delta('Hmm.'), say('Hmm.'), completed, done];
      const last = session.plan!.nodes.at(-1)!.id === stepId;
      return [
        say('Good.'),
        { _tag: 'event', event: { _tag: 'StepCompleted', ...ev(turnId), stepId } },
        ...(last
          ? [{ _tag: 'event', event: { _tag: 'SessionCompleted', ...ev(turnId) } } as Frame]
          : []),
        completed,
        done,
      ];
    }
    default:
      throw new Error('unexpected state');
  }
};

interface Harness {
  readonly storage: StorageService;
  readonly runner: SessionRunner;
  readonly requests: Array<TurnRequest>;
  readonly log: () => Promise<ReadonlyArray<DomainEvent>>;
  readonly session: () => Promise<Session>;
}

/** `serve` decides the answer to each request; `lock` replaces the Web Lock. */
async function setup(
  options: {
    profile?: typeof defaultProfile;
    withSettings?: boolean;
    serve?: (request: TurnRequest, call: number) => Response | Promise<Response>;
    lock?: ConstructorParameters<typeof SessionRunner>[1]['lock'];
    storage?: StorageService;
    onSessionCompleted?: (sessionId: string) => void;
  } = {},
): Promise<Harness> {
  const storage = options.storage ?? makeMemoryStorage();
  await Effect.runPromise(storage.appendEvents(SESSION, [created(options.profile)]));
  if (options.withSettings !== false) await Effect.runPromise(storage.saveSettings(settings));
  const requests: Array<TurnRequest> = [];
  const serve = options.serve ?? ((request) => body(reply(request)));
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    const { Schema } = await import('effect');
    const { TurnRequest } = await import('@kd-learn/api');
    const request = Schema.decodeUnknownSync(TurnRequest)(JSON.parse(String(init?.body)));
    requests.push(request);
    return serve(request, requests.length);
  }) as typeof fetch;
  const runner = new SessionRunner(SESSION, {
    storage: async () => storage,
    fetch: fetchImpl,
    newId: id,
    now: () => 10,
    ...(options.lock === undefined ? {} : { lock: options.lock }),
    ...(options.onSessionCompleted ? { onSessionCompleted: options.onSessionCompleted } : {}),
  });
  const log = () => Effect.runPromise(storage.readSession(SESSION));
  const session = async () => {
    const projected = projectSession(await log());
    if (Result.isFailure(projected)) throw projected.failure;
    return projected.success;
  };
  return { storage, runner, requests, log, session };
}

const tags = (log: ReadonlyArray<DomainEvent>) => log.map((event) => event._tag);

describe('main turn', () => {
  it('starts the Prober by itself on a new session, once', async () => {
    const h = await setup();
    await h.runner.autoStart();
    expect(tags(await h.log())).toEqual([
      'SessionCreated',
      'TurnStarted',
      'MessageAppended',
      'TurnCompleted',
    ]);
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]!.log.at(-1)?._tag).toBe('TurnStarted');
    await h.runner.autoStart();
    expect(h.requests).toHaveLength(1);
    expect(h.runner.getSnapshot().main).toMatchObject({ running: false, failure: undefined });
  });

  it('goes from probing to done, starting the planning turn by itself', async () => {
    const h = await setup();
    await h.runner.autoStart();
    await h.runner.send('ASSESS');
    // assessment turn, then the automatic planning turn with empty input
    expect((await h.session()).state).toEqual({ _tag: 'Teaching', stepId: 'a', turnsInStep: 0 });
    const planning = (await h.session()).turns.at(-1)!;
    expect(planning).toMatchObject({ input: '', status: 'completed' });
    expect(h.requests).toHaveLength(3);

    await h.runner.send('ok');
    expect(currentStep(await h.session())?.id).toBe('b');
    await h.runner.send('ok');
    const done = await h.session();
    expect(done.state._tag).toBe('Done');
    expect(done.completedSteps).toEqual(['a', 'b']);
  });

  it('streams the text of the turn into the live state', async () => {
    const h = await setup();
    const seen: Array<string | undefined> = [];
    h.runner.subscribe(() => seen.push(h.runner.getSnapshot().main.live?.text));
    await h.runner.autoStart();
    expect(seen).toContain('First question?');
  });

  it('writes nothing when there is no key', async () => {
    const h = await setup({ withSettings: false });
    await h.runner.autoStart();
    expect(tags(await h.log())).toEqual(['SessionCreated']);
    expect(h.requests).toHaveLength(0);
    expect(h.runner.getSnapshot().main.failure?.code).toBe('NoKey');
  });

  it('keeps the turn open when the connection drops, and retries with the same input', async () => {
    let up = false;
    const h = await setup({
      serve: (request) => {
        if (!up) throw new TypeError('network down');
        return body(reply(request));
      },
    });
    await h.runner.autoStart();
    await h.runner.send('my answer');
    const interrupted = findInterruptedTurn(await h.session());
    expect(interrupted?.input).toBe('my answer');
    expect(h.runner.getSnapshot().main.failure).toMatchObject({ code: 'Network', retryable: true });
    expect(h.runner.getSnapshot().main.live).toBeUndefined();

    up = true;
    await h.runner.retry();
    const session = await h.session();
    expect(session.turns.at(-1)).toMatchObject({ input: 'my answer', status: 'completed' });
    expect(findInterruptedTurn(session)).toBeUndefined();
    // the model saw the answer once: the open turn is not in the history
    expect(session.history.filter((m) => m.content === 'my answer')).toHaveLength(1);
  });

  it('treats a stream that ends before `done` as interrupted', async () => {
    const h = await setup({ serve: () => body([{ _tag: 'delta', messageId: 'm', delta: 'Par' }]) });
    await h.runner.autoStart();
    expect(findInterruptedTurn(await h.session())).toBeDefined();
    expect(tags(await h.log())).toEqual(['SessionCreated', 'TurnStarted']);
    expect(h.runner.getSnapshot().main.failure?.code).toBe('Network');
  });

  it('records an HTTP error as TurnFailed and does not start the next turn by itself', async () => {
    const h = await setup({
      serve: () =>
        body([
          {
            _tag: 'error',
            error: { code: 'HistoryTooLarge', message: 'too big', retryable: false },
          },
          { _tag: 'done', outcome: 'failed' },
        ]),
    });
    await h.runner.autoStart();
    const log = await h.log();
    expect(tags(log)).toEqual(['SessionCreated', 'TurnStarted', 'TurnFailed']);
    expect((await h.session()).turns.at(-1)).toMatchObject({
      status: 'failed',
      failure: { code: 'HistoryTooLarge', retryable: false },
    });
    expect(h.runner.getSnapshot().main.failure?.code).toBe('HistoryTooLarge');
    // after a failed turn nothing starts without the learner
    expect(shouldAutoStart(await h.session())).toBe(false);
    await h.runner.autoStart();
    expect(h.requests).toHaveLength(1);
  });

  it('keeps the TurnFailed the server sent, without adding a second one', async () => {
    const h = await setup({
      serve: (request) => {
        const turnId = projectSession(request.log).pipe(Result.getOrThrow).turns.at(-1)!.turnId;
        return body([
          {
            _tag: 'event',
            event: {
              _tag: 'TurnFailed',
              ...ev(turnId),
              code: 'overloaded',
              message: 'busy',
              retryable: true,
            },
          },
          { _tag: 'error', error: { code: 'overloaded', message: 'busy', retryable: true } },
          { _tag: 'done', outcome: 'failed' },
        ]);
      },
    });
    await h.runner.autoStart();
    expect(tags(await h.log()).filter((t) => t === 'TurnFailed')).toHaveLength(1);
    await h.runner.retry();
    // retry sends a new turn with the same (empty) input
    expect((await h.session()).turns).toHaveLength(2);
  });

  it('writes figure bodies with the batch: text as is, base64 as bytes', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"/>';
    const png = new Uint8Array([137, 80, 78, 71]);
    const h = await setup({
      serve: (request) => {
        const turnId = projectSession(request.log).pipe(Result.getOrThrow).turns.at(-1)!.turnId;
        const added = (figureId: string, kind: 'svg' | 'image', bytes: number) =>
          ({
            _tag: 'event',
            event: {
              _tag: 'FigureAdded',
              ...ev(turnId),
              figureId,
              kind,
              title: figureId,
              mime: kind === 'svg' ? 'image/svg+xml' : 'image/png',
              bytes,
            },
          }) as const;
        return body([
          { _tag: 'figure', figureId: 'f1', encoding: 'text', body: svg },
          {
            _tag: 'figure',
            figureId: 'f2',
            encoding: 'base64',
            body: btoa(String.fromCharCode(...png)),
          },
          added('f1', 'svg', svg.length),
          added('f2', 'image', png.length),
          { _tag: 'event', event: { _tag: 'TurnCompleted', ...ev(turnId), reason: 'stop' } },
          { _tag: 'done', outcome: 'completed' },
        ]);
      },
    });
    await h.runner.autoStart();
    expect(tags(await h.log())).toContain('FigureAdded');
    expect(await Effect.runPromise(h.storage.readFigure('f1'))).toEqual({
      figureId: 'f1',
      body: svg,
    });
    expect(await Effect.runPromise(h.storage.readFigure('f2'))).toEqual({
      figureId: 'f2',
      body: png,
    });
  });

  it('drops a batch that breaks the projection and leaves the turn open', async () => {
    const h = await setup({
      serve: (request) => {
        const turnId = projectSession(request.log).pipe(Result.getOrThrow).turns.at(-1)!.turnId;
        return body([
          { _tag: 'event', event: { _tag: 'StepCompleted', ...ev(turnId), stepId: 'zzz' } },
          { _tag: 'done', outcome: 'completed' },
        ]);
      },
    });
    await h.runner.autoStart();
    expect(tags(await h.log())).toEqual(['SessionCreated', 'TurnStarted']);
    expect(h.runner.getSnapshot().main.failure?.code).toBe('InvalidLog');
    expect(findInterruptedTurn(await h.session())).toBeDefined();
  });

  it('refuses to run when another tab holds the lock, and writes nothing', async () => {
    const h = await setup({ lock: async () => ({ acquired: false }) });
    await h.runner.send('hello');
    expect(tags(await h.log())).toEqual(['SessionCreated']);
    expect(h.runner.getSnapshot().main.failure?.code).toBe('Busy');
    // an automatic start in the losing tab stays quiet
    const quiet = await setup({ lock: async () => ({ acquired: false }) });
    await quiet.runner.autoStart();
    expect(quiet.runner.getSnapshot().main.failure).toBeUndefined();
  });

  it('does not run two turns at once in one tab', async () => {
    const h = await setup();
    await Promise.all([h.runner.autoStart(), h.runner.autoStart()]);
    expect(h.requests).toHaveLength(1);
  });
});

describe('skip a step', () => {
  const profile = { ...defaultProfile, maxTurnsPerStep: 1 };
  const completed: string[] = [];
  const teaching = async () => {
    const h = await setup({ profile, onSessionCompleted: (id) => completed.push(id) });
    await h.runner.autoStart();
    await h.runner.send('ASSESS');
    await h.runner.send('not yet');
    return h;
  };

  it('moves on after M turns, and finishes the session when the last step is skipped', async () => {
    const h = await teaching();
    expect((await h.session()).state).toEqual({ _tag: 'Teaching', stepId: 'a', turnsInStep: 1 });
    await h.runner.skipStep('a');
    expect((await h.session()).state).toEqual({ _tag: 'Teaching', stepId: 'b', turnsInStep: 0 });
    await h.runner.send('not yet');
    await h.runner.skipStep('b');
    const session = await h.session();
    expect(session.state._tag).toBe('Done');
    expect(session.skippedSteps).toEqual(['a', 'b']);
    expect(tags(await h.log()).slice(-2)).toEqual(['StepSkipped', 'SessionCompleted']);
    // Extraction is started by the batch that ends the session (phase 3 A3).
    expect(completed).toEqual([SESSION]);
  });

  it('ignores a stale request and a skip before M turns', async () => {
    const h = await teaching();
    await h.runner.skipStep('b'); // not the current step
    expect((await h.session()).skippedSteps).toEqual([]);
    const fresh = await setup({ profile: { ...defaultProfile, maxTurnsPerStep: 3 } });
    await fresh.runner.autoStart();
    await fresh.runner.send('ASSESS');
    await fresh.runner.skipStep('a');
    expect((await fresh.session()).skippedSteps).toEqual([]);
  });
});

describe('side chat', () => {
  it('writes the learner message first, then the answer', async () => {
    const h = await setup();
    await h.runner.autoStart();
    await h.runner.sendSide('general', 'What is a borrow?');
    const thread = (await h.session()).sideThreads['general']!;
    expect(thread.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(h.requests.at(-1)!.turn).toEqual({ kind: 'side', threadId: 'general' });
    expect(h.requests.at(-1)!.log.at(-1)).toMatchObject({ role: 'user' });
    expect(h.runner.getSnapshot().side).toMatchObject({ running: false, failure: undefined });
  });

  it('records a failed answer and retries without a second learner message', async () => {
    let fail = true;
    const h = await setup({
      serve: (request) =>
        request.turn.kind === 'side' && fail
          ? body([
              { _tag: 'error', error: { code: 'overloaded', message: 'busy', retryable: true } },
              { _tag: 'done', outcome: 'failed' },
            ])
          : body(reply(request)),
    });
    await h.runner.autoStart();
    await h.runner.sendSide('general', 'Question?');
    expect(tags(await h.log()).at(-1)).toBe('SideTurnFailed');
    expect(h.runner.getSnapshot().side.failure?.code).toBe('overloaded');

    fail = false;
    await h.runner.retrySide('general');
    const thread = (await h.session()).sideThreads['general']!;
    expect(thread.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(h.runner.getSnapshot().side.failure).toBeUndefined();
  });
});

describe('appendBatch', () => {
  it('does not write twice when a timeout hid a successful write', async () => {
    const memory = makeMemoryStorage();
    let first = true;
    const flaky: StorageService = {
      ...memory,
      appendEvents: (sessionId, events) =>
        first
          ? memory.appendEvents(sessionId, events).pipe(
              Effect.flatMap(() => {
                first = false;
                return Effect.fail(new StorageBusy({ message: 'timeout' }));
              }),
            )
          : memory.appendEvents(sessionId, events),
    };
    await Effect.runPromise(memory.appendEvents(SESSION, [created()]));
    const started: DomainEvent = { _tag: 'TurnStarted', id: 'x1', at: 2, turnId: 't', input: '' };
    await appendBatch(flaky, SESSION, [started]);
    expect(await Effect.runPromise(memory.readSession(SESSION))).toHaveLength(2);
  });
});
