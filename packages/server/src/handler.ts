// `POST /api/turns` and `GET /api/endpoints` as plain `Request -> Response` functions, so any
// host (TanStack Start route, Node http, tests) can mount them. The server keeps no state
// (plan A1): each request carries the key and the whole event log, and the response is an SSE
// stream of `delta` / `event` / `error` / `done` frames.
//
// Keys (plan A7, risk 19): the request is never logged, log entries carry only whitelisted scalar
// fields, error text is built from paths and codes (not from input values), and every outgoing
// message is redacted against the request's key.
import { Cause, Effect, Layer, Result, Schema, Stream } from 'effect';
import { runSideChat, runTurn } from '@kd-learn/agent';
import type { AgentOutput, InvalidTurn } from '@kd-learn/agent';
import { AiPort } from '@kd-learn/ai/port';
import type { ModelRef } from '@kd-learn/ai/port';
import { layer as tanstackLayer } from '@kd-learn/ai/tanstack';
import { EndpointsResponse, ErrorCode, TurnRequest, encodeFrame } from '@kd-learn/api';
import type { ErrorBody, Failure, Frame, ModelChoice } from '@kd-learn/api';
import { loadConfig } from './config.ts';
import type { ServerConfig } from './config.ts';
import { asRecord, describeIssue, redact, scrubFrame } from './safety.ts';

/** Scalar fields only: a log entry cannot carry a request body or a header by construction. */
export type LogFields = Readonly<Record<string, string | number | boolean>>;
export interface LogEntry {
  readonly event: string;
  readonly fields: LogFields;
}
export type Logger = (entry: LogEntry) => void;

export const consoleLogger: Logger = ({ event, fields }) => {
  console.info(JSON.stringify({ event, ...fields }));
};

export interface HandlerDeps {
  readonly config: ServerConfig;
  /** The AI port. Defaults to the TanStack adapter. Tests pass a fake. */
  readonly ai?: Layer.Layer<AiPort>;
  readonly log?: Logger;
  readonly newId?: () => string;
}

export type Handler = (request: Request) => Promise<Response>;

const encoder = new TextEncoder();

const SECURITY_HEADERS = { 'x-content-type-options': 'nosniff' } as const;

const corsHeaders = (request: Request, config: ServerConfig): Record<string, string> => {
  if (config.corsOrigins.length === 0) return {};
  const origin = request.headers.get('origin');
  return origin !== null && config.corsOrigins.includes(origin)
    ? {
        'access-control-allow-origin': origin,
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'content-type, accept',
        'access-control-max-age': '600',
        vary: 'origin',
      }
    : { vary: 'origin' };
};

const failureResponse = (
  status: number,
  code: string,
  message: string,
  retryable: boolean,
  headers: Record<string, string>,
): Response => {
  const body: ErrorBody = { error: { code, message, retryable } };
  return Response.json(body, {
    status,
    headers: { ...SECURITY_HEADERS, 'cache-control': 'no-store', ...headers },
  });
};

/** The body as text, or why it was refused. Stops reading as soon as the limit is passed. */
const readLimited = async (
  request: Request,
  max: number,
): Promise<{ readonly text: string; readonly bytes: number } | 'too-large' | 'unreadable'> => {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) return 'too-large';
  if (request.body === null) return { text: '', bytes: 0 };
  const reader = request.body.getReader();
  const chunks: Array<Uint8Array> = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel().catch(() => undefined);
        return 'too-large';
      }
      chunks.push(value);
    }
  } catch {
    return 'unreadable';
  }
  const all = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(all), bytes: total };
  } catch {
    return 'unreadable';
  }
};

const whenAborted = (signal: AbortSignal): Effect.Effect<void> =>
  Effect.callback<void>((resume) => {
    if (signal.aborted) return resume(Effect.void);
    const onAbort = () => resume(Effect.void);
    signal.addEventListener('abort', onAbort, { once: true });
    return Effect.sync(() => signal.removeEventListener('abort', onAbort));
  });

const toModelRef = (choice: ModelChoice, config: ServerConfig): ModelRef | undefined => {
  if (choice.provider !== 'openai-compatible') {
    return { provider: choice.provider, model: choice.model, apiKey: choice.apiKey };
  }
  const endpoint = config.endpoints.find((e) => e.id === choice.endpointId);
  return endpoint === undefined
    ? undefined
    : {
        provider: 'openai-compatible',
        model: choice.model,
        apiKey: choice.apiKey,
        baseURL: endpoint.baseURL,
      };
};

const toFrame = (output: AgentOutput): Frame => {
  switch (output._tag) {
    case 'Delta':
      return { _tag: 'delta', messageId: output.messageId, delta: output.delta };
    case 'Event':
      return { _tag: 'event', event: output.event };
    case 'Error':
      return { _tag: 'error', error: output.error };
    case 'Done':
      return { _tag: 'done', outcome: output.outcome };
  }
};

const failedFrames = (error: Failure): ReadonlyArray<Frame> => [
  { _tag: 'error', error },
  { _tag: 'done', outcome: 'failed' },
];

/** Never fails: a failure becomes `error` + `done` frames, so the client always gets a closed record. */
const framesOf = (
  outputs: Stream.Stream<AgentOutput, InvalidTurn, AiPort>,
  key: string,
  onFailure: (code: string, message: string) => void,
): Stream.Stream<Frame, never, AiPort> =>
  outputs.pipe(
    Stream.map(toFrame),
    Stream.catchTag('InvalidTurn', (error) => {
      const failure = {
        code: ErrorCode.InvalidTurn,
        message: redact(error.message, key),
        retryable: false,
      };
      onFailure(failure.code, failure.message);
      return Stream.fromIterable(failedFrames(failure));
    }),
    // A defect (a bug, or a provider adapter that threw). The cause can hold the key, so the
    // client gets a fixed message and the log gets the redacted summary.
    Stream.catchCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) return Stream.failCause(cause);
      const detail = redact(String(Cause.squash(cause)), key).slice(0, 200);
      onFailure(ErrorCode.Internal, detail);
      return Stream.fromIterable(
        failedFrames({
          code: ErrorCode.Internal,
          message: 'The turn failed because of a server error.',
          retryable: true,
        }),
      );
    }),
  );

export const handleTurns = async (request: Request, deps: HandlerDeps): Promise<Response> => {
  const { config } = deps;
  const log = deps.log ?? consoleLogger;
  const cors = corsHeaders(request, config);
  const reject = (status: number, code: string, message: string, retryable = false) => {
    log({ event: 'turn.rejected', fields: { status, code } });
    return failureResponse(status, code, message, retryable, cors);
  };

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'POST') {
    return reject(405, ErrorCode.MethodNotAllowed, 'Use POST.');
  }

  const body = await readLimited(request, config.maxRequestBytes);
  if (body === 'too-large') {
    return reject(
      413,
      ErrorCode.HistoryTooLarge,
      `The request is larger than ${config.maxRequestBytes} bytes. Start a new session.`,
    );
  }
  if (body === 'unreadable') {
    return reject(400, ErrorCode.InvalidRequest, 'The request body is not readable UTF-8.');
  }

  let json: unknown;
  try {
    json = JSON.parse(body.text);
  } catch {
    return reject(400, ErrorCode.InvalidRequest, 'The request body is not valid JSON.');
  }

  // A free base URL is never accepted (risk 6). Say so plainly before the generic decode error.
  const modelField = asRecord(asRecord(json)?.model);
  if (modelField && Object.keys(modelField).some((k) => k.toLowerCase() === 'baseurl')) {
    return reject(
      400,
      ErrorCode.InvalidRequest,
      'model.baseURL is not accepted. Choose an endpointId from GET /api/endpoints.',
    );
  }

  const decoded = Schema.decodeUnknownResult(TurnRequest)(json, { onExcessProperty: 'error' });
  if (Result.isFailure(decoded)) {
    return reject(400, ErrorCode.InvalidRequest, describeIssue(decoded.failure));
  }
  const { model: choice, turn, log: eventLog } = decoded.success;
  const key = choice.apiKey;

  const model = toModelRef(choice, config);
  if (model === undefined) {
    return reject(
      400,
      ErrorCode.UnknownEndpoint,
      'This endpoint id is not allowed on this server.',
    );
  }

  const newId = deps.newId ?? (() => crypto.randomUUID());
  const outputs =
    turn.kind === 'main'
      ? runTurn({ log: eventLog, model, newId })
      : runSideChat({ log: eventLog, threadId: turn.threadId, model, newId });

  const startedAt = Date.now();
  const stats = { events: 0, outcome: 'cancelled', code: '' };
  const fields = (extra: LogFields = {}): LogFields => ({
    kind: turn.kind,
    provider: choice.provider,
    ...(choice.provider === 'openai-compatible' ? { endpointId: choice.endpointId } : {}),
    requestBytes: body.bytes,
    ...extra,
  });
  log({ event: 'turn.start', fields: fields() });

  const frames = framesOf(outputs, key, (code) => {
    stats.code = code;
  }).pipe(
    Stream.map((frame) => scrubFrame(frame, key)),
    Stream.tap((frame) =>
      Effect.sync(() => {
        if (frame._tag === 'event') stats.events += 1;
        if (frame._tag === 'done') stats.outcome = frame.outcome;
        if (frame._tag === 'error' && stats.code === '') stats.code = frame.error.code;
      }),
    ),
    Stream.ensuring(
      Effect.sync(() =>
        log({
          event: 'turn.end',
          fields: fields({
            outcome: stats.outcome,
            events: stats.events,
            durationMs: Date.now() - startedAt,
            ...(stats.code === '' ? {} : { code: stats.code }),
          }),
        }),
      ),
    ),
    Stream.provide(deps.ai ?? tanstackLayer()),
    // The runtime also cancels the response body on disconnect; this covers hosts that only abort the signal.
    Stream.interruptWhen(whenAborted(request.signal)),
    Stream.map((frame) => encoder.encode(encodeFrame(frame))),
  );

  // Cancelling the body (client disconnect) or aborting the request signal interrupts the stream,
  // which aborts the request to the provider (plan 3.3).
  const stream = Stream.toReadableStream(frames);
  return new Response(stream, {
    status: 200,
    headers: {
      ...SECURITY_HEADERS,
      ...cors,
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      'x-accel-buffering': 'no',
    },
  });
};

export const handleEndpoints = async (request: Request, deps: HandlerDeps): Promise<Response> => {
  const { config } = deps;
  const cors = corsHeaders(request, config);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'GET') {
    return failureResponse(405, ErrorCode.MethodNotAllowed, 'Use GET.', false, cors);
  }
  const body: typeof EndpointsResponse.Type = {
    endpoints: config.endpoints.map(({ id, label }) => ({ id, label })),
  };
  return Response.json(body, {
    headers: { ...SECURITY_HEADERS, 'cache-control': 'no-store', ...cors },
  });
};

export interface Handlers {
  readonly turns: Handler;
  readonly endpoints: Handler;
}

/** Wraps a handler so an unexpected throw becomes a fixed 500, never a message with request data. */
const safely =
  (handler: Handler, log: Logger): Handler =>
  async (request) => {
    try {
      return await handler(request);
    } catch {
      log({ event: 'request.crashed', fields: {} });
      return failureResponse(500, ErrorCode.Internal, 'Server error.', true, {});
    }
  };

/**
 * The handlers for a host to mount. Reads the configuration from `env`. If the configuration is
 * invalid, every route answers 500 `ServerMisconfigured` (and one log line says why) instead of
 * the process failing to start.
 */
export const createHandlers = (
  env: Readonly<Record<string, string | undefined>>,
  options: Omit<HandlerDeps, 'config'> = {},
): Handlers => {
  const log = options.log ?? consoleLogger;
  let config: ServerConfig;
  try {
    config = loadConfig(env);
  } catch (error) {
    log({
      event: 'config.invalid',
      fields: { message: error instanceof Error ? error.message : 'unknown' },
    });
    const broken: Handler = async () =>
      failureResponse(
        500,
        ErrorCode.Misconfigured,
        'The server is not configured correctly.',
        false,
        {},
      );
    return { turns: broken, endpoints: broken };
  }
  const deps: HandlerDeps = { ...options, config, log };
  return {
    turns: safely((request) => handleTurns(request, deps), log),
    endpoints: safely((request) => handleEndpoints(request, deps), log),
  };
};
