// Extraction of account sessions (phase 3 A3). The server starts one right after it writes a batch
// with `SessionCompleted`, in a daemon fiber like a turn, so closing the tab does not stop it.
// The knowledge log is shared by all sessions of a user: one extraction runs at a time per user,
// the others wait in a queue. `ExtractionStarted` is written when the job is queued (the attempt
// exists from then on); after a restart, attempts that never ended become `Interrupted`.
import { Cause, Duration, Effect, Exit, Fiber, Layer, Result } from 'effect';
import { EXTRACTION_MAX_OUTPUT_TOKENS, runExtraction } from '@kd-learn/agent';
import type { AiPort } from '@kd-learn/ai/port';
import { ErrorCode } from '@kd-learn/api';
import type { ExtractionState, Failure, SessionExtraction } from '@kd-learn/api';
import {
  extractionStatus,
  fitKnowledgeBatch,
  projectKnowledge,
  projectSession,
  selectSessionSlice,
  sessionQueryText,
  type EventLog,
  type KnowledgeEvent,
  type KnowledgeGraph,
} from '@kd-learn/core';
import { appendKnowledgeChecked, type StorageService } from '@kd-learn/storage/port';
import type { ServerStorage } from '@kd-learn/storage/sqlite-node';
import type { Logger } from '../handler.ts';
import { activeProfile } from '../profile.ts';
import { redact, scrubDeep } from '../safety.ts';
import type { ResolveResult, SettingsService } from '../settings/service.ts';

export type ExtractRequestResult =
  | { readonly _tag: 'Ok' }
  | { readonly _tag: 'NotFound' }
  /** Already queued or running. */
  | { readonly _tag: 'InProgress' }
  /** Extracted already, or nothing to extract (no completed turn). */
  | { readonly _tag: 'NothingToRun'; readonly message: string }
  /** No model for `extractor` nor `teacher`: no attempt is written (A3). */
  | { readonly _tag: 'ModelUnavailable'; readonly result: Exclude<ResolveResult, { _tag: 'Ok' }> };

export interface ExtractionJobs {
  /** Called after a batch with `SessionCompleted` is written. Runs only if never attempted. */
  readonly sessionCompleted: (userId: string, sessionId: string) => void;
  /** "Extract now" and retry (A3). */
  readonly request: (userId: string, sessionId: string) => ExtractRequestResult;
  /** Every session of the user with its extraction state, newest first. */
  readonly list: (userId: string) => ReadonlyArray<SessionExtraction>;
  /** Startup: attempts that never ended are written as `Interrupted` (no job survives a restart). */
  readonly recoverInterrupted: (userIds: ReadonlyArray<string>) => void;
  /** Resolves when the user has nothing queued or running (tests). */
  readonly idle: (userId: string) => Promise<void>;
  /** Interrupts every job (shutdown, tests). Nothing is written for them. */
  readonly stopAll: () => Promise<void>;
}

export interface ExtractionJobDeps {
  readonly storage: ServerStorage;
  readonly settings: SettingsService;
  readonly ai: Layer.Layer<AiPort>;
  readonly log: Logger;
  readonly newId?: () => string;
  readonly now?: () => number;
  /** Upper bound on one extraction (three model calls). Default 10 minutes. */
  readonly timeoutMs?: number;
}

interface Queue {
  running?: { readonly sessionId: string; fiber?: Fiber.Fiber<void> };
  readonly waiting: Array<{ readonly sessionId: string; readonly extractionId: string }>;
  readonly idle: Array<() => void>;
}

const graphOf = (storage: StorageService): KnowledgeGraph => {
  const projected = projectKnowledge(Effect.runSync(storage.readKnowledge));
  // The log is written only through checked appends; a failure here is a bug, surfaced loudly.
  if (Result.isFailure(projected)) throw new Error('The knowledge log does not project.');
  return projected.success;
};

const hasCompletedTurn = (log: EventLog) => log.some((event) => event._tag === 'TurnCompleted');

export const makeExtractionJobs = (deps: ExtractionJobDeps): ExtractionJobs => {
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? 10 * 60 * 1000;
  const queues = new Map<string, Queue>();

  const queueOf = (userId: string): Queue => {
    let queue = queues.get(userId);
    if (queue === undefined) {
      queue = { waiting: [], idle: [] };
      queues.set(userId, queue);
    }
    return queue;
  };
  const busy = (userId: string, sessionId: string) => {
    const queue = queues.get(userId);
    return (
      queue !== undefined &&
      (queue.running?.sessionId === sessionId ||
        queue.waiting.some((job) => job.sessionId === sessionId))
    );
  };

  const failed = (
    sessionId: string,
    extractionId: string,
    failure: Failure,
  ): ReadonlyArray<KnowledgeEvent> => [
    { _tag: 'ExtractionFailed', id: newId(), at: now(), sessionId, extractionId, ...failure },
  ];

  /** Writes the end of an attempt that failed; never fails itself (the attempt stays open then). */
  const writeFailure = (
    storage: StorageService,
    sessionId: string,
    extractionId: string,
    failure: Failure,
  ) =>
    appendKnowledgeChecked(storage, () => failed(sessionId, extractionId, failure)).pipe(
      Effect.asVoid,
      Effect.catch(() =>
        Effect.sync(() => deps.log({ event: 'knowledge.extract.unwritten', fields: {} })),
      ),
    );

  /** One job: read, call the model three times, fit the batch to the graph as it is now, write. */
  const job = (userId: string, sessionId: string, extractionId: string): Effect.Effect<void> => {
    const storage = deps.storage.forUser(userId);
    const startedAt = now();
    const end = (fields: Record<string, string | number>) =>
      deps.log({
        event: 'knowledge.extract.end',
        fields: { ...fields, durationMs: now() - startedAt },
      });
    return Effect.gen(function* () {
      const resolved = deps.settings.resolveModel(userId, 'extractor');
      if (resolved._tag !== 'Ok') {
        end({ outcome: 'failed', code: ErrorCode.RoleNotConfigured });
        return yield* writeFailure(storage, sessionId, extractionId, {
          code: ErrorCode.RoleNotConfigured,
          message: 'No model is set for extraction.',
          retryable: true,
        });
      }
      const model = resolved.model;
      const key = model.provider === 'acp' ? undefined : model.apiKey;
      const log = yield* storage.readSession(sessionId);
      const session = projectSession(log);
      if (Result.isFailure(session)) {
        end({ outcome: 'failed', code: ErrorCode.InvalidTurn });
        return yield* writeFailure(storage, sessionId, extractionId, {
          code: ErrorCode.InvalidTurn,
          message: 'The saved lesson cannot be read.',
          retryable: false,
        });
      }
      const graph = graphOf(storage);
      const { profile } = yield* activeProfile(storage);
      const slice = selectSessionSlice(graph, sessionQueryText(session.success));
      const outcome = yield* runExtraction({
        log,
        slice,
        profile,
        model,
        extractionId,
        newId,
        maxOutputTokens: EXTRACTION_MAX_OUTPUT_TOKENS,
      }).pipe(
        Effect.provide(deps.ai),
        Effect.timeoutOrElse({
          duration: Duration.millis(timeoutMs),
          orElse: () =>
            Effect.succeed({
              _tag: 'Timeout' as const,
            }),
        }),
        Effect.result,
      );
      if (Result.isFailure(outcome)) {
        const error = outcome.failure;
        const failure: Failure =
          error._tag === 'InvalidExtraction'
            ? { code: ErrorCode.InvalidRequest, message: error.message, retryable: false }
            : error.failure;
        const clean = { ...failure, message: redact(failure.message, key).slice(0, 500) };
        end({
          outcome: 'failed',
          code: clean.code,
          ...(error._tag === 'ExtractionModelFailed' ? { calls: error.usage.calls } : {}),
        });
        return yield* writeFailure(storage, sessionId, extractionId, clean);
      }
      if ('_tag' in outcome.success && outcome.success._tag === 'Timeout') {
        end({ outcome: 'failed', code: ErrorCode.TurnTimeout });
        return yield* writeFailure(storage, sessionId, extractionId, {
          code: ErrorCode.TurnTimeout,
          message: 'The extraction ran out of time.',
          retryable: true,
        });
      }
      const result = outcome.success as Exclude<typeof outcome.success, { _tag: 'Timeout' }>;
      const written = yield* appendKnowledgeChecked(
        storage,
        (current) => fitKnowledgeBatch(current, scrubDeep(result.events, key)).events,
      ).pipe(Effect.result);
      if (Result.isFailure(written)) {
        end({ outcome: 'failed', code: ErrorCode.Conflict, calls: result.usage.calls });
        // The log moved under the extraction (a merge into a retired proposition, A3).
        return yield* writeFailure(storage, sessionId, extractionId, {
          code: ErrorCode.Conflict,
          message: 'The result no longer fits the graph. Try again.',
          retryable: true,
        });
      }
      end({
        outcome: 'completed',
        calls: result.usage.calls,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        events: result.events.length,
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.gen(function* () {
              deps.log({ event: 'knowledge.extract.crashed', fields: {} });
              yield* writeFailure(storage, sessionId, extractionId, {
                code: ErrorCode.Internal,
                message: 'The extraction failed because of a server error.',
                retryable: true,
              });
            }),
      ),
    ) as Effect.Effect<void>;
  };

  const pump = (userId: string) => {
    const queue = queueOf(userId);
    if (queue.running !== undefined) return;
    const next = queue.waiting.shift();
    if (next === undefined) {
      queues.delete(userId);
      queue.idle.splice(0).forEach((resolve) => resolve());
      return;
    }
    const running: NonNullable<Queue['running']> = { sessionId: next.sessionId };
    queue.running = running;
    running.fiber = Effect.runFork(
      job(userId, next.sessionId, next.extractionId).pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => {
            if (queue.running === running) delete queue.running;
            // Interrupted by `stopAll`: leave the rest for the next start (they become Interrupted).
            if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)) return;
            pump(userId);
          }),
        ),
      ),
    );
  };

  /** Checks, writes `ExtractionStarted` and queues. `auto`: only a session never attempted. */
  const enqueue = (userId: string, sessionId: string, auto: boolean): ExtractRequestResult => {
    const storage = deps.storage.forUser(userId);
    const log = Effect.runSync(storage.readSession(sessionId));
    if (log.length === 0) return { _tag: 'NotFound' };
    if (busy(userId, sessionId)) return { _tag: 'InProgress' };
    if (!hasCompletedTurn(log)) {
      return { _tag: 'NothingToRun', message: 'This session has nothing to extract yet.' };
    }
    const status = extractionStatus(graphOf(storage), sessionId);
    if (status === 'extracted') {
      return { _tag: 'NothingToRun', message: 'This session is already extracted.' };
    }
    if (auto && status !== 'none') {
      return { _tag: 'NothingToRun', message: 'This session was attempted already.' };
    }
    const resolved = deps.settings.resolveModel(userId, 'extractor');
    if (resolved._tag !== 'Ok') return { _tag: 'ModelUnavailable', result: resolved };
    const extractionId = newId();
    const written = Effect.runSync(
      appendKnowledgeChecked(storage, (graph) => {
        const batch: KnowledgeEvent[] = [];
        // An attempt still open here is not running (`busy` said so): it was interrupted.
        const extraction = graph.extractions[sessionId];
        const last = extraction?.attempts.at(-1);
        if (last?.status === 'started') {
          batch.push(
            ...failed(sessionId, last.extractionId, {
              code: 'Interrupted',
              message: 'The extraction was interrupted.',
              retryable: true,
            }),
          );
        }
        batch.push({ _tag: 'ExtractionStarted', id: newId(), at: now(), sessionId, extractionId });
        return batch;
      }).pipe(Effect.result),
    );
    if (Result.isFailure(written)) {
      return { _tag: 'NothingToRun', message: 'The extraction cannot start now. Try again.' };
    }
    queueOf(userId).waiting.push({ sessionId, extractionId });
    deps.log({ event: 'knowledge.extract.queued', fields: { auto } });
    pump(userId);
    return { _tag: 'Ok' };
  };

  const stateOf = (
    userId: string,
    sessionId: string,
    graph: KnowledgeGraph,
  ): { state: ExtractionState; failure?: Failure } => {
    const queue = queues.get(userId);
    if (queue?.running?.sessionId === sessionId) return { state: 'running' };
    if (queue?.waiting.some((job) => job.sessionId === sessionId)) return { state: 'queued' };
    const status = extractionStatus(graph, sessionId);
    if (status === 'failed') {
      const failure = graph.extractions[sessionId]?.attempts.at(-1)?.failure;
      return failure === undefined ? { state: 'failed' } : { state: 'failed', failure };
    }
    // Started, but no job holds it: interrupted. Shown as failed so the retry button appears.
    if (status === 'running') {
      return {
        state: 'failed',
        failure: {
          code: 'Interrupted',
          message: 'The extraction was interrupted.',
          retryable: true,
        },
      };
    }
    return { state: status };
  };

  return {
    sessionCompleted: (userId, sessionId) => {
      try {
        const result = enqueue(userId, sessionId, true);
        if (result._tag !== 'Ok') {
          deps.log({ event: 'knowledge.extract.skipped', fields: { reason: result._tag } });
        }
      } catch {
        // The turn is written; a failure to queue its extraction must not fail it.
        deps.log({ event: 'knowledge.extract.crashed', fields: {} });
      }
    },

    request: (userId, sessionId) => enqueue(userId, sessionId, false),

    list: (userId) => {
      const storage = deps.storage.forUser(userId);
      const graph = graphOf(storage);
      return Effect.runSync(storage.listSessions).map((summary) => {
        const log = Effect.runSync(storage.readSession(summary.sessionId));
        const completed = log.some((event) => event._tag === 'SessionCompleted');
        return {
          sessionId: summary.sessionId,
          topic: summary.topic,
          completed,
          ...stateOf(userId, summary.sessionId, graph),
        };
      });
    },

    recoverInterrupted: (userIds) => {
      for (const userId of userIds) {
        const storage = deps.storage.forUser(userId);
        const result = Effect.runSync(
          appendKnowledgeChecked(storage, (graph) =>
            Object.entries(graph.extractions).flatMap(([sessionId, extraction]) => {
              const last = extraction.attempts.at(-1);
              return last?.status === 'started' && !busy(userId, sessionId)
                ? failed(sessionId, last.extractionId, {
                    code: 'Interrupted',
                    message: 'The server restarted during the extraction.',
                    retryable: true,
                  })
                : [];
            }),
          ).pipe(Effect.result),
        );
        if (Result.isFailure(result)) {
          deps.log({ event: 'knowledge.recover.failed', fields: {} });
        }
      }
    },

    idle: (userId) =>
      queues.has(userId)
        ? new Promise<void>((resolve) => queueOf(userId).idle.push(resolve))
        : Promise.resolve(),

    stopAll: async () => {
      const fibers = [...queues.values()].flatMap((queue) => {
        queue.waiting.length = 0;
        return queue.running?.fiber === undefined ? [] : [queue.running.fiber];
      });
      await Effect.runPromise(Fiber.interruptAll(fibers));
      for (const queue of queues.values()) queue.idle.splice(0).forEach((resolve) => resolve());
      queues.clear();
    },
  };
};
