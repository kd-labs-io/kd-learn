import { Effect, Exit, Stream } from 'effect';
import { describe, expect, it } from 'vitest';
import { ApiError, accountClient, streamSession } from './account-client.ts';
import { encodeAccountFrame } from './sse.ts';

const fakeFetch = (respond: (url: string, init: RequestInit) => Response) => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    return respond(String(input), init);
  }) as typeof globalThis.fetch;
  return { fetch, calls };
};

const failureOf = async <A>(effect: Effect.Effect<A, ApiError>) => {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) throw new Error('expected a failure');
  const error = exit.cause.reasons.find((reason) => reason._tag === 'Fail')?.error;
  if (!(error instanceof ApiError)) throw new Error('expected an ApiError');
  return error;
};

describe('account client', () => {
  it('sends the token as Bearer and decodes the answer', async () => {
    const { fetch, calls } = fakeFetch(() =>
      Response.json({ user: { id: 'u1', email: 'a@b.test', role: 'user' } }),
    );
    const me = await Effect.runPromise(
      accountClient({ fetch, token: 'tok', baseUrl: 'https://kd.test/' }).me(),
    );
    expect(me.user.id).toBe('u1');
    expect(calls[0]?.url).toBe('https://kd.test/api/auth/me');
    expect((calls[0]?.init.headers as Record<string, string>).authorization).toBe('Bearer tok');
  });

  it('keeps the error code and status of an error response', async () => {
    const { fetch } = fakeFetch(() =>
      Response.json(
        { error: { code: 'TurnInProgress', message: 'busy', retryable: true } },
        { status: 409 },
      ),
    );
    const error = await failureOf(accountClient({ fetch }).startTurn('s1', { kind: 'auto' }));
    expect(error.status).toBe(409);
    expect(error.failure.code).toBe('TurnInProgress');
  });

  it('turns a network failure into status 0', async () => {
    const fetch = (() => Promise.reject(new TypeError('offline'))) as typeof globalThis.fetch;
    const error = await failureOf(accountClient({ fetch }).sessions());
    expect(error.status).toBe(0);
    expect(error.failure.code).toBe('Network');
  });

  it('streams account frames, ignoring pings, and asks from `after`', async () => {
    const body = [
      encodeAccountFrame({ _tag: 'running', turns: [] }),
      ': ping\n\n',
      encodeAccountFrame({ _tag: 'delta', turnId: 't1', messageId: 'm1', delta: 'Hi' }),
    ].join('');
    const { fetch, calls } = fakeFetch(
      () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
    );
    const frames = await Effect.runPromise(
      Stream.runCollect(streamSession('s1', 4, { fetch, token: 'tok' })),
    );
    expect(Array.from(frames).map((frame) => frame._tag)).toEqual(['running', 'delta']);
    expect(calls[0]?.url).toBe('/api/account/sessions/s1/stream?after=4');
  });
});
