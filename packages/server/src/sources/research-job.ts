// Web research of accounts (plan nguon-hoc.md A5): `POST /api/account/research` stores a `web`
// source `pending` and a durable job `research` runs the pipeline: closing the tab does not stop
// it, a restart runs it again. The payload has no key: the model (role `researcher`) and the search
// source are resolved when the job runs, so a source the admin turned off meanwhile fails cleanly.
// With a `sessionId`, the ready source is attached to that lesson; while a turn of that lesson
// runs, attaching waits for it (the lesson refuses changes mid-turn).
import { Cause, Duration, Effect, Layer, Schedule } from 'effect';
import { runResearch, researchTitle } from '@kd-learn/agent';
import type { AiPort } from '@kd-learn/ai/port';
import {
  CreateResearchRequest,
  ErrorCode,
  parseWebOrigin,
  webOrigin,
  type WebOrigin,
} from '@kd-learn/api';
import { SourceFailureCode, type SourceInfo } from '@kd-learn/core';
import { SearchPort } from '@kd-learn/search/port';
import type { StorageService } from '@kd-learn/storage/port';
import type { ServerStorage } from '@kd-learn/storage/sqlite-node';
import { Schema } from 'effect';
import type { Logger } from '../handler.ts';
import type { JobKind, JobRunner } from '../jobs/runner.ts';
import { activeProfile } from '../profile.ts';
import { redact } from '../safety.ts';
import type { SearchConfigService } from '../search/config.ts';
import type { SettingsService } from '../settings/service.ts';
import type { SourceResult } from './service.ts';

/** Upper bound on one research (two model calls, Q searches and page fetches). */
const RESEARCH_TIMEOUT_MS = 5 * 60_000;

const ResearchPayload = Schema.Struct({
  sourceId: Schema.NonEmptyString,
  sessionId: Schema.optionalKey(Schema.String),
});
type ResearchPayload = typeof ResearchPayload.Type;

/** What attaching a ready source to a lesson answered. */
export type AttachOutcome = 'attached' | 'busy' | 'gone';

export interface ResearchJobs {
  readonly create: (userId: string, input: CreateResearchRequest) => SourceResult<SourceInfo>;
  /** Runs a failed or interrupted `web` source again from its origin. */
  readonly retry: (userId: string, info: SourceInfo) => SourceResult<SourceInfo>;
}

export interface ResearchJobDeps {
  readonly storage: ServerStorage;
  readonly settings: SettingsService;
  readonly ai: Layer.Layer<AiPort>;
  readonly jobs: JobRunner;
  readonly search: SearchConfigService;
  readonly log: Logger;
  /** Attaches a source to a lesson. Late-bound: the session runner is made after the jobs. */
  readonly attach: (userId: string, sessionId: string, sourceId: string) => AttachOutcome;
  readonly newId?: () => string;
  readonly now?: () => number;
  readonly timeoutMs?: number;
  /** Pause between tries while the lesson runs a turn. */
  readonly attachRetryMs?: number;
}

const sync = <A, E>(effect: Effect.Effect<A, E>) => Effect.runSync(effect);

export const makeResearchJobs = (deps: ResearchJobDeps): ResearchJobs => {
  const { storage, jobs, log } = deps;
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const now = deps.now ?? Date.now;

  const failIfPending = (user: StorageService, sourceId: string, code: string, message: string) =>
    user.failSource(sourceId, { code, message: message.slice(0, 500) }).pipe(
      Effect.catchTag('SourceConflict', () => Effect.void),
      Effect.ignore,
    );

  /** Tries to attach until the lesson is free (a turn takes a few minutes at most). */
  const attachWhenFree = (userId: string, sessionId: string, sourceId: string) =>
    Effect.sync(() => deps.attach(userId, sessionId, sourceId)).pipe(
      Effect.flatMap((outcome) =>
        outcome === 'busy' ? Effect.fail('busy' as const) : Effect.void,
      ),
      Effect.retry({
        schedule: Schedule.spaced(Duration.millis(deps.attachRetryMs ?? 2000)),
        times: 300,
      }),
      Effect.catch(() => Effect.sync(() => log({ event: 'research.attach_gave_up', fields: {} }))),
    );

  const run = (userId: string, { sourceId, sessionId }: ResearchPayload): Effect.Effect<void> => {
    const user = storage.forUser(userId);
    return Effect.gen(function* () {
      const info = yield* user.getSource(sourceId);
      if (info === undefined || info.state !== 'pending' || info.kind !== 'web') return;
      const origin = parseWebOrigin(info.origin);
      if (origin === undefined) {
        return yield* failIfPending(
          user,
          sourceId,
          SourceFailureCode.Invalid,
          'The question is lost.',
        );
      }
      const service = deps.search.service('account', origin.provider);
      if (service === undefined) {
        return yield* failIfPending(
          user,
          sourceId,
          ErrorCode.SearchUnavailable,
          'This search source is turned off on this server.',
        );
      }
      const resolved = deps.settings.resolveModel(userId, 'researcher');
      if (resolved._tag !== 'Ok') {
        return yield* failIfPending(
          user,
          sourceId,
          ErrorCode.RoleNotConfigured,
          'No model is set for research.',
        );
      }
      const model = resolved.model;
      const key = model.provider === 'acp' ? undefined : model.apiKey;
      const { profile } = yield* activeProfile(user);
      const outcome = yield* runResearch({
        question: origin.question,
        language: origin.language,
        profile,
        model,
      }).pipe(
        Effect.provide(Layer.merge(deps.ai, Layer.succeed(SearchPort, service))),
        Effect.timeoutOrElse({
          duration: Duration.millis(deps.timeoutMs ?? RESEARCH_TIMEOUT_MS),
          orElse: () => Effect.succeed({ _tag: 'Timeout' as const }),
        }),
        Effect.result,
      );
      if (outcome._tag === 'Failure') {
        const { failure } = outcome.failure;
        log({
          event: 'research.failed',
          fields: { code: failure.code, step: outcome.failure.step },
        });
        return yield* failIfPending(user, sourceId, failure.code, redact(failure.message, key));
      }
      if ('_tag' in outcome.success) {
        log({ event: 'research.failed', fields: { code: SourceFailureCode.Timeout } });
        return yield* failIfPending(
          user,
          sourceId,
          SourceFailureCode.Timeout,
          'The research took too long.',
        );
      }
      const result = outcome.success;
      const written = yield* user.completeSource(sourceId, result.chunks).pipe(
        Effect.as(true),
        Effect.catchTag('SourceConflict', () => Effect.succeed(false)),
      );
      log({
        event: 'research.done',
        fields: {
          chunks: result.chunks.length,
          calls: result.usage.calls,
          searches: result.usage.searches,
        },
      });
      if (written && sessionId !== undefined) yield* attachWhenFree(userId, sessionId, sourceId);
    }).pipe(
      // A storage error ends the job as failed; an interruption (process stop) propagates, so the
      // runner keeps the row and runs it again after the restart.
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : failIfPending(user, sourceId, SourceFailureCode.Failed, 'The research failed.').pipe(
              Effect.tap(() => Effect.sync(() => log({ event: 'research.error', fields: {} }))),
            ),
      ),
    ) as Effect.Effect<void>;
  };

  const kind: JobKind<ResearchPayload> = {
    kind: 'research',
    payload: ResearchPayload as never,
    run,
    abandon: (userId, { sourceId }) =>
      Effect.runSync(
        failIfPending(
          storage.forUser(userId),
          sourceId,
          SourceFailureCode.Interrupted,
          'The research was interrupted too often. Try again.',
        ),
      ),
  };
  jobs.register(kind);

  return {
    create: (userId, input) => {
      const user = storage.forUser(userId);
      if (input.sessionId !== undefined && sync(user.readSession(input.sessionId)).length === 0) {
        return { _tag: 'NotFound' };
      }
      const origin: WebOrigin = {
        question: input.question,
        language: input.language,
        provider: input.provider,
      };
      if (deps.search.service('account', input.provider) === undefined) {
        return { _tag: 'Conflict', message: 'This search source is not available here.' };
      }
      const sourceId = newId();
      sync(
        user.createSource({
          state: 'pending',
          info: {
            sourceId,
            kind: 'web',
            title: researchTitle(input.question),
            origin: webOrigin(origin),
            createdAt: now(),
          },
        }),
      );
      jobs.enqueue(userId, kind, sourceId, {
        sourceId,
        ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      });
      return { _tag: 'Ok', value: sync(user.getSource(sourceId))! };
    },
    retry: (userId, info) => {
      const user = storage.forUser(userId);
      if (jobs.state(userId, kind.kind, info.sourceId) !== undefined) {
        return { _tag: 'Conflict', message: 'This research is running.' };
      }
      const exit = Effect.runSyncExit(user.retrySource(info.sourceId));
      if (exit._tag === 'Failure') {
        return { _tag: 'Conflict', message: 'This source cannot run again.' };
      }
      jobs.enqueue(userId, kind, info.sourceId, { sourceId: info.sourceId });
      return { _tag: 'Ok', value: sync(user.getSource(info.sourceId))! };
    },
  };
};
