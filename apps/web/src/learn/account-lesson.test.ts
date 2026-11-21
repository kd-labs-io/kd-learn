// The account lesson store over a scripted server: snapshot, stream, reconnect, gaps, 401 / 404.
import { encodeAccountFrame, type AccountFrame } from '@kd-learn/api';
import { defaultProfile } from '@kd-learn/agent/client';
import type { DomainEvent } from '@kd-learn/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../account/auth', () => ({ onUserChange: () => () => undefined }));

const { AccountLesson } = await import('./account-lesson');

const created: DomainEvent = {
  _tag: 'SessionCreated',
  id: 'e0',
  at: 1,
  sessionId: 's1',
  topic: 'Fractions',
  profile: defaultProfile,
};
const started = (n: number): DomainEvent => ({
  _tag: 'TurnStarted',
  id: `t${n}`,
  at: 2,
  turnId: `turn${n}`,
  input: '',
});

interface Script {
  snapshot: Array<Response | (() => Response)>;
  /** One body per stream request; then the stream stays open. */
  streams: Array<ReadonlyArray<AccountFrame> | Response>;
}

const sse = (frames: ReadonlyArray<AccountFrame>) =>
  new Response(frames.map(encodeAccountFrame).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });

const open = (signal: AbortSignal | null | undefined) =>
  new Response(
    new ReadableStream({
      start(controller) {
        signal?.addEventListener('abort', () => controller.error(new Error('aborted')));
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );

function server(script: Script) {
  const urls: string[] = [];
  const fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    urls.push(url);
    if (url.includes('/stream')) {
      const next = script.streams.shift();
      if (next === undefined) return open(init.signal);
      return next instanceof Response ? next : sse(next);
    }
    const next = script.snapshot.shift();
    if (next === undefined) throw new Error(`unexpected ${url}`);
    return typeof next === 'function' ? next() : next;
  }) as typeof globalThis.fetch;
  return { fetch, urls };
}

const snapshotOf = (events: DomainEvent[]) =>
  Response.json({ events: events.map((event, seq) => ({ seq, event })), running: [] });

const until = async (check: () => boolean) => {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('timed out');
};

const lessons: Array<InstanceType<typeof AccountLesson>> = [];
const make = (script: Script, onUnauthorized = () => undefined) => {
  const { fetch, urls } = server(script);
  const lesson = new AccountLesson('s1', {
    options: { fetch, token: 'tok' },
    onUnauthorized,
    backoff: () => 1,
  });
  lessons.push(lesson);
  lesson.subscribe(() => undefined);
  const log = () => {
    const view = lesson.getSnapshot().view;
    return view.status === 'ready' ? view.log.map((event) => event.id) : [];
  };
  return { lesson, urls, log };
};

afterEach(() => {
  lessons.splice(0).forEach((lesson) => lesson.close());
});

describe('AccountLesson', () => {
  it('reads the snapshot, then follows the stream from the last seq, again after it ends', async () => {
    const t = make({
      snapshot: [snapshotOf([created])],
      streams: [
        [
          { _tag: 'running', turns: [] },
          { _tag: 'log', seq: 1, event: started(1) },
        ],
        [{ _tag: 'running', turns: [] }],
      ],
    });
    await until(() => t.urls.length >= 3);
    expect(t.urls[1]).toContain('/stream?after=0');
    expect(t.urls[2]).toContain('/stream?after=1');
    expect(t.log()).toEqual(['e0', 't1']);
  });

  it('ignores an event it already has, and reloads the snapshot after a gap', async () => {
    const t = make({
      snapshot: [snapshotOf([created]), snapshotOf([created, started(1), started(2)])],
      streams: [
        [
          { _tag: 'log', seq: 0, event: created },
          { _tag: 'log', seq: 2, event: started(2) },
        ],
      ],
    });
    await until(() => t.log().length === 3);
    expect(t.log()).toEqual(['e0', 't1', 't2']);
    expect(t.urls.filter((url) => !url.includes('/stream'))).toHaveLength(2);
  });

  it('shows the text so far of a running turn, and the turn as running', async () => {
    const t = make({
      snapshot: [snapshotOf([created, started(1)])],
      streams: [
        [
          {
            _tag: 'running',
            turns: [{ turnId: 'turn1', kind: 'main', text: [{ messageId: 'm', text: 'Hel' }] }],
          },
          { _tag: 'delta', turnId: 'turn1', messageId: 'm', delta: 'lo' },
        ],
      ],
    });
    await until(() => t.lesson.getSnapshot().runner.main.live?.text === 'Hello');
    expect(t.lesson.getSnapshot().runner.main.running).toBe(true);
  });

  it('reports a session that is not there (or not ours) as not found', async () => {
    const t = make({
      snapshot: [
        Response.json(
          { error: { code: 'NotFound', message: 'Not found.', retryable: false } },
          { status: 404 },
        ),
      ],
      streams: [],
    });
    await until(() => t.lesson.getSnapshot().view.status === 'not-found');
  });

  it('signs out on 401', async () => {
    const onUnauthorized = vi.fn();
    make(
      {
        snapshot: [
          Response.json(
            { error: { code: 'Unauthorized', message: 'no', retryable: false } },
            { status: 401 },
          ),
        ],
        streams: [],
      },
      onUnauthorized,
    );
    await until(() => onUnauthorized.mock.calls.length === 1);
  });

  it('a refused start keeps nothing and says so; a quiet auto refusal shows no failure', async () => {
    const refusal = (code: string) =>
      Response.json({ error: { code, message: code, retryable: true } }, { status: 409 });
    const script: Script = { snapshot: [snapshotOf([created])], streams: [] };
    const t = make(script);
    await until(() => t.lesson.getSnapshot().view.status === 'ready');

    script.snapshot.push(refusal('TurnInProgress'));
    await t.lesson.autoStart();
    expect(t.lesson.getSnapshot().runner.main.failure).toBeUndefined();

    script.snapshot.push(refusal('RoleNotConfigured'));
    expect(await t.lesson.send('hi')).toBe(false);
    expect(t.lesson.getSnapshot().runner.main.failure?.code).toBe('RoleNotConfigured');
    expect(t.lesson.getSnapshot().runner.main.running).toBe(false);
  });
});
