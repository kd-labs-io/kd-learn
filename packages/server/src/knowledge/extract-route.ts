// `POST /api/knowledge/extract` (phase 3 A3): extraction for guest and demo, without state. The
// client has written `ExtractionStarted`; it sends the session log, its graph slice and its profile,
// and gets back the batch to write. Keys are handled like `/api/turns` (risk 19): never logged,
// error text built from codes, every outgoing message redacted against the request's key.
import { Cause, Effect, Exit, Fiber, Layer, Result, Schema } from 'effect';
import {
  EXTRACTION_MAX_OUTPUT_TOKENS,
  defaultProfile,
  resolveProfile,
  runExtraction,
} from '@kd-learn/agent';
import type { ExtractionUsage } from '@kd-learn/agent';
import type { AiPort, ModelRef } from '@kd-learn/ai/port';
import { layer as tanstackLayer } from '@kd-learn/ai/tanstack';
import { ErrorCode, ExtractFrame, ExtractRequest, MAX_DOCUMENT_SLICE_BYTES } from '@kd-learn/api';
import type { Failure } from '@kd-learn/api';
import { DEMO_ROLE_OUTPUT_CAPS, meteredAi, type Meter } from '../demo/metered.ts';
import type { DemoGate } from '../demo/service.ts';
import {
  DEMO_MAX_REQUEST_BYTES,
  consoleLogger,
  toModelRef,
  type HandlerDeps,
  type LogFields,
} from '../handler.ts';
import { SECURITY_HEADERS, corsHeaders, failureResponse, readLimited } from '../http.ts';
import { asRecord, describeIssue, redact, scrubDeep } from '../safety.ts';

/** Model calls of one extraction: extractor, auditor, merge. */
export const EXTRACTION_CALLS = 3;
/** Keeps proxies from closing the stream while the model works (an extraction takes ~1 minute). */
const HEARTBEAT_MS = 15_000;

const encoder = new TextEncoder();
const encodeFrame = Schema.encodeSync(ExtractFrame);
const frameText = (frame: ExtractFrame) =>
  `event: ${frame._tag}\ndata: ${JSON.stringify(encodeFrame(frame))}\n\n`;

type Outcome =
  | { readonly _tag: 'Extracted'; readonly frame: ExtractFrame; readonly usage: ExtractionUsage }
  | { readonly _tag: 'Failed'; readonly error: Failure; readonly usage?: ExtractionUsage };

export const handleExtract = async (request: Request, deps: HandlerDeps): Promise<Response> => {
  const { config } = deps;
  const log = deps.log ?? consoleLogger;
  const cors = corsHeaders(request, config);
  const reject = (status: number, code: string, message: string, retryable = false) => {
    log({ event: 'extract.rejected', fields: { status, code } });
    return failureResponse(status, code, message, retryable, cors);
  };

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'POST') return reject(405, ErrorCode.MethodNotAllowed, 'Use POST.');

  const body = await readLimited(request, config.maxRequestBytes);
  if (body === 'too-large') {
    return reject(
      413,
      ErrorCode.HistoryTooLarge,
      `The request is larger than ${config.maxRequestBytes} bytes.`,
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
  const modelField = asRecord(asRecord(json)?.model);
  if (modelField && Object.keys(modelField).some((k) => k.toLowerCase() === 'baseurl')) {
    return reject(
      400,
      ErrorCode.InvalidRequest,
      'model.baseURL is not accepted. Choose an endpointId from GET /api/endpoints.',
    );
  }
  const decoded = Schema.decodeUnknownResult(ExtractRequest)(json, { onExcessProperty: 'error' });
  if (Result.isFailure(decoded)) {
    return reject(400, ErrorCode.InvalidRequest, describeIssue(decoded.failure));
  }
  const input = decoded.success;
  if (
    input.documentSlice !== undefined &&
    new TextEncoder().encode(JSON.stringify(input.documentSlice)).byteLength >
      MAX_DOCUMENT_SLICE_BYTES
  ) {
    return reject(
      413,
      ErrorCode.HistoryTooLarge,
      `documentSlice is limited to ${MAX_DOCUMENT_SLICE_BYTES} bytes.`,
    );
  }
  const choice = input.model;
  const misconfigured = () =>
    reject(500, ErrorCode.Misconfigured, 'The server is not configured correctly.');

  let model: ModelRef;
  let ai: Layer.Layer<AiPort> = deps.ai ?? tanstackLayer();
  let maxOutputTokens = EXTRACTION_MAX_OUTPUT_TOKENS;
  let profile = input.profile === undefined ? defaultProfile : resolveProfile(input.profile);
  let settle: ((calls: number) => void) | undefined;
  const meter: Meter = { calls: 0 };
  if (choice.provider === 'demo') {
    if (body.bytes > DEMO_MAX_REQUEST_BYTES) {
      return reject(
        413,
        ErrorCode.HistoryTooLarge,
        `A demo request is limited to ${DEMO_MAX_REQUEST_BYTES} bytes.`,
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
    const reserved = gate.budget.reserve(EXTRACTION_CALLS);
    if (reserved._tag === 'Closed') {
      return reject(403, ErrorCode.DemoModeDisabled, 'Demo mode is not available on this server.');
    }
    // Fewer calls left than an extraction may need: refuse now rather than stop it halfway.
    if (reserved._tag === 'Ok' && reserved.reservation.calls < EXTRACTION_CALLS) {
      gate.budget.settle(reserved.reservation, 0);
    }
    if (
      reserved._tag === 'Exceeded' ||
      (reserved._tag === 'Ok' && reserved.reservation.calls < EXTRACTION_CALLS)
    ) {
      return reject(
        429,
        ErrorCode.DemoQuotaExceeded,
        'The demo has used all of its calls for now. Try again later, or use your own key.',
      );
    }
    // On the server's key only the server's prompts run (A2, risk 29).
    profile = defaultProfile;
    model = gate.model;
    maxOutputTokens = DEMO_ROLE_OUTPUT_CAPS.extractor;
    ai = meteredAi(ai, { calls: reserved.reservation.calls, maxOutputTokens }, meter);
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

  const newId = deps.newId ?? (() => crypto.randomUUID());
  const program: Effect.Effect<Outcome> = runExtraction({
    log: input.log,
    slice: input.slice,
    ...(input.documentSlice === undefined ? {} : { documentSlice: input.documentSlice }),
    profile,
    model,
    extractionId: input.extractionId,
    newId,
    maxOutputTokens,
  }).pipe(
    Effect.map((result): Outcome => ({
      _tag: 'Extracted',
      frame: { _tag: 'result', events: scrubDeep(result.events, key) },
      usage: result.usage,
    })),
    Effect.catchTags({
      InvalidExtraction: (error) =>
        Effect.succeed<Outcome>({
          _tag: 'Failed',
          error: clean({
            code: ErrorCode.InvalidRequest,
            message: error.message,
            retryable: false,
          }),
        }),
      ExtractionModelFailed: (error) =>
        Effect.succeed<Outcome>({
          _tag: 'Failed',
          error: clean(error.failure),
          usage: error.usage,
        }),
    }),
    Effect.provide(ai),
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause)
        : Effect.succeed<Outcome>({
            _tag: 'Failed',
            error: {
              code: ErrorCode.Internal,
              message: 'The extraction failed because of a server error.',
              retryable: true,
            },
          }),
    ),
  ) as Effect.Effect<Outcome>;

  const startedAt = Date.now();
  const fields = (extra: LogFields = {}): LogFields => ({
    provider: choice.provider,
    ...(choice.provider === 'openai-compatible' ? { endpointId: choice.endpointId } : {}),
    requestBytes: body.bytes,
    slice: input.slice.length,
    ...extra,
  });
  log({ event: 'extract.start', fields: fields() });

  let finished = false;
  const finish = (extra: LogFields) => {
    if (finished) return;
    finished = true;
    settle?.(meter.calls);
    log({ event: 'extract.end', fields: fields({ ...extra, durationMs: Date.now() - startedAt }) });
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
      heartbeat = setInterval(() => send(': ping\n\n'), HEARTBEAT_MS);
      fiber = Effect.runFork(program);
      // Closing the connection interrupts the provider request (plan 3.3).
      request.signal.addEventListener('abort', stop, { once: true });
      fiber.addObserver((exit) => {
        if (heartbeat !== undefined) clearInterval(heartbeat);
        if (Exit.isFailure(exit)) {
          finish({ outcome: 'cancelled', calls: meter.calls });
          try {
            controller.close();
          } catch {
            // Already closed.
          }
          return;
        }
        const outcome = exit.value;
        if (outcome._tag === 'Extracted') {
          send(frameText(outcome.frame));
          send(frameText({ _tag: 'done', outcome: 'completed' }));
          finish({
            outcome: 'completed',
            events: outcome.frame._tag === 'result' ? outcome.frame.events.length : 0,
            calls: outcome.usage.calls,
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
        try {
          controller.close();
        } catch {
          // Already closed.
        }
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
