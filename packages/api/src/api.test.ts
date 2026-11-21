import { Effect, Exit, Result, Schema, Stream } from 'effect';
import { describe, expect, it } from 'vitest';
import {
  ClientError,
  ErrorCode,
  Frame,
  ModelChoice,
  TurnRequest,
  encodeFrame,
  listEndpoints,
  makeSseParser,
  streamTurn,
} from './index.ts';

const request: TurnRequest = {
  model: { provider: 'anthropic', model: 'claude-haiku', apiKey: 'sk-test-key-123456' },
  turn: { kind: 'main' },
  log: [],
};

const frames: ReadonlyArray<Frame> = [
  { _tag: 'delta', messageId: 'm1', delta: 'Hel' },
  { _tag: 'delta', messageId: 'm1', delta: 'lo\nworld' },
  {
    _tag: 'event',
    event: { _tag: 'TurnCompleted', id: 'e1', at: 5, turnId: 't1', reason: 'stop' },
  },
  { _tag: 'done', outcome: 'completed' },
];

const sse = (list: ReadonlyArray<Frame>) => list.map(encodeFrame).join('');

/** A fetch that answers with `body`, delivered in the given chunks. */
const fakeFetch =
  (chunks: ReadonlyArray<string>, init: ResponseInit = {}): typeof fetch =>
  async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    return new Response(body, { status: 200, ...init });
  };

const run = (fetchImpl: typeof fetch) =>
  Effect.runPromiseExit(
    Stream.runCollect(streamTurn(request, { fetch: fetchImpl, baseUrl: 'http://x' })),
  );

describe('contract', () => {
  it('has no field that carries a free base URL', () => {
    const decode = Schema.decodeUnknownResult(ModelChoice);
    const withBase = {
      provider: 'openai-compatible',
      endpointId: 'acme',
      model: 'm',
      apiKey: 'k',
      baseURL: 'http://169.254.169.254',
    };
    // Excess properties are dropped by default; the server decodes with `onExcessProperty: 'error'`.
    const lenient = decode(withBase);
    expect(Result.isSuccess(lenient) && 'baseURL' in lenient.success).toBe(false);
    const strict = Schema.decodeUnknownResult(ModelChoice)(withBase, { onExcessProperty: 'error' });
    expect(Result.isFailure(strict)).toBe(true);
  });

  it('rejects ACP and an endpoint id with a URL in it', () => {
    const decode = Schema.decodeUnknownResult(ModelChoice);
    expect(Result.isFailure(decode({ provider: 'acp', agent: 'claude-code' }))).toBe(true);
    expect(
      Result.isFailure(
        decode({
          provider: 'openai-compatible',
          endpointId: 'http://evil',
          model: 'm',
          apiKey: 'k',
        }),
      ),
    ).toBe(true);
  });

  it('round-trips the request and every frame', () => {
    const encoded = Schema.encodeSync(TurnRequest)(request);
    expect(Schema.decodeUnknownSync(TurnRequest)(encoded)).toEqual(request);
    const side: TurnRequest = { ...request, turn: { kind: 'side', threadId: 'th1' } };
    expect(Schema.decodeUnknownSync(TurnRequest)(Schema.encodeSync(TurnRequest)(side))).toEqual(
      side,
    );
    const all: ReadonlyArray<Frame> = [
      ...frames,
      { _tag: 'error', error: { code: 'ProviderError', message: 'x', retryable: true } },
      { _tag: 'done', outcome: 'failed' },
    ];
    for (const frame of all) {
      const parser = makeSseParser();
      const [message] = parser.push(encodeFrame(frame));
      expect(message?.event).toBe(frame._tag);
      expect(Schema.decodeUnknownSync(Frame)(JSON.parse(message?.data ?? ''))).toEqual(frame);
    }
  });
});

describe('SSE parser', () => {
  it('handles split chunks, CRLF, comments and multi-line data', () => {
    const parser = makeSseParser();
    const text = ': keep-alive\r\nevent: a\r\ndata: one\r\ndata: two\r\n\r\nevent: b\ndata: x\n\n';
    const out = [];
    for (const ch of text) out.push(...parser.push(ch));
    expect(out).toEqual([
      { event: 'a', data: 'one\ntwo' },
      { event: 'b', data: 'x' },
    ]);
  });

  it('does not emit a message without data', () => {
    expect(makeSseParser().push('event: a\n\n')).toEqual([]);
  });
});

describe('streamTurn', () => {
  it('streams frames, whatever the chunking', async () => {
    const text = sse(frames);
    const exit = await run(fakeFetch([text.slice(0, 7), text.slice(7, 40), text.slice(40)]));
    expect(Exit.isSuccess(exit) && exit.value).toEqual(frames);
  });

  it('sends the contract body to the right URL', async () => {
    let seen: { url: string; body: string; method: string } | undefined;
    const fetchImpl: typeof fetch = async (input, init) => {
      seen = { url: String(input), body: String(init?.body), method: String(init?.method) };
      return new Response(sse([{ _tag: 'done', outcome: 'completed' }]));
    };
    await run(fetchImpl);
    expect(seen?.url).toBe('http://x/api/turns');
    expect(seen?.method).toBe('POST');
    expect(JSON.parse(seen?.body ?? '')).toEqual(Schema.encodeSync(TurnRequest)(request));
  });

  it('turns an HTTP error body into error + done frames', async () => {
    const body = { error: { code: ErrorCode.HistoryTooLarge, message: 'big', retryable: false } };
    const exit = await run(async () => Response.json(body, { status: 413 }));
    expect(Exit.isSuccess(exit) && exit.value).toEqual([
      { _tag: 'error', error: body.error },
      { _tag: 'done', outcome: 'failed' },
    ]);
  });

  it('turns an unreadable HTTP error into a generic error frame', async () => {
    const exit = await run(async () => new Response('<html>bad gateway</html>', { status: 502 }));
    expect(Exit.isSuccess(exit) && exit.value[0]).toMatchObject({
      _tag: 'error',
      error: { code: ErrorCode.Internal, retryable: true },
    });
  });

  it('fails with Network when fetch throws', async () => {
    const exit = await run(async () => {
      throw new TypeError('offline');
    });
    expect(Exit.isFailure(exit)).toBe(true);
    const error = Exit.isFailure(exit) ? exit.cause.reasons : [];
    expect(JSON.stringify(error)).toContain('Network');
  });

  it('fails with Protocol when the stream ends before done', async () => {
    const exit = await run(fakeFetch([sse(frames.slice(0, 2))]));
    expect(Exit.isFailure(exit)).toBe(true);
    expect(JSON.stringify(exit)).toContain('before `done`');
  });

  it('fails with Protocol on a frame outside the contract', async () => {
    const exit = await run(fakeFetch(['event: delta\ndata: {"_tag":"nope"}\n\n']));
    expect(Exit.isFailure(exit)).toBe(true);
    expect(JSON.stringify(exit)).toContain('Protocol');
  });

  it('aborts the request when the stream is interrupted', async () => {
    let aborted = false;
    const fetchImpl: typeof fetch = async (_input, init) => {
      init?.signal?.addEventListener('abort', () => (aborted = true));
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(encodeFrame(frames[0] as Frame)));
          },
        }),
      );
    };
    const first = await Effect.runPromise(
      Stream.runHead(streamTurn(request, { fetch: fetchImpl, baseUrl: 'http://x' })),
    );
    expect(first._tag).toBe('Some');
    expect(aborted).toBe(true);
  });
});

describe('listEndpoints', () => {
  it('decodes the list and fails on a bad response', async () => {
    const ok: typeof fetch = async () =>
      Response.json({ endpoints: [{ id: 'acme', label: 'Acme' }] });
    expect(await Effect.runPromise(listEndpoints({ fetch: ok }))).toEqual([
      { id: 'acme', label: 'Acme' },
    ]);
    const bad: typeof fetch = async () => Response.json({ nope: 1 });
    const exit = await Effect.runPromiseExit(listEndpoints({ fetch: bad }));
    expect(Exit.isFailure(exit)).toBe(true);
    expect(ClientError.name).toBe('ClientError');
  });
});
