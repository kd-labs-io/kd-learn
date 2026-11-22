import { Effect, Layer, Stream } from 'effect';
import { describe, expect, it } from 'vitest';
import { AiPort, ProviderError } from '@kd-learn/ai/port';
import type { AiError, TurnEvent, TurnRequest } from '@kd-learn/ai/port';
import { testModel } from '@kd-learn/api';
import { makeRateLimiter } from '../auth/rate-limit.ts';
import { DEFAULT_MAX_REQUEST_BYTES } from '../config.ts';
import type { HandlerDeps, LogEntry } from '../handler.ts';
import { handleModelTest } from './model-test-route.ts';

const KEY = 'sk-ant-SECRET-key-0123456789';

type Run = (request: TurnRequest) => Stream.Stream<TurnEvent<never>, AiError>;

const deps = (run: Run, over: Partial<HandlerDeps> = {}) => {
  const logs: Array<LogEntry> = [];
  const seen: Array<TurnRequest> = [];
  const value: HandlerDeps = {
    config: {
      maxRequestBytes: DEFAULT_MAX_REQUEST_BYTES,
      endpoints: [
        { id: 'acme', label: 'Acme', baseURL: 'https://llm.acme.test/v1', images: false },
      ],
      corsOrigins: [],
      searxngUrl: undefined,
    },
    ai: Layer.succeed(AiPort, {
      runTurn: ((request: TurnRequest) => {
        seen.push(request);
        return run(request);
      }) as AiPort['Service']['runTurn'],
    }),
    log: (entry) => logs.push(entry),
    ...over,
  };
  return { value, logs, seen };
};

const ok: Run = () =>
  Stream.fromIterable<TurnEvent<never>>([
    { _tag: 'TextDelta', messageId: 'm1', delta: 'ok' },
    { _tag: 'Finish', reason: 'stop' },
  ]);

const fetchVia =
  (d: HandlerDeps, context?: { clientAddress: string }): typeof fetch =>
  (input, init) =>
    handleModelTest(new Request(String(input), init), d, context);

const run = (d: HandlerDeps, model: unknown) =>
  handleModelTest(
    new Request('http://app.test/api/models/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model }),
    }),
    d,
  );

describe('POST /api/models/test', () => {
  it('answers ok when the model replies, with one small call', async () => {
    const d = deps(ok);
    const failure = await Effect.runPromise(
      testModel(
        { model: { provider: 'anthropic', model: 'claude-haiku', apiKey: KEY } },
        { baseUrl: 'http://app.test', fetch: fetchVia(d.value) },
      ),
    );
    expect(failure).toBeUndefined();
    expect(d.seen).toHaveLength(1);
    expect(d.seen[0]?.maxSteps).toBe(1);
    expect(d.seen[0]?.tools ?? []).toHaveLength(0);
  });

  it('returns the provider failure without the key', async () => {
    const d = deps(() =>
      Stream.fail(new ProviderError({ message: `401 invalid x-api-key ${KEY}`, code: '401' })),
    );
    const response = await run(d.value, { provider: 'gemini', model: 'g', apiKey: KEY });
    expect(response.status).toBe(502);
    const text = await response.text();
    expect(text).not.toContain(KEY);
    expect(JSON.parse(text).error).toMatchObject({ code: '401', retryable: false });
    expect(JSON.stringify(d.logs)).not.toContain(KEY);
  });

  it('refuses demo, a free baseURL and an unknown endpoint', async () => {
    const d = deps(ok);
    expect((await run(d.value, { provider: 'demo' })).status).toBe(400);
    expect(
      (
        await run(d.value, {
          provider: 'openai-compatible',
          endpointId: 'acme',
          model: 'm',
          apiKey: KEY,
          baseURL: 'http://169.254.169.254',
        })
      ).status,
    ).toBe(400);
    const unknown = await run(d.value, {
      provider: 'openai-compatible',
      endpointId: 'nope',
      model: 'm',
      apiKey: KEY,
    });
    expect(((await unknown.json()) as { error: { code: string } }).error.code).toBe(
      'UnknownEndpoint',
    );
    expect(d.seen).toHaveLength(0);
  });

  it('is refused when guest mode is off', async () => {
    const d = deps(ok, { guestAllowed: async () => false });
    const response = await run(d.value, { provider: 'anthropic', model: 'm', apiKey: KEY });
    expect(response.status).toBe(403);
  });

  it('limits tests per address', async () => {
    const d = deps(ok, { modelTestLimit: makeRateLimiter({ limit: 1, windowMs: 60_000 }) });
    const call = () =>
      handleModelTest(
        new Request('http://app.test/api/models/test', {
          method: 'POST',
          body: JSON.stringify({ model: { provider: 'anthropic', model: 'm', apiKey: KEY } }),
        }),
        d.value,
        { clientAddress: '10.0.0.1' },
      );
    expect((await call()).status).toBe(200);
    expect((await call()).status).toBe(429);
  });
});
