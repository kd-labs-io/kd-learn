// `POST /api/models/test`: one tiny model call with the guest's model and key, so the settings
// screen can say whether they work before a lesson starts. Keys are handled like `/api/turns`
// (risk 19): never logged, every message redacted. Limited per address like research (risk 40).
import { Effect, Result, Schema, Stream } from 'effect';
import { failureOf } from '@kd-learn/agent';
import { AiPort } from '@kd-learn/ai/port';
import { layer as tanstackLayer } from '@kd-learn/ai/tanstack';
import { ErrorCode, ModelTestRequest } from '@kd-learn/api';
import type { Failure, ModelTestResponse } from '@kd-learn/api';
import { clientAddress } from '../auth/config.ts';
import { consoleLogger, toModelRef, type HandlerDeps, type RequestContext } from '../handler.ts';
import { SECURITY_HEADERS, corsHeaders, failureResponse, readLimited } from '../http.ts';
import { asRecord, describeIssue, redact } from '../safety.ts';

/** A model name, a key and an endpoint id. */
const MAX_BODY_BYTES = 16 * 1024;
const TEST_TIMEOUT_MS = 30_000;
/** Enough for any model to say a word; reasoning models may spend some before it. */
const TEST_MAX_OUTPUT_TOKENS = 64;

export const handleModelTest = async (
  request: Request,
  deps: HandlerDeps,
  context?: RequestContext,
): Promise<Response> => {
  const { config } = deps;
  const log = deps.log ?? consoleLogger;
  const cors = corsHeaders(request, config);
  const reject = (status: number, code: string, message: string, retryable = false) => {
    log({ event: 'model-test.rejected', fields: { status, code } });
    return failureResponse(status, code, message, retryable, cors);
  };
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'POST') return reject(405, ErrorCode.MethodNotAllowed, 'Use POST.');

  const address = clientAddress(request, context?.clientAddress, deps.trustProxy ?? false);
  const limiter = deps.modelTestLimit;
  if (address !== undefined && limiter !== undefined) {
    if (limiter.blocked(address)) {
      return reject(429, ErrorCode.TooManyAttempts, 'Too many tests. Try again later.', true);
    }
    limiter.hit(address);
  }

  const body = await readLimited(request, Math.min(config.maxRequestBytes, MAX_BODY_BYTES));
  if (body === 'too-large')
    return reject(413, ErrorCode.InvalidRequest, 'The request is too large.');
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
  const decoded = Schema.decodeUnknownResult(ModelTestRequest)(json, { onExcessProperty: 'error' });
  if (Result.isFailure(decoded)) {
    return reject(400, ErrorCode.InvalidRequest, describeIssue(decoded.failure));
  }
  const choice = decoded.success.model;
  if (choice.provider === 'demo') {
    return reject(400, ErrorCode.InvalidRequest, 'The demo has no key to test.');
  }

  let allowed: boolean;
  try {
    allowed = deps.guestAllowed === undefined ? true : await deps.guestAllowed();
  } catch {
    return reject(500, ErrorCode.Misconfigured, 'The server is not configured correctly.');
  }
  if (!allowed) {
    return reject(403, ErrorCode.GuestModeDisabled, 'Guest mode is turned off on this server.');
  }
  const model = toModelRef(choice, config);
  if (model === undefined) {
    return reject(
      400,
      ErrorCode.UnknownEndpoint,
      'This endpoint id is not allowed on this server.',
    );
  }

  const program: Effect.Effect<Failure | undefined> = Effect.gen(function* () {
    const ai = yield* AiPort;
    yield* Stream.runDrain(
      ai.runTurn({
        model,
        messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
        maxSteps: 1,
        maxOutputTokens: TEST_MAX_OUTPUT_TOKENS,
      }),
    );
    return undefined;
  }).pipe(
    Effect.timeoutOrElse({
      duration: TEST_TIMEOUT_MS,
      orElse: () =>
        Effect.succeed<Failure>({
          code: ErrorCode.TurnTimeout,
          message: 'The provider did not answer in time.',
          retryable: true,
        }),
    }),
    Effect.catchTags({
      ProviderError: (error) => Effect.succeed<Failure>(failureOf(error, model)),
      OutputInvalid: (error) => Effect.succeed<Failure>(failureOf(error, model)),
    }),
    Effect.provide(deps.ai ?? tanstackLayer()),
    Effect.catchDefect(() =>
      Effect.succeed<Failure>({
        code: ErrorCode.Internal,
        message: 'The test failed because of a server error.',
        retryable: true,
      }),
    ),
  );

  const startedAt = Date.now();
  const failure = await Effect.runPromise(program, { signal: request.signal });
  log({
    event: 'model-test.end',
    fields: {
      provider: choice.provider,
      ...(choice.provider === 'openai-compatible' ? { endpointId: choice.endpointId } : {}),
      outcome: failure === undefined ? 'ok' : 'failed',
      ...(failure === undefined ? {} : { code: failure.code }),
      durationMs: Date.now() - startedAt,
    },
  });
  if (failure !== undefined) {
    return failureResponse(
      502,
      failure.code,
      redact(failure.message, choice.apiKey).slice(0, 500),
      failure.retryable,
      cors,
    );
  }
  const ok: ModelTestResponse = { ok: true };
  return Response.json(ok, {
    headers: { ...SECURITY_HEADERS, 'cache-control': 'no-store', ...cors },
  });
};
