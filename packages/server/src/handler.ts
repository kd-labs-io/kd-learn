// `POST /api/turns` and `GET /api/endpoints` as plain `Request -> Response` functions, so any
// host (TanStack Start route, Node http, tests) can mount them. The server keeps no state
// (plan A1): each request carries the key and the whole event log, and the response is an SSE
// stream of `delta` / `event` / `error` / `done` frames.
//
// Keys (plan A7, risk 19): the request is never logged, log entries carry only whitelisted scalar
// fields, error text is built from paths and codes (not from input values), and every outgoing
// message is redacted against the request's key.
import type { EventLog } from '@kd-learn/core';
import { meteredAi, type Meter } from './demo/metered.ts';
import type { DemoGate } from './demo/service.ts';
import { Cause, Effect, Layer, Result, Schema, Stream } from 'effect';
import { defaultProfile, runSideChat, runTurn } from '@kd-learn/agent';
import type { AgentOutput, ImageGenerator, InvalidTurn } from '@kd-learn/agent';
import { AiPort, ProviderError, type ImageModelRef, type ImagePort } from '@kd-learn/ai/port';
import type { ModelRef } from '@kd-learn/ai/port';
import { layer as tanstackLayer } from '@kd-learn/ai/tanstack';
import { makeImageService } from '@kd-learn/ai/image';
import {
  EndpointsResponse,
  ErrorCode,
  MAX_SOURCE_SLICE_BYTES,
  SearchOptions,
  TurnRequest,
  encodeFrame,
} from '@kd-learn/api';
import type { Failure, Frame, ImageModelChoice, ModelChoice, SearchProvider } from '@kd-learn/api';
import { envOnlySearch, type SearchAdapters, type SearchConfigService } from './search/config.ts';
import { loadConfig } from './config.ts';
import type { ServerConfig } from './config.ts';
import { SECURITY_HEADERS, corsHeaders, failureResponse, readLimited } from './http.ts';
import {
  asRecord,
  describeIssue,
  makeFigureLeakFilter,
  redact,
  scrubFrame,
  type Secrets,
} from './safety.ts';
import type { PdfExtractor } from './sources/pdf.ts';
import type { ServerDatabase } from '@kd-learn/storage/sqlite-node';
import { loadAccountConfig, switchFrom } from './auth/config.ts';
import { makeAdminHandlers } from './admin/http.ts';
import {
  initAccounts,
  makeAccountHandlers,
  type AccountHandlers,
  type Accounts,
} from './auth/http.ts';
import type { AuthOptions } from './auth/service.ts';
import { bearerToken, makeRouteKit } from './routes.ts';
import { makeSettingsHandler } from './settings/http.ts';
import { handleExtract } from './knowledge/extract-route.ts';
import { makePracticeHandler } from './practice/guest.ts';
import { handleResearch } from './sources/research-route.ts';
import { handleModelTest } from './settings/model-test-route.ts';
import { makeRateLimiter, type RateLimiter } from './auth/rate-limit.ts';

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
  /** Image generation (phase 5 A6). Defaults to the HTTP adapters. Tests pass a fake. */
  readonly images?: ImagePort['Service'];
  readonly log?: Logger;
  readonly newId?: () => string;
  /** False when an admin turned guest mode off (plan A7). Absent: allowed. */
  readonly guestAllowed?: () => Promise<boolean>;
  /** Admin switch for CDN libraries in demos (phase 5 A5). Absent: on. */
  readonly figureCdn?: () => Promise<boolean>;
  /** Demo mode (plan A8). Absent: closed. */
  readonly demo?: () => Promise<DemoGate>;
  /** The server's search sources (phase 4 A6). Absent: none. */
  readonly search?: () => Promise<SearchSources>;
  /** `KD_LEARN_TRUST_PROXY`: read the client address from `X-Forwarded-For`. */
  readonly trustProxy?: boolean;
  /** Researches per client address (phase 4 A6, risk 40). Absent: not limited. */
  readonly researchLimit?: RateLimiter;
  /** Model tests per client address (`POST /api/models/test`). Absent: not limited. */
  readonly modelTestLimit?: RateLimiter;
  /** The signed-in user of a bearer token: `undefined` no token, `null` a bad one. */
  readonly accountOf?: (request: Request) => Promise<{ readonly id: string } | null | undefined>;
}

/** What a guest or demo route needs of the search config. */
export type SearchSources = Pick<SearchConfigService, 'providers' | 'service'>;

/** `GET /api/search/options` (phase 4 A6): sources usable in the caller's mode, no key. */
export const handleSearchOptions = async (
  request: Request,
  deps: HandlerDeps,
): Promise<Response> => {
  const cors = corsHeaders(request, deps.config);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'GET') {
    return failureResponse(405, ErrorCode.MethodNotAllowed, 'Use GET.', false, cors);
  }
  const answer = (providers: ReadonlyArray<SearchProvider>) =>
    Response.json(Schema.encodeSync(SearchOptions)({ providers }), {
      headers: { ...SECURITY_HEADERS, 'cache-control': 'no-store', ...cors },
    });
  const search = deps.search === undefined ? undefined : await deps.search().catch(() => undefined);
  if (search === undefined) return answer([]);
  const user = request.headers.has('authorization')
    ? await (deps.accountOf?.(request) ?? Promise.resolve(null)).catch(() => null)
    : undefined;
  if (user === null) {
    return failureResponse(401, ErrorCode.Unauthorized, 'Sign in again.', false, cors);
  }
  if (user !== undefined) return answer(search.providers('account'));
  if (new URL(request.url).searchParams.get('mode') === 'demo') {
    const gate = await (deps.demo?.() ?? Promise.resolve({ _tag: 'Disabled' as const }));
    return answer(gate._tag === 'Ready' ? search.providers('demo') : []);
  }
  const allowed = await (deps.guestAllowed?.() ?? Promise.resolve(true)).catch(() => false);
  return answer(allowed ? search.providers('guest') : []);
};

const LANGUAGE_TAG = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8}){0,3}$/;

/** The log with the server's default profile in place of the client's (demo mode). */
export const withServerProfile = (log: EventLog): EventLog =>
  log.map((event) =>
    event._tag === 'SessionCreated'
      ? {
          ...event,
          profile: {
            ...defaultProfile,
            language: LANGUAGE_TAG.test(event.profile.language)
              ? event.profile.language
              : defaultProfile.language,
          },
        }
      : event,
  );

/** A demo turn sends the whole log on the server's key: keep it much smaller than a guest's. */
export const DEMO_MAX_REQUEST_BYTES = 256 * 1024;
/** Model calls a demo main turn may make (a tool call and the answer after it is two). */
export const DEMO_MAX_STEPS = 4;
/** Output tokens per model call in demo mode. */
export const DEMO_MAX_OUTPUT_TOKENS = 2048;

/** What the host knows about the connection. `clientAddress` is the socket peer, not a header. */
export interface RequestContext {
  readonly clientAddress?: string | undefined;
}

export type Handler = (request: Request, context?: RequestContext) => Promise<Response>;

const encoder = new TextEncoder();

export const whenAborted = (signal: AbortSignal): Effect.Effect<void> =>
  Effect.callback<void>((resume) => {
    if (signal.aborted) return resume(Effect.void);
    const onAbort = () => resume(Effect.void);
    signal.addEventListener('abort', onAbort, { once: true });
    return Effect.sync(() => signal.removeEventListener('abort', onAbort));
  });

/** The guest's image model; undefined for an endpoint that is unknown or makes no images. */
export const toImageModelRef = (
  choice: ImageModelChoice,
  config: ServerConfig,
): ImageModelRef | undefined => {
  if (choice.provider === 'gemini') return choice;
  const endpoint = config.endpoints.find((e) => e.id === choice.endpointId && e.images);
  return endpoint === undefined
    ? undefined
    : {
        provider: 'openai-compatible',
        model: choice.model,
        apiKey: choice.apiKey,
        baseURL: endpoint.baseURL,
      };
};

export const toModelRef = (
  choice: Exclude<ModelChoice, { provider: 'demo' }>,
  config: ServerConfig,
): ModelRef | undefined => {
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
    case 'Figure': {
      const { figureId, body } = output.figure;
      return typeof body === 'string'
        ? { _tag: 'figure', figureId, encoding: 'text', body }
        : {
            _tag: 'figure',
            figureId,
            encoding: 'base64',
            body: Buffer.from(body).toString('base64'),
          };
    }
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
  key: Secrets,
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
  for (const field of ['model', 'imageModel'] as const) {
    const value = asRecord(asRecord(json)?.[field]);
    if (value && Object.keys(value).some((k) => k.toLowerCase() === 'baseurl')) {
      return reject(
        400,
        ErrorCode.InvalidRequest,
        `${field}.baseURL is not accepted. Choose an endpointId from GET /api/endpoints.`,
      );
    }
  }

  const decoded = Schema.decodeUnknownResult(TurnRequest)(json, { onExcessProperty: 'error' });
  if (Result.isFailure(decoded)) {
    return reject(400, ErrorCode.InvalidRequest, describeIssue(decoded.failure));
  }
  const { model: choice, turn, sourceSlice, imageModel: imageChoice } = decoded.success;
  if (imageChoice !== undefined && (choice.provider === 'demo' || turn.kind !== 'main')) {
    return reject(
      400,
      ErrorCode.InvalidRequest,
      "imageModel is for guest main turns only. The demo uses the server's image model.",
    );
  }
  let eventLog = decoded.success.log;
  if (
    sourceSlice !== undefined &&
    new TextEncoder().encode(JSON.stringify(sourceSlice)).byteLength > MAX_SOURCE_SLICE_BYTES
  ) {
    return reject(
      413,
      ErrorCode.HistoryTooLarge,
      `sourceSlice is limited to ${MAX_SOURCE_SLICE_BYTES} bytes.`,
    );
  }
  const misconfigured = () =>
    reject(500, ErrorCode.Misconfigured, 'The server is not configured correctly.');

  // The guest and demo switches are separate (plan 2.2). Either one fails closed: when it cannot
  // be read, the turn is refused before any provider call.
  let model: ModelRef;
  let ai = deps.ai ?? tanstackLayer();
  let settle: (() => void) | undefined;
  const images = deps.images ?? makeImageService();
  let image: ImageGenerator | undefined;
  let imageKey: string | undefined;
  if (choice.provider === 'demo') {
    if (body.bytes > DEMO_MAX_REQUEST_BYTES) {
      return reject(
        413,
        ErrorCode.HistoryTooLarge,
        `A demo request is limited to ${DEMO_MAX_REQUEST_BYTES} bytes. Start a new session.`,
      );
    }
    let gate: DemoGate;
    try {
      gate = deps.demo === undefined ? { _tag: 'Disabled' } : await deps.demo();
    } catch {
      return misconfigured();
    }
    if (gate._tag === 'Disabled') {
      return reject(403, ErrorCode.DemoModeDisabled, 'Demo mode is not available on this server.');
    }
    const reserved = gate.budget.reserve(turn.kind === 'main' ? DEMO_MAX_STEPS : 1);
    switch (reserved._tag) {
      case 'Closed':
        return reject(
          403,
          ErrorCode.DemoModeDisabled,
          'Demo mode is not available on this server.',
        );
      case 'Exceeded':
        return reject(
          429,
          ErrorCode.DemoQuotaExceeded,
          'The demo has used all of its calls for now. Try again later, or use your own key.',
        );
    }
    // The prompts come from the profile in the log, which the client sends: on the server's key,
    // only the server's own prompts run. The learner keeps their language.
    eventLog = withServerProfile(eventLog);
    const { reservation } = reserved;
    const meter: Meter = { calls: 0 };
    model = gate.model;
    const demoImages = gate.images;
    if (demoImages !== undefined) {
      const budget = gate.budget;
      imageKey = demoImages.model.apiKey;
      image = {
        model: demoImages.model.model,
        // Each image reserves its N calls before the provider is called (risk 46). Short: the
        // provider is not called and the reservation goes back.
        generate: (prompt, aspect) =>
          Effect.suspend(() => {
            const held = budget.reserve(demoImages.cost);
            if (held._tag !== 'Ok' || held.reservation.calls < demoImages.cost) {
              if (held._tag === 'Ok') budget.settle(held.reservation, 0);
              return Effect.fail(
                new ProviderError({
                  message: 'The demo has no budget left for images.',
                  code: ErrorCode.DemoQuotaExceeded,
                }),
              );
            }
            return images
              .generate({ model: demoImages.model, prompt, aspect })
              .pipe(
                Effect.ensuring(
                  Effect.sync(() => budget.settle(held.reservation, demoImages.cost)),
                ),
              );
          }),
      };
    }
    ai = meteredAi(
      ai,
      { calls: reservation.calls, maxOutputTokens: DEMO_MAX_OUTPUT_TOKENS },
      meter,
    );
    let settled = false;
    settle = () => {
      if (settled) return;
      settled = true;
      gate.budget.settle(reservation, meter.calls);
    };
  } else {
    let allowed: boolean;
    try {
      allowed = deps.guestAllowed === undefined ? true : await deps.guestAllowed();
    } catch {
      return misconfigured();
    }
    if (!allowed) {
      return reject(403, ErrorCode.GuestModeDisabled, 'Guest mode is turned off on this server.');
    }
    const resolved = toModelRef(choice, config);
    if (resolved === undefined) {
      return reject(
        400,
        ErrorCode.UnknownEndpoint,
        'This endpoint id is not allowed on this server.',
      );
    }
    model = resolved;
    if (imageChoice !== undefined) {
      const imageModel = toImageModelRef(imageChoice, config);
      if (imageModel === undefined) {
        return reject(
          400,
          ErrorCode.UnknownEndpoint,
          'This endpoint id does not make images on this server.',
        );
      }
      imageKey = imageModel.apiKey;
      image = {
        model: imageModel.model,
        generate: (prompt, aspect) => images.generate({ model: imageModel, prompt, aspect }),
      };
    }
  }
  // The keys to scrub from every frame: the guest's own, or the server's demo keys; text and image.
  const key = [model.provider === 'acp' ? undefined : model.apiKey, imageKey];

  const newId = deps.newId ?? (() => crypto.randomUUID());
  const outputs =
    turn.kind === 'main'
      ? runTurn({
          log: eventLog,
          model,
          newId,
          ...(sourceSlice === undefined ? {} : { sourceSlice }),
          figures: {
            cdn: await (deps.figureCdn?.() ?? Promise.resolve(true)).catch(() => false),
            ...(image === undefined ? {} : { image }),
          },
        })
      : runSideChat({ log: eventLog, threadId: turn.threadId, model, newId });

  const startedAt = Date.now();
  const stats = { events: 0, outcome: 'cancelled', code: '' };
  const fields = (extra: LogFields = {}): LogFields => ({
    kind: turn.kind,
    provider: choice.provider,
    ...(choice.provider === 'openai-compatible' ? { endpointId: choice.endpointId } : {}),
    ...(settle === undefined ? {} : { model: model.provider === 'acp' ? '' : model.model }),
    requestBytes: body.bytes,
    ...extra,
  });
  log({ event: 'turn.start', fields: fields() });

  const frames = framesOf(outputs, key, (code) => {
    stats.code = code;
  }).pipe(
    Stream.map((frame) => scrubFrame(frame, key)),
    Stream.filter(makeFigureLeakFilter(key)),
    Stream.tap((frame) =>
      Effect.sync(() => {
        if (frame._tag === 'event') stats.events += 1;
        if (frame._tag === 'done') stats.outcome = frame.outcome;
        if (frame._tag === 'error' && stats.code === '') stats.code = frame.error.code;
      }),
    ),
    Stream.ensuring(
      Effect.sync(() => {
        settle?.();
        log({
          event: 'turn.end',
          fields: fields({
            outcome: stats.outcome,
            events: stats.events,
            durationMs: Date.now() - startedAt,
            ...(stats.code === '' ? {} : { code: stats.code }),
          }),
        });
      }),
    ),
    Stream.provide(ai),
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
    endpoints: config.endpoints.map(({ id, label, images }) => ({
      id,
      label,
      ...(images ? { images: true } : {}),
    })),
  };
  return Response.json(body, {
    headers: { ...SECURITY_HEADERS, 'cache-control': 'no-store', ...cors },
  });
};

export interface Handlers extends AccountHandlers {
  readonly turns: Handler;
  /** `POST /api/knowledge/extract` (guest and demo extraction, phase 3 A3). */
  readonly extract: Handler;
  /** `POST /api/practice/issue` and `POST /api/practice/grade` (guest and demo). */
  readonly practice: Handler;
  readonly endpoints: Handler;
  /** `POST /api/models/test` (guest): one tiny call to check a model and key. */
  readonly modelTest: Handler;
  /** Everything under `/api/account/` (settings, connections, roles, sessions). */
  readonly account: Handler;
  /** Everything under `/api/admin/` except invites (config, users). */
  readonly admin: Handler;
  /** `GET /api/config`, public. */
  readonly config: Handler;
  /** `GET /api/search/options`, public (phase 4 A6). */
  readonly searchOptions: Handler;
  /** `POST /api/research` (guest and demo, phase 4 A5). */
  readonly research: Handler;
}

export interface CreateHandlersOptions extends Omit<HandlerDeps, 'config'> {
  /** Replaces the database file (tests). */
  readonly database?: ServerDatabase;
  /** PDF extraction of account sources; tests pass a fake. */
  readonly extractPdf?: PdfExtractor;
  readonly auth?: AuthOptions;
  /** Upper bound on one account turn. Default 3 minutes. */
  readonly turnTimeoutMs?: number;
  /** The ACP adapter for account turns. Default: loaded on the first ACP turn. Tests pass a fake. */
  readonly acp?: Layer.Layer<AiPort>;
  /** Search adapters; tests pass fakes. */
  readonly searchAdapters?: SearchAdapters;
}

/** Wraps a handler so an unexpected throw becomes a fixed 500, never a message with request data. */
const safely =
  (handler: Handler, log: Logger): Handler =>
  async (request, context) => {
    try {
      return await handler(request, context);
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
  options: CreateHandlersOptions = {},
): Handlers => {
  const log = options.log ?? consoleLogger;
  const broken: Handler = async () =>
    failureResponse(
      500,
      ErrorCode.Misconfigured,
      'The server is not configured correctly.',
      false,
      {},
    );
  const configFailed = (error: unknown) =>
    log({
      event: 'config.invalid',
      fields: { message: error instanceof Error ? error.message : 'unknown' },
    });
  const accountsBroken = {
    register: broken,
    login: broken,
    logout: broken,
    me: broken,
    invites: broken,
    account: broken,
    admin: broken,
  };

  let config: ServerConfig;
  try {
    config = loadConfig(env);
  } catch (error) {
    configFailed(error);
    return {
      turns: broken,
      extract: broken,
      practice: broken,
      endpoints: broken,
      modelTest: broken,
      config: broken,
      searchOptions: broken,
      research: broken,
      ...accountsBroken,
    };
  }

  // Accounts are optional: a bad account variable breaks only the account routes, and the guest
  // routes keep working with the environment defaults. The database opens on the first request
  // that needs it.
  let accountRoutes: Omit<
    Handlers,
    | 'turns'
    | 'extract'
    | 'practice'
    | 'endpoints'
    | 'modelTest'
    | 'config'
    | 'searchOptions'
    | 'research'
  > = accountsBroken;
  let publicConfig: Handler;
  let guestAllowed: () => Promise<boolean>;
  let figureCdn: () => Promise<boolean> = async () => true;
  let demo: (() => Promise<DemoGate>) | undefined;
  let search: () => Promise<SearchSources>;
  let accountOf: HandlerDeps['accountOf'];
  try {
    const accountConfig = loadAccountConfig(env);
    let ready: Promise<Accounts> | undefined;
    const accounts = () => {
      ready ??= initAccounts(accountConfig, {
        log,
        endpoints: () => config.endpoints,
        ai: options.ai ?? tanstackLayer(),
        images: options.images ?? makeImageService(),
        ...(options.turnTimeoutMs === undefined ? {} : { turnTimeoutMs: options.turnTimeoutMs }),
        ...(options.acp ? { acp: options.acp } : {}),
        ...(options.database ? { database: options.database } : {}),
        ...(options.extractPdf ? { extractPdf: options.extractPdf } : {}),
        ...(options.auth ? { auth: options.auth } : {}),
        searxngUrl: config.searxngUrl,
        ...(options.searchAdapters ? { searchAdapters: options.searchAdapters } : {}),
      }).catch((error: unknown) => {
        log({
          event: 'accounts.unavailable',
          fields: { message: error instanceof Error ? error.message.slice(0, 200) : 'unknown' },
        });
        throw error;
      });
      return ready;
    };
    const kit = makeRouteKit({ accounts, config, accountConfig, log });
    const adminRoutes = makeAdminHandlers(kit, log);
    accountRoutes = {
      ...makeAccountHandlers(accounts, config, accountConfig, log),
      account: makeSettingsHandler(kit, log),
      admin: adminRoutes.admin,
    };
    publicConfig = adminRoutes.config;
    // The admin switch lives in the database. If it cannot be read, guest turns are refused
    // (fail closed) rather than ignoring a switch the admin turned off.
    guestAllowed = () => accounts().then((ready) => ready.admin.switches().guestMode);
    figureCdn = () => accounts().then((ready) => ready.admin.switches().figureCdn);
    demo = () => accounts().then((ready) => ready.demo());
    search = () => accounts().then((ready) => ready.search);
    accountOf = async (request) => {
      const token = bearerToken(request);
      if (token === undefined) return null;
      return (await accounts()).auth.authenticate(token) ?? null;
    };
  } catch (error) {
    configFailed(error);
    const guestMode = (() => {
      try {
        return switchFrom('KD_LEARN_GUEST_MODE', env.KD_LEARN_GUEST_MODE, true);
      } catch {
        return false;
      }
    })();
    guestAllowed = async () => guestMode;
    const envSearch = envOnlySearch(config.searxngUrl, options.searchAdapters);
    search = async () => envSearch;
    publicConfig = async (request) =>
      Response.json(
        {
          accounts: false,
          registration: 'closed',
          guestMode,
          demoMode: false,
          figureCdn: true,
          demoImages: false,
        },
        {
          headers: {
            ...SECURITY_HEADERS,
            'cache-control': 'no-store',
            ...corsHeaders(request, config),
          },
        },
      );
  }
  const deps: HandlerDeps = {
    ...options,
    config,
    log,
    guestAllowed,
    figureCdn,
    search,
    trustProxy: ['1', 'true'].includes(env.KD_LEARN_TRUST_PROXY?.trim().toLowerCase() ?? ''),
    // 20 researches per hour per address, guest and demo together.
    researchLimit: options.researchLimit ?? makeRateLimiter({ limit: 20, windowMs: 60 * 60_000 }),
    // 30 model tests per hour per address.
    modelTestLimit: options.modelTestLimit ?? makeRateLimiter({ limit: 30, windowMs: 60 * 60_000 }),
    ...(demo === undefined ? {} : { demo }),
    ...(accountOf === undefined ? {} : { accountOf }),
  };

  const wrap = (handler: Handler) => safely(handler, log);
  return {
    turns: wrap((request) => handleTurns(request, deps)),
    extract: wrap((request) => handleExtract(request, deps)),
    practice: wrap(makePracticeHandler(deps)),
    endpoints: wrap((request) => handleEndpoints(request, deps)),
    modelTest: wrap((request, context) => handleModelTest(request, deps, context)),
    config: wrap(publicConfig),
    searchOptions: wrap((request) => handleSearchOptions(request, deps)),
    research: wrap((request, context) => handleResearch(request, deps, context)),
    register: wrap(accountRoutes.register),
    login: wrap(accountRoutes.login),
    logout: wrap(accountRoutes.logout),
    me: wrap(accountRoutes.me),
    invites: wrap(accountRoutes.invites),
    account: wrap(accountRoutes.account),
    admin: wrap(accountRoutes.admin),
  };
};
