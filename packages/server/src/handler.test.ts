import { Effect, Layer, Schema, Stream } from 'effect';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultProfile } from '@kd-learn/agent';
import { AiPort, ProviderError } from '@kd-learn/ai/port';
import type { AiError, TurnEvent, TurnRequest as AiTurnRequest } from '@kd-learn/ai/port';
import type { DomainEvent } from '@kd-learn/core';
import { Frame, encodeFrame, listEndpoints, makeSseParser, streamTurn } from '@kd-learn/api';
import type { TurnRequest } from '@kd-learn/api';
import { DEFAULT_MAX_REQUEST_BYTES, createHandlers, handleTurns, loadConfig } from './index.ts';
import type { HandlerDeps, LogEntry, ServerConfig } from './index.ts';

const KEY = 'sk-ant-SECRET-key-0123456789';

type Run = (request: AiTurnRequest) => Stream.Stream<TurnEvent<never>, AiError>;
const fakeAi = (run: Run) =>
  Layer.succeed(AiPort, { runTurn: run as AiPort['Service']['runTurn'] });

const say =
  (text = 'Hello there'): Run =>
  () =>
    Stream.fromIterable<TurnEvent<never>>([
      { _tag: 'TextDelta', messageId: 'pm1', delta: text.slice(0, 5) },
      { _tag: 'TextDelta', messageId: 'pm1', delta: text.slice(5) },
      { _tag: 'Usage', inputTokens: 10, outputTokens: 4 },
      { _tag: 'Finish', reason: 'stop' },
    ]);

const config = (over: Partial<ServerConfig> = {}): ServerConfig => ({
  maxRequestBytes: DEFAULT_MAX_REQUEST_BYTES,
  endpoints: [{ id: 'acme', label: 'Acme AI', baseURL: 'https://llm.acme.test/v1' }],
  corsOrigins: [],
  searxngUrl: undefined,
  ...over,
});

let ids = 0;
const deps = (
  run: Run,
  over: Partial<HandlerDeps> = {},
): HandlerDeps & { logs: Array<LogEntry> } => {
  const logs: Array<LogEntry> = [];
  return {
    config: config(),
    ai: fakeAi(run),
    log: (entry) => logs.push(entry),
    newId: () => `gen${++ids}`,
    ...over,
    logs,
  };
};

const baseLog = (): Array<DomainEvent> => [
  {
    _tag: 'SessionCreated',
    id: 'e1',
    at: 1,
    sessionId: 's1',
    topic: 'Rust ownership',
    profile: defaultProfile,
  },
  { _tag: 'TurnStarted', id: 'e2', at: 2, turnId: 't1', input: 'Hi' },
];

const mainRequest = (over: Partial<TurnRequest> = {}): TurnRequest => ({
  model: { provider: 'anthropic', model: 'claude-haiku', apiKey: KEY },
  turn: { kind: 'main' },
  log: baseLog(),
  ...over,
});

const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request('http://app.test/api/turns', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const readFrames = async (response: Response): Promise<Array<Frame>> => {
  const parser = makeSseParser();
  const text = await response.text();
  return parser
    .push(text)
    .map((message) => Schema.decodeUnknownSync(Frame)(JSON.parse(message.data)));
};

const errorOf = async (response: Response) =>
  ((await response.json()) as { error: { code: string; message: string } }).error;

afterEach(() => vi.restoreAllMocks());

describe('POST /api/turns: main turn', () => {
  it('streams delta, event and done frames, in the contract', async () => {
    const d = deps(say());
    const response = await handleTurns(post(mainRequest()), d);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const frames = await readFrames(response);
    expect(frames.map((f) => f._tag)).toEqual([
      'delta',
      'delta',
      'event',
      'event',
      'event',
      'done',
    ]);
    const events = frames.flatMap((f) => (f._tag === 'event' ? [f.event._tag] : []));
    expect(events).toEqual(['MessageAppended', 'UsageRecorded', 'TurnCompleted']);
    expect(frames.at(-1)).toEqual({ _tag: 'done', outcome: 'completed' });
  });

  it('runs a side chat for the thread', async () => {
    const side: DomainEvent = {
      _tag: 'SideMessageAppended',
      id: 'e3',
      at: 3,
      threadId: 'th1',
      messageId: 'sm1',
      role: 'user',
      content: 'What is a move?',
    };
    const d = deps(say('A side answer'));
    const response = await handleTurns(
      post(mainRequest({ turn: { kind: 'side', threadId: 'th1' }, log: [...baseLog(), side] })),
      d,
    );
    const frames = await readFrames(response);
    const events = frames.flatMap((f) => (f._tag === 'event' ? [f.event._tag] : []));
    expect(events).toEqual(['SideMessageAppended']);
    expect(frames.at(-1)).toEqual({ _tag: 'done', outcome: 'completed' });
  });

  it('reports a log that cannot start a turn as an InvalidTurn error frame', async () => {
    const response = await handleTurns(
      post(mainRequest({ log: [baseLog()[0] as DomainEvent] })),
      deps(say()),
    );
    const frames = await readFrames(response);
    expect(frames).toMatchObject([
      { _tag: 'error', error: { code: 'InvalidTurn', retryable: false } },
      { _tag: 'done', outcome: 'failed' },
    ]);
  });

  it('records a provider failure as events plus an error frame', async () => {
    const run: Run = () =>
      Stream.fail(new ProviderError({ message: 'overloaded', code: 'overloaded_error' }));
    const frames = await readFrames(await handleTurns(post(mainRequest()), deps(run)));
    const events = frames.flatMap((f) => (f._tag === 'event' ? [f.event._tag] : []));
    expect(events).toEqual(['TurnFailed']);
    expect(frames.slice(-2)).toMatchObject([
      { _tag: 'error', error: { code: 'overloaded_error' } },
      { _tag: 'done', outcome: 'failed' },
    ]);
  });

  it('works end to end with the typed client', async () => {
    const handlers = createHandlers({}, { ai: fakeAi(say()), log: () => undefined });
    const fetchImpl: typeof fetch = (input, init) => handlers.turns(new Request(input, init));
    const out = await Effect.runPromise(
      Stream.runCollect(
        streamTurn(mainRequest(), { fetch: fetchImpl, baseUrl: 'http://app.test' }),
      ),
    );
    expect(out.at(-1)).toEqual({ _tag: 'done', outcome: 'completed' });
    expect(out.some((f) => f._tag === 'event')).toBe(true);
  });

  it('passes the configured base URL of an allowed endpoint, and only that', async () => {
    const seen: Array<AiTurnRequest['model']> = [];
    const run: Run = (request) => {
      seen.push(request.model);
      return say()(request);
    };
    await (
      await handleTurns(
        post(
          mainRequest({
            model: { provider: 'openai-compatible', endpointId: 'acme', model: 'm1', apiKey: KEY },
          }),
        ),
        deps(run),
      )
    ).text();
    expect(seen).toEqual([
      {
        provider: 'openai-compatible',
        model: 'm1',
        apiKey: KEY,
        baseURL: 'https://llm.acme.test/v1',
      },
    ]);
  });
});

describe('request validation', () => {
  const never = vi.fn(say());
  const rejects = async (body: unknown, status: number, code: string, d = deps(never)) => {
    const response = await handleTurns(post(body), d);
    expect(response.status).toBe(status);
    const error = await errorOf(response);
    expect(error.code).toBe(code);
    expect(never).not.toHaveBeenCalled();
    return error;
  };

  it('rejects an unknown endpoint id', async () => {
    await rejects(
      mainRequest({
        model: { provider: 'openai-compatible', endpointId: 'nope', model: 'm', apiKey: KEY },
      }),
      400,
      'UnknownEndpoint',
    );
  });

  it('rejects a free baseURL, in any casing, on any provider', async () => {
    for (const field of ['baseURL', 'baseUrl', 'baseurl']) {
      for (const model of [
        { provider: 'anthropic', model: 'm', apiKey: KEY },
        { provider: 'openai-compatible', endpointId: 'acme', model: 'm', apiKey: KEY },
      ]) {
        const error = await rejects(
          { ...mainRequest(), model: { ...model, [field]: 'http://169.254.169.254/' } },
          400,
          'InvalidRequest',
        );
        expect(error.message).toContain('baseURL');
      }
    }
  });

  it('rejects unknown fields instead of dropping them', async () => {
    const error = await rejects({ ...mainRequest(), extra: 1 }, 400, 'InvalidRequest');
    expect(error.message).toContain('extra');
  });

  it('rejects ACP, a bad shape and non-JSON', async () => {
    await rejects(
      { ...mainRequest(), model: { provider: 'acp', agent: 'claude-code' } },
      400,
      'InvalidRequest',
    );
    await rejects({ ...mainRequest(), turn: { kind: 'side' } }, 400, 'InvalidRequest');
    await rejects('{not json', 400, 'InvalidRequest');
    await rejects({}, 400, 'InvalidRequest');
  });

  it('answers 405 to other methods', async () => {
    const response = await handleTurns(
      new Request('http://app.test/api/turns', { method: 'GET' }),
      deps(never),
    );
    expect(response.status).toBe(405);
  });
});

describe('size limit (plan A8)', () => {
  const bigLog = (): Array<DomainEvent> => [
    ...baseLog(),
    {
      _tag: 'MessageAppended',
      id: 'e3',
      at: 3,
      turnId: 't1',
      messageId: 'm1',
      agent: 'prober',
      content: 'x'.repeat(5000),
    },
  ];

  it('refuses a body above the limit with HistoryTooLarge, by content-length', async () => {
    const run = vi.fn(say());
    const d = deps(run, { config: config({ maxRequestBytes: 2048 }) });
    const response = await handleTurns(post(mainRequest({ log: bigLog() })), d);
    expect(response.status).toBe(413);
    expect((await errorOf(response)).code).toBe('HistoryTooLarge');
    expect(run).not.toHaveBeenCalled();
  });

  it('refuses it without a content-length too (chunked body), and stops reading', async () => {
    const run = vi.fn(say());
    const d = deps(run, { config: config({ maxRequestBytes: 2048 }) });
    const chunk = new TextEncoder().encode('a'.repeat(1000));
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        if (pulled > 100) controller.close();
        else controller.enqueue(chunk);
      },
    });
    const request = new Request('http://app.test/api/turns', {
      method: 'POST',
      body,
      duplex: 'half',
    } as RequestInit);
    const response = await handleTurns(request, d);
    expect(response.status).toBe(413);
    expect(pulled).toBeLessThan(10);
    expect(run).not.toHaveBeenCalled();
  });

  it('accepts a body just under the limit', async () => {
    const body = JSON.stringify(mainRequest());
    const d = deps(say(), {
      config: config({ maxRequestBytes: new TextEncoder().encode(body).length }),
    });
    expect((await handleTurns(post(body), d)).status).toBe(200);
  });

  it('defaults to 1 MiB', () => {
    expect(loadConfig({}).maxRequestBytes).toBe(1_048_576);
    expect(loadConfig({ KD_MAX_REQUEST_BYTES: '4096' }).maxRequestBytes).toBe(4096);
  });
});

describe('cancel (plan 3.3, A3)', () => {
  /** A model that says one word and then waits forever, recording whether it was interrupted. */
  const hanging = () => {
    const state = { started: false, released: false };
    const run: Run = () =>
      Stream.fromIterable<TurnEvent<never>>([
        { _tag: 'TextDelta', messageId: 'pm1', delta: 'Hel' },
      ]).pipe(
        Stream.concat(Stream.never),
        Stream.ensuring(Effect.sync(() => (state.released = true))),
        Stream.tap(() => Effect.sync(() => (state.started = true))),
      );
    return { run, state };
  };
  const waitFor = async (check: () => boolean) => {
    for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
    expect(check()).toBe(true);
  };

  it('interrupts the model run when the client drops the response body', async () => {
    const { run, state } = hanging();
    const d = deps(run);
    const response = await handleTurns(post(mainRequest()), d);
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain('"delta"');
    expect(state.released).toBe(false);
    await reader.cancel();
    await waitFor(() => state.released);
    await waitFor(() => d.logs.some((l) => l.event === 'turn.end'));
    expect(d.logs.find((l) => l.event === 'turn.end')?.fields.outcome).toBe('cancelled');
  });

  it('interrupts the model run when the request signal aborts', async () => {
    const { run, state } = hanging();
    const controller = new AbortController();
    const request = new Request('http://app.test/api/turns', {
      method: 'POST',
      body: JSON.stringify(mainRequest()),
      signal: controller.signal,
    });
    const response = await handleTurns(request, deps(run));
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    await reader.read();
    controller.abort();
    await waitFor(() => state.released);
  });
});

describe('the key never leaves in logs or errors (plan A7, risk 19)', () => {
  const spyConsole = () =>
    (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined),
    );
  const everything = (
    spies: ReturnType<typeof spyConsole>,
    d: { logs: Array<LogEntry> },
    text: string,
  ) => JSON.stringify([d.logs, spies.map((s) => s.mock.calls), text]);

  it('holds through every failure path', async () => {
    const spies = spyConsole();
    const runs: Array<[string, Run, TurnRequest]> = [
      ['ok', say(), mainRequest()],
      [
        'provider error echoing the key',
        () =>
          Stream.fail(
            new ProviderError({
              message: `401 invalid x-api-key ${KEY}`,
              code: 'authentication_error',
            }),
          ),
        mainRequest(),
      ],
      ['defect carrying the key', () => Stream.die(new Error(`boom ${KEY}`)), mainRequest()],
      [
        'adapter throwing while building',
        () => {
          throw new Error(`bad adapter config ${KEY}`);
        },
        mainRequest(),
      ],
      ['bad log', say(), mainRequest({ log: [baseLog()[1] as DomainEvent] })],
    ];
    for (const [name, run, request] of runs) {
      const d = deps(run);
      const response = await handleTurns(post(request), d);
      const text = await response.text();
      expect(everything(spies, d, text), name).not.toContain(KEY);
      expect(d.logs.length, name).toBeGreaterThan(0);
    }
  });

  it('holds for rejected requests, including a key where it does not belong', async () => {
    const spies = spyConsole();
    const bodies: Array<unknown> = [
      { ...mainRequest(), extra: KEY },
      { ...mainRequest(), turn: { kind: KEY } },
      { ...mainRequest(), model: { provider: KEY, model: 'm', apiKey: KEY } },
      { ...mainRequest(), model: { provider: 'anthropic', model: 7, apiKey: KEY, baseURL: KEY } },
      mainRequest({
        model: { provider: 'openai-compatible', endpointId: 'nope', model: 'm', apiKey: KEY },
      }),
      `{"apiKey":"${KEY}"`,
    ];
    for (const body of bodies) {
      const d = deps(say());
      const response = await handleTurns(post(body), d);
      expect(response.status).toBeGreaterThanOrEqual(400);
      const text = await response.text();
      expect(everything(spies, d, text)).not.toContain(KEY);
    }
    const tooBig = deps(say(), { config: config({ maxRequestBytes: 1024 }) });
    const huge = mainRequest({
      log: [
        ...baseLog(),
        {
          _tag: 'MessageAppended',
          id: 'e3',
          at: 3,
          turnId: 't1',
          messageId: 'm',
          agent: 'prober',
          content: 'y'.repeat(2000),
        },
      ],
    });
    const response = await handleTurns(post(huge), tooBig);
    expect(everything(spies, tooBig, await response.text())).not.toContain(KEY);
  });

  it('logs only whitelisted scalar fields and no header or body', async () => {
    const d = deps(say());
    await (
      await handleTurns(
        post(mainRequest(), { authorization: `Bearer ${KEY}`, 'x-api-key': KEY }),
        d,
      )
    ).text();
    const text = JSON.stringify(d.logs);
    expect(text).not.toContain(KEY);
    expect(d.logs.map((l) => l.event)).toEqual(['turn.start', 'turn.end']);
    for (const entry of d.logs) {
      for (const value of Object.values(entry.fields)) {
        expect(['string', 'number', 'boolean']).toContain(typeof value);
      }
    }
    expect(d.logs[1]?.fields).toMatchObject({
      outcome: 'completed',
      provider: 'anthropic',
      kind: 'main',
    });
  });
});

describe('endpoints and configuration', () => {
  it('lists endpoint ids and labels without base URLs', async () => {
    const handlers = createHandlers({
      KD_OPENAI_COMPATIBLE_ENDPOINTS: JSON.stringify([
        { id: 'acme', label: 'Acme AI', baseURL: 'https://llm.acme.test/v1' },
        { id: 'local', baseURL: 'http://localhost:11434/v1' },
      ]),
    });
    const fetchImpl: typeof fetch = (input, init) => handlers.endpoints(new Request(input, init));
    const list = await Effect.runPromise(
      listEndpoints({ fetch: fetchImpl, baseUrl: 'http://app.test' }),
    );
    expect(list).toEqual([
      { id: 'acme', label: 'Acme AI' },
      { id: 'local', label: 'local' },
    ]);
    const raw = await (
      await handlers.endpoints(new Request('http://app.test/api/endpoints'))
    ).text();
    expect(raw).not.toContain('llm.acme.test');
  });

  it.each([
    ['not json', '{'],
    ['not an array', '{"id":"a"}'],
    ['missing baseURL', '[{"id":"a"}]'],
    ['bad id', '[{"id":"A B","baseURL":"https://x.test"}]'],
    ['not a url', '[{"id":"a","baseURL":"nope"}]'],
    ['file scheme', '[{"id":"a","baseURL":"file:///etc/passwd"}]'],
    ['embedded credentials', '[{"id":"a","baseURL":"https://u:p@x.test"}]'],
    [
      'duplicate id',
      '[{"id":"a","baseURL":"https://x.test"},{"id":"a","baseURL":"https://y.test"}]',
    ],
  ])('refuses a bad endpoint list: %s', (_name, value) => {
    expect(() => loadConfig({ KD_OPENAI_COMPATIBLE_ENDPOINTS: value })).toThrow(
      /KD_OPENAI_COMPATIBLE_ENDPOINTS/,
    );
  });

  it('refuses a too small size limit', () => {
    expect(() => loadConfig({ KD_MAX_REQUEST_BYTES: '10' })).toThrow(/KD_MAX_REQUEST_BYTES/);
  });

  it('answers 500 ServerMisconfigured on every route when the configuration is invalid', async () => {
    const logs: Array<LogEntry> = [];
    const handlers = createHandlers(
      { KD_OPENAI_COMPATIBLE_ENDPOINTS: '{' },
      { log: (entry) => logs.push(entry) },
    );
    for (const handler of [handlers.turns, handlers.endpoints]) {
      const response = await handler(post(mainRequest()));
      expect(response.status).toBe(500);
      expect((await errorOf(response)).code).toBe('ServerMisconfigured');
    }
    expect(logs[0]?.event).toBe('config.invalid');
  });

  it('adds CORS headers only for configured origins, and answers preflight', async () => {
    const d = deps(say(), { config: config({ corsOrigins: ['capacitor://localhost'] }) });
    const allowed = await handleTurns(post(mainRequest(), { origin: 'capacitor://localhost' }), d);
    expect(allowed.headers.get('access-control-allow-origin')).toBe('capacitor://localhost');
    await allowed.text();
    const other = await handleTurns(post(mainRequest(), { origin: 'https://evil.test' }), d);
    expect(other.headers.get('access-control-allow-origin')).toBeNull();
    await other.text();
    const preflight = await handleTurns(
      new Request('http://app.test/api/turns', {
        method: 'OPTIONS',
        headers: { origin: 'capacitor://localhost' },
      }),
      d,
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-headers')).toContain('content-type');
  });

  it('encodes frames the client can parse back (wire format)', () => {
    const wire = encodeFrame({ _tag: 'done', outcome: 'completed' });
    expect(wire).toBe('event: done\ndata: {"_tag":"done","outcome":"completed"}\n\n');
  });
});

describe('POST /api/turns: figures (phase 5)', () => {
  const teachingLog = (): Array<DomainEvent> => [
    {
      _tag: 'SessionCreated',
      id: 'f1',
      at: 1,
      sessionId: 's1',
      topic: 'Circles',
      profile: defaultProfile,
    },
    { _tag: 'TurnStarted', id: 'f2', at: 1, turnId: 't0', input: '' },
    {
      _tag: 'AssessmentRecorded',
      id: 'f3',
      at: 1,
      turnId: 't0',
      level: 'beginner',
      summary: 's',
      strengths: [],
      gaps: [],
    },
    { _tag: 'TurnCompleted', id: 'f4', at: 1, turnId: 't0', reason: 'stop' },
    { _tag: 'TurnStarted', id: 'f5', at: 1, turnId: 't1', input: '' },
    {
      _tag: 'PlanCreated',
      id: 'f6',
      at: 1,
      turnId: 't1',
      plan: { nodes: [{ id: 'a', title: 'Radius', goal: 'Say what a radius is', dependsOn: [] }] },
    },
    { _tag: 'TurnCompleted', id: 'f7', at: 1, turnId: 't1', reason: 'stop' },
    { _tag: 'TurnStarted', id: 'f8', at: 2, turnId: 't2', input: 'go' },
  ];
  const callTool =
    (name: string, input: unknown): Run =>
    (request) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const spec = request.tools?.find((t) => t.name === name);
          if (spec === undefined) throw new Error(`No tool ${name}`);
          const decoded = yield* Schema.decodeUnknownEffect(spec.input)(input).pipe(Effect.orDie);
          const output = yield* spec
            .run(decoded)
            .pipe(
              Effect.catch((error) => Effect.succeed(`error: ${String((error as Error).message)}`)),
            );
          return Stream.fromIterable<TurnEvent<never>>([
            { _tag: 'ToolCall', id: 'c1', name, input },
            { _tag: 'ToolResult', id: 'c1', output: String(output) },
            { _tag: 'TextDelta', messageId: 'pm2', delta: 'Look.' },
            { _tag: 'Usage', inputTokens: 1, outputTokens: 1 },
            { _tag: 'Finish', reason: 'stop' },
          ]);
        }),
      );

  it('sends the body as a figure frame before the events', async () => {
    const html = '<button>go</button><script>1</script>';
    const d = deps(callTool('show_demo', { title: 'Demo', html, libraries: ['d3'] }));
    const frames = await readFrames(
      await handleTurns(post(mainRequest({ log: teachingLog() })), d),
    );
    const figure = frames.findIndex((f) => f._tag === 'figure');
    expect(frames[figure]).toMatchObject({ _tag: 'figure', encoding: 'text', body: html });
    expect(figure).toBeLessThan(frames.findIndex((f) => f._tag === 'event'));
    const added = frames.flatMap((f) =>
      f._tag === 'event' && f.event._tag === 'FigureAdded' ? [f.event] : [],
    );
    expect(added).toMatchObject([{ kind: 'html', libraries: ['d3'] }]);
  });

  it('refuses demo libraries when the admin turned the CDN off', async () => {
    const d = deps(callTool('show_demo', { title: 'Demo', html: '<p>x</p>', libraries: ['d3'] }), {
      figureCdn: async () => false,
    });
    const frames = await readFrames(
      await handleTurns(post(mainRequest({ log: teachingLog() })), d),
    );
    expect(frames.some((f) => f._tag === 'figure')).toBe(false);
  });
});
