// `POST /api/research` (phase 4 A5, A9): web research for guest and demo, without state. The client
// sends a question and the search source it picked; it gets back the source to store. Keys are
// handled like `/api/turns` (risk 19). Guests may only use the server's SearXNG when the admin
// allows it, and are limited per address (risk 40). A demo research reserves its model calls and
// every search up front; with less left it is refused before any provider or search call.
import { Cause, Effect, Exit, Fiber, Layer, Result, Schema } from 'effect';
import {
  RESEARCH_MAX_QUERIES,
  RESEARCH_MAX_OUTPUT_TOKENS,
  RESEARCH_MODEL_CALLS,
  defaultProfile,
  resolveProfile,
  runResearch,
} from '@kd-learn/agent';
import type { ResearchUsage } from '@kd-learn/agent';
import type { AiPort, ModelRef } from '@kd-learn/ai/port';
import { layer as tanstackLayer } from '@kd-learn/ai/tanstack';
import { ErrorCode, ResearchFrame, ResearchRequest } from '@kd-learn/api';
import type { Failure } from '@kd-learn/api';
import { SearchPort, type SearchService } from '@kd-learn/search/port';
import { clientAddress } from '../auth/config.ts';
import { meteredAi, meteredSearch, type Meter } from '../demo/metered.ts';
import type { DemoGate } from '../demo/service.ts';
import {
  DEMO_MAX_REQUEST_BYTES,
  consoleLogger,
  toModelRef,
  type HandlerDeps,
  type LogFields,
  type RequestContext,
} from '../handler.ts';
import { SECURITY_HEADERS, corsHeaders, failureResponse, readLimited } from '../http.ts';
import { asRecord, describeIssue, redact, scrubDeep } from '../safety.ts';

/** What one research may charge in demo mode: its model calls and Q searches. */
export const RESEARCH_DEMO_CALLS = RESEARCH_MODEL_CALLS + RESEARCH_MAX_QUERIES;
const HEARTBEAT_MS = 15_000;
/** Bodies are small: a question and a profile. */
const MAX_BODY_BYTES = 128 * 1024;

const encoder = new TextEncoder();
const encodeFrame = Schema.encodeSync(ResearchFrame);
const frameText = (frame: ResearchFrame) =>
  `event: ${frame._tag}\ndata: ${JSON.stringify(encodeFrame(frame))}\n\n`;

type Outcome =
  | { readonly _tag: 'Done'; readonly frame: ResearchFrame; readonly usage: ResearchUsage }
  | { readonly _tag: 'Failed'; readonly error: Failure; readonly usage?: ResearchUsage };

export const handleResearch = async (
  request: Request,
  deps: HandlerDeps,
  context?: RequestContext,
): Promise<Response> => {
  const { config } = deps;
  const log = deps.log ?? consoleLogger;
  const cors = corsHeaders(request, config);
  const reject = (status: number, code: string, message: string, retryable = false) => {
    log({ event: 'research.rejected', fields: { status, code } });
    return failureResponse(status, code, message, retryable, cors);
  };
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'POST') return reject(405, ErrorCode.MethodNotAllowed, 'Use POST.');

  // Per address, before anything else is read (risk 40). Unknown address: not limited.
  const address = clientAddress(request, context?.clientAddress, deps.trustProxy ?? false);
  const limiter = deps.researchLimit;
  if (address !== undefined && limiter !== undefined) {
    if (limiter.blocked(address)) {
      return reject(429, ErrorCode.TooManyAttempts, 'Too many researches. Try again later.', true);
    }
    limiter.hit(address);
  }

  const body = await readLimited(request, Math.min(config.maxRequestBytes, MAX_BODY_BYTES));
  if (body === 'too-large') {
    return reject(413, ErrorCode.HistoryTooLarge, 'The request is too large.');
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
  const modelField = asRecord(asRecord(json)?.model);
  if (modelField && Object.keys(modelField).some((k) => k.toLowerCase() === 'baseurl')) {
    return reject(
      400,
      ErrorCode.InvalidRequest,
      'model.baseURL is not accepted. Choose an endpointId from GET /api/endpoints.',
    );
  }
  const decoded = Schema.decodeUnknownResult(ResearchRequest)(json, { onExcessProperty: 'error' });
  if (Result.isFailure(decoded)) {
    return reject(400, ErrorCode.InvalidRequest, describeIssue(decoded.failure));
  }
  const input = decoded.success;
  const choice = input.model;
  const misconfigured = () =>
    reject(500, ErrorCode.Misconfigured, 'The server is not configured correctly.');
  const noSearch = () =>
    reject(
      403,
      ErrorCode.SearchUnavailable,
      'This search source is not available here. Pick one from GET /api/search/options.',
    );

  let sources;
  try {
    sources = deps.search === undefined ? undefined : await deps.search();
  } catch {
    return misconfigured();
  }

  let model: ModelRef;
  let ai: Layer.Layer<AiPort> = deps.ai ?? tanstackLayer();
  let search: SearchService | undefined;
  let profile = input.profile === undefined ? defaultProfile : resolveProfile(input.profile);
  let maxOutputTokens = RESEARCH_MAX_OUTPUT_TOKENS;
  let settle: ((calls: number) => void) | undefined;
  const meter: Meter = { calls: 0 };
  if (choice.provider === 'demo') {
    if (body.bytes > DEMO_MAX_REQUEST_BYTES) {
      return reject(413, ErrorCode.HistoryTooLarge, 'The request is too large.');
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
    const inner = sources?.service('demo', input.provider);
    if (inner === undefined) return noSearch();
    const reserved = gate.budget.reserve(RESEARCH_DEMO_CALLS);
    if (reserved._tag === 'Closed') {
      return reject(403, ErrorCode.DemoModeDisabled, 'Demo mode is not available on this server.');
    }
    if (reserved._tag === 'Ok' && reserved.reservation.calls < RESEARCH_DEMO_CALLS) {
      gate.budget.settle(reserved.reservation, 0);
    }
    if (
      reserved._tag === 'Exceeded' ||
      (reserved._tag === 'Ok' && reserved.reservation.calls < RESEARCH_DEMO_CALLS)
    ) {
      return reject(
        429,
        ErrorCode.DemoQuotaExceeded,
        'The demo has used all of its calls for now. Try again later, or use your own key.',
      );
    }
    // On the server's key only the server's prompts run (risk 29).
    profile = defaultProfile;
    model = gate.model;
    const limits = { calls: reserved.reservation.calls, maxOutputTokens };
    ai = meteredAi(ai, limits, meter);
    search = meteredSearch(inner, limits, meter);
    maxOutputTokens = limits.maxOutputTokens;
    const { reservation } = reserved;
    settle = (calls) => gate.budget.settle(reservation, calls);
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
    search = sources?.service('guest', input.provider);
    if (search === undefined) return noSearch();
    const resolved = toModelRef(choice, config);
    if (resolved === undefined) {
      return reject(
        400,
        ErrorCode.UnknownEndpoint,
        'This endpoint id is not allowed on this server.',
      );
    }
    model = resolved;
  }
  const key = model.provider === 'acp' ? undefined : model.apiKey;
  const clean = (failure: Failure): Failure => ({
    ...failure,
    message: redact(failure.message, key).slice(0, 500),
  });

  const program: Effect.Effect<Outcome> = runResearch({
    question: input.question,
    language: input.language,
    profile,
    model,
    maxOutputTokens,
  }).pipe(
    Effect.map((result): Outcome => ({
      _tag: 'Done',
      frame: scrubDeep(
        {
          _tag: 'result',
          title: result.title,
          chunks: result.chunks,
          queries: result.queries,
        } as ResearchFrame,
        key,
      ),
      usage: result.usage,
    })),
    Effect.catchTag('ResearchFailed', (error) =>
      Effect.succeed<Outcome>({ _tag: 'Failed', error: clean(error.failure), usage: error.usage }),
    ),
    Effect.provide(Layer.merge(ai, Layer.succeed(SearchPort, search))),
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause)
        : Effect.succeed<Outcome>({
            _tag: 'Failed',
            error: {
              code: ErrorCode.Internal,
              message: 'The research failed because of a server error.',
              retryable: true,
            },
          }),
    ),
  ) as Effect.Effect<Outcome>;

  const startedAt = Date.now();
  const fields = (extra: LogFields = {}): LogFields => ({
    provider: choice.provider,
    search: input.provider,
    ...extra,
  });
  log({ event: 'research.start', fields: fields() });
  let finished = false;
  const finish = (extra: LogFields) => {
    if (finished) return;
    finished = true;
    settle?.(meter.calls);
    log({
      event: 'research.end',
      fields: fields({ ...extra, durationMs: Date.now() - startedAt }),
    });
  };

  let fiber: Fiber.Fiber<Outcome> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const stop = () => {
    if (heartbeat !== undefined) clearInterval(heartbeat);
    if (fiber !== undefined) Effect.runFork(Fiber.interrupt(fiber));
  };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (text: string) => {
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          // Closed: the client went away.
        }
      };
      const close = () => {
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      };
      heartbeat = setInterval(() => send(': ping\n\n'), HEARTBEAT_MS);
      fiber = Effect.runFork(program);
      request.signal.addEventListener('abort', stop, { once: true });
      fiber.addObserver((exit) => {
        if (heartbeat !== undefined) clearInterval(heartbeat);
        if (Exit.isFailure(exit)) {
          finish({ outcome: 'cancelled', calls: meter.calls });
          return close();
        }
        const outcome = exit.value;
        if (outcome._tag === 'Done') {
          send(frameText(outcome.frame));
          send(frameText({ _tag: 'done', outcome: 'completed' }));
          finish({
            outcome: 'completed',
            calls: outcome.usage.calls,
            searches: outcome.usage.searches,
            inputTokens: outcome.usage.inputTokens,
            outputTokens: outcome.usage.outputTokens,
          });
        } else {
          send(frameText({ _tag: 'error', error: outcome.error }));
          send(frameText({ _tag: 'done', outcome: 'failed' }));
          finish({
            outcome: 'failed',
            code: outcome.error.code,
            calls: outcome.usage?.calls ?? meter.calls,
          });
        }
        close();
      });
    },
    cancel() {
      stop();
    },
  });

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
