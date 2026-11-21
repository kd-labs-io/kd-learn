// `POST /api/practice/issue` and `POST /api/practice/grade` (plan luyen-tap-graph.md A7, A8): the
// stateless practice routes of guest and demo mode. Same gates as `/api/turns`: guest switch, demo
// gate and budget, no free base URL, endpoint ids only. Answers are JSON (one model call each, no
// text to stream): the events the client appends to its own knowledge log.
//
// Keys (risk 19): the request is never logged, log fields are scalars, error text comes from paths
// and codes or from `failureOf` (which redacts the key), and the whole answer is redacted again.
import { Cause, Effect, Exit, Result, Schema } from 'effect';
import type { Layer } from 'effect';
import { defaultProfile, failureOf, gradeExercise, writeExercises } from '@kd-learn/agent';
import type { AiError, AiPort, ModelRef } from '@kd-learn/ai/port';
import { layer as tanstackLayer } from '@kd-learn/ai/tanstack';
import {
  ErrorCode,
  GradeAnswerRequest,
  GradeAnswerResponse,
  IssueExercisesRequest,
  IssueExercisesResponse,
  PRACTICE_GRADE_PATH,
  PRACTICE_ISSUE_PATH,
} from '@kd-learn/api';
import type { KnowledgeSlice, ModelChoice } from '@kd-learn/api';
import {
  emptyKnowledgeGraph,
  exerciseTypes,
  type Edge,
  type ExerciseTarget,
  type KnowledgeEvent,
  type KnowledgeGraph,
  type Proposition,
  type TeachingProfile,
} from '@kd-learn/core';
import { DEMO_ROLE_OUTPUT_CAPS, meteredAi, type Meter } from '../demo/metered.ts';
import type { DemoGate } from '../demo/service.ts';
import {
  DEMO_MAX_REQUEST_BYTES,
  consoleLogger,
  toModelRef,
  type Handler,
  type HandlerDeps,
  type LogFields,
} from '../handler.ts';
import { SECURITY_HEADERS, corsHeaders, failureResponse, readLimited } from '../http.ts';
import { asRecord, describeIssue, redact } from '../safety.ts';

const LANGUAGE_TAG = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8}){0,3}$/;

/** On the server's key only the server's prompts run; the learner keeps their language. */
const serverProfile = (profile: TeachingProfile): TeachingProfile => ({
  ...defaultProfile,
  language: LANGUAGE_TAG.test(profile.language) ? profile.language : defaultProfile.language,
});

/** The graph the Practitioner needs, built from the slice the client sent. */
export const graphOfSlice = (slice: KnowledgeSlice): KnowledgeGraph => {
  const propositions: Record<string, Proposition> = {};
  for (const p of slice.propositions) {
    propositions[p.propositionId] = {
      propositionId: p.propositionId,
      text: p.text,
      topic: '',
      sources: [],
      addedAt: 0,
      updatedAt: 0,
    };
  }
  const edges: Record<string, Edge> = {};
  for (const e of slice.edges) {
    if (propositions[e.from] !== undefined && propositions[e.to] !== undefined) edges[e.edgeId] = e;
  }
  return { ...emptyKnowledgeGraph, propositions, edges };
};

/** Why a target does not fit the slice, or undefined. Names ids, never text. */
const targetProblem = (graph: KnowledgeGraph, target: ExerciseTarget, index: number) => {
  const missing = target.propositionIds.find((id) => graph.propositions[id] === undefined);
  if (missing !== undefined)
    return `targets.${index}: proposition "${missing}" is not in the slice.`;
  const edge = target.edgeIds.find((id) => graph.edges[id] === undefined);
  if (edge !== undefined) return `targets.${index}: edge "${edge}" is not in the slice.`;
  if (target.type === 'orderChain' && target.propositionIds.length < 3) {
    return `targets.${index}: an ordering exercise needs at least 3 propositions.`;
  }
  if (target.type !== 'orderChain' && target.propositionIds.length > 2) {
    return `targets.${index}: a ${target.type} exercise tests at most 2 propositions.`;
  }
  return undefined;
};

type Rejecter = (status: number, code: string, message: string, retryable?: boolean) => Response;

interface Opened {
  readonly model: ModelRef;
  readonly ai: Layer.Layer<AiPort>;
  readonly demo: boolean;
  /** Gives back the unused part of the demo reservation. Safe to call more than once. */
  readonly settle: () => void;
}

/**
 * The model of a guest or demo request, behind the same gates as `/api/turns`. Demo reserves
 * `calls` (none when 0: nothing to call) and caps output tokens at `maxOutputTokens`.
 */
const openModel = async (
  choice: ModelChoice,
  deps: HandlerDeps,
  options: { readonly calls: number; readonly maxOutputTokens: number; readonly reject: Rejecter },
): Promise<Opened | Response> => {
  const { reject } = options;
  const misconfigured = () =>
    reject(500, ErrorCode.Misconfigured, 'The server is not configured correctly.');
  const ai = deps.ai ?? tanstackLayer();
  if (choice.provider === 'demo') {
    let gate: DemoGate;
    try {
      gate = deps.demo === undefined ? { _tag: 'Disabled' } : await deps.demo();
    } catch {
      return misconfigured();
    }
    const disabled = () =>
      reject(403, ErrorCode.DemoModeDisabled, 'Demo mode is not available on this server.');
    if (gate._tag === 'Disabled') return disabled();
    if (options.calls === 0) {
      return { model: gate.model, ai, demo: true, settle: () => undefined };
    }
    const reserved = gate.budget.reserve(options.calls);
    if (reserved._tag === 'Closed') return disabled();
    if (reserved._tag === 'Exceeded') {
      return reject(
        429,
        ErrorCode.DemoQuotaExceeded,
        'The demo has used all of its calls for now. Try again later, or use your own key.',
      );
    }
    const { reservation } = reserved;
    const meter: Meter = { calls: 0 };
    let settled = false;
    return {
      model: gate.model,
      ai: meteredAi(
        ai,
        { calls: reservation.calls, maxOutputTokens: options.maxOutputTokens },
        meter,
      ),
      demo: true,
      settle: () => {
        if (settled) return;
        settled = true;
        gate.budget.settle(reservation, meter.calls);
      },
    };
  }
  let allowed: boolean;
  try {
    allowed = deps.guestAllowed === undefined ? true : await deps.guestAllowed();
  } catch {
    return misconfigured();
  }
  if (!allowed) {
    return reject(403, ErrorCode.GuestModeDisabled, 'Guest mode is turned off on this server.');
  }
  const model = toModelRef(choice, deps.config);
  if (model === undefined) {
    return reject(
      400,
      ErrorCode.UnknownEndpoint,
      'This endpoint id is not allowed on this server.',
    );
  }
  return { model, ai, demo: false, settle: () => undefined };
};

type Outcome<A> =
  | { readonly _tag: 'Ok'; readonly value: A }
  | {
      readonly _tag: 'Failed';
      readonly code: string;
      readonly message: string;
      readonly retryable: boolean;
      /** For the log only: a redacted summary of a defect. */
      readonly detail?: string;
    }
  | { readonly _tag: 'Cancelled' };

/** Runs one Practitioner call; a disconnect aborts the provider request. Never rejects. */
const runModel = async <A>(
  program: Effect.Effect<A, AiError, AiPort>,
  opened: Opened,
  signal: AbortSignal,
): Promise<Outcome<A>> => {
  const key = opened.model.provider === 'acp' ? '' : opened.model.apiKey;
  const exit = await Effect.runPromiseExit(program.pipe(Effect.provide(opened.ai)), { signal });
  if (Exit.isSuccess(exit)) return { _tag: 'Ok', value: exit.value };
  if (Cause.hasInterruptsOnly(exit.cause)) return { _tag: 'Cancelled' };
  const error = Cause.findErrorOption(exit.cause);
  if (error._tag === 'Some') return { _tag: 'Failed', ...failureOf(error.value, opened.model) };
  // A defect: the cause can hold the key, so the client gets a fixed message.
  return {
    _tag: 'Failed',
    code: ErrorCode.Internal,
    message: 'Practice failed because of a server error.',
    retryable: true,
    detail: redact(String(Cause.squash(exit.cause)), key).slice(0, 200),
  };
};

const failedFields = (outcome: Exclude<Outcome<unknown>, { _tag: 'Ok' }>): LogFields =>
  outcome._tag === 'Cancelled'
    ? { outcome: 'cancelled' }
    : {
        outcome: 'failed',
        code: outcome.code,
        ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
      };

export const makePracticeHandler = (deps: HandlerDeps): Handler => {
  const { config } = deps;
  const log = deps.log ?? consoleLogger;
  const newId = deps.newId ?? (() => crypto.randomUUID());

  return async (request) => {
    const path = new URL(request.url).pathname.replace(/\/+$/, '');
    const kind =
      path === PRACTICE_ISSUE_PATH ? 'issue' : path === PRACTICE_GRADE_PATH ? 'grade' : '';
    const cors = corsHeaders(request, config);
    const reject: Rejecter = (status, code, message, retryable = false) => {
      log({ event: 'practice.rejected', fields: { kind, status, code } });
      return failureResponse(status, code, message, retryable, cors);
    };
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (kind === '') return reject(404, ErrorCode.NotFound, 'Not found.');
    if (request.method !== 'POST') return reject(405, ErrorCode.MethodNotAllowed, 'Use POST.');

    const body = await readLimited(request, config.maxRequestBytes);
    if (body === 'too-large') {
      return reject(413, ErrorCode.InvalidRequest, 'The request is too large.');
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
    // A free base URL is never accepted (risk 6).
    const modelField = asRecord(asRecord(json)?.model);
    if (modelField && Object.keys(modelField).some((k) => k.toLowerCase() === 'baseurl')) {
      return reject(
        400,
        ErrorCode.InvalidRequest,
        'model.baseURL is not accepted. Choose an endpointId from GET /api/endpoints.',
      );
    }
    if (asRecord(modelField)?.provider === 'demo' && body.bytes > DEMO_MAX_REQUEST_BYTES) {
      return reject(
        413,
        ErrorCode.InvalidRequest,
        `A demo request is limited to ${DEMO_MAX_REQUEST_BYTES} bytes.`,
      );
    }

    const respond = (value: unknown, key: string) =>
      new Response(redact(JSON.stringify(value), key), {
        status: 200,
        headers: {
          ...SECURITY_HEADERS,
          ...cors,
          'content-type': 'application/json',
          'cache-control': 'no-store',
        },
      });

    const startedAt = Date.now();
    const end = (opened: Opened, choice: ModelChoice, extra: LogFields) => {
      opened.settle();
      log({
        event: 'practice.end',
        fields: {
          kind,
          provider: choice.provider,
          ...(choice.provider === 'openai-compatible' ? { endpointId: choice.endpointId } : {}),
          requestBytes: body.bytes,
          durationMs: Date.now() - startedAt,
          ...extra,
        },
      });
    };
    const failed = (outcome: Exclude<Outcome<unknown>, { _tag: 'Ok' }>, key: string) =>
      outcome._tag === 'Cancelled'
        ? reject(499, 'Cancelled', 'The request was cancelled.', true)
        : failureResponse(
            outcome.code === ErrorCode.Internal ? 500 : 502,
            outcome.code,
            redact(outcome.message, key),
            outcome.retryable,
            cors,
          );

    if (kind === 'issue') {
      const decoded = Schema.decodeUnknownResult(IssueExercisesRequest)(json, {
        onExcessProperty: 'error',
      });
      if (Result.isFailure(decoded)) {
        return reject(400, ErrorCode.InvalidRequest, describeIssue(decoded.failure));
      }
      const input = decoded.success;
      const graph = graphOfSlice(input.slice);
      const targets = input.targets as ReadonlyArray<ExerciseTarget>;
      const problem = targets
        .map((t, i) => targetProblem(graph, t, i))
        .find((p) => p !== undefined);
      if (problem !== undefined) return reject(400, ErrorCode.InvalidRequest, problem);

      const calls = targets.some((t) => t.type !== 'orderChain') ? 1 : 0;
      const opened = await openModel(input.model, deps, {
        calls,
        maxOutputTokens: DEMO_ROLE_OUTPUT_CAPS.practitioner,
        reject,
      });
      if (opened instanceof Response) return opened;
      const key = opened.model.provider === 'acp' ? '' : opened.model.apiKey;
      const practiceId = newId();
      const outcome = await runModel(
        writeExercises({
          graph,
          targets,
          profile: opened.demo ? serverProfile(input.profile) : input.profile,
          model: opened.model,
          seed: practiceId,
        }),
        opened,
        request.signal,
      );
      if (outcome._tag !== 'Ok') {
        end(opened, input.model, failedFields(outcome));
        return failed(outcome, key);
      }
      const at = Date.now();
      const events: Array<KnowledgeEvent> = [
        { _tag: 'PracticeStarted', id: newId(), at, practiceId },
        ...outcome.value.exercises.map(({ target, content }): KnowledgeEvent => ({
          _tag: 'ExerciseIssued',
          id: newId(),
          at,
          practiceId,
          exerciseId: newId(),
          type: target.type,
          propositionIds: target.propositionIds,
          edgeIds: target.edgeIds,
          content,
        })),
      ];
      end(opened, input.model, { outcome: 'completed', exercises: events.length - 1 });
      if (events.length === 1) {
        return reject(409, ErrorCode.NothingToRun, 'None of the targets could be written.');
      }
      return respond(Schema.encodeSync(IssueExercisesResponse)({ events }), key);
    }

    const decoded = Schema.decodeUnknownResult(GradeAnswerRequest)(json, {
      onExcessProperty: 'error',
    });
    if (Result.isFailure(decoded)) {
      return reject(400, ErrorCode.InvalidRequest, describeIssue(decoded.failure));
    }
    const input = decoded.success;
    if (exerciseTypes[input.content.type].grading !== 'model') {
      return reject(
        400,
        ErrorCode.InvalidRequest,
        `A ${input.content.type} exercise is graded on the client.`,
      );
    }
    if (input.answer.type !== input.content.type) {
      return reject(400, ErrorCode.InvalidRequest, 'answer.type must match content.type.');
    }
    const opened = await openModel(input.model, deps, {
      calls: 1,
      maxOutputTokens: DEMO_ROLE_OUTPUT_CAPS.practitioner,
      reject,
    });
    if (opened instanceof Response) return opened;
    const key = opened.model.provider === 'acp' ? '' : opened.model.apiKey;
    const profile = opened.demo ? serverProfile(input.profile) : input.profile;
    const outcome = await runModel(
      gradeExercise({ content: input.content, answer: input.answer, profile, model: opened.model }),
      opened,
      request.signal,
    );
    if (outcome._tag !== 'Ok') {
      end(opened, input.model, failedFields(outcome));
      return failed(outcome, key);
    }
    end(opened, input.model, { outcome: 'completed' });
    const graded: KnowledgeEvent = {
      _tag: 'ExerciseGraded',
      id: newId(),
      at: Date.now(),
      exerciseId: input.exerciseId,
      score: outcome.value.score,
      feedback: outcome.value.feedback,
      profileId: profile.id,
    };
    return respond(Schema.encodeSync(GradeAnswerResponse)({ events: [graded] }), key);
  };
};
