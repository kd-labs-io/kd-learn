// Account practice (plan luyen-tap-graph.md A7): the server writes the learner's knowledge log,
// only through `forUser(userId)`, so one user never reads or writes another's practice. Model
// calls run detached from the request: closing the connection does not cancel them, and what they
// produce is in the log for the next read. Every write is a checked append (A3) built again from
// the graph at write time, so a change that slipped in (a proposition retired, a second grade)
// can never break the log.
import { Cause, Effect, Exit, Result } from 'effect';
import type { Layer } from 'effect';
import { failureOf, gradeExercise, writeExercises } from '@kd-learn/agent';
import type { AiError, AiPort } from '@kd-learn/ai/port';
import {
  exerciseView,
  practiceList,
  practiceView,
  type ExerciseView,
  type PracticeList,
  type PracticeView,
} from '@kd-learn/api';
import {
  gradeByCode,
  projectKnowledge,
  selectExercises,
  type ExerciseAnswer,
  type ExerciseTypeId,
  type KnowledgeEvent,
  type KnowledgeGraph,
} from '@kd-learn/core';
import { appendKnowledgeChecked } from '@kd-learn/storage/port';
import type { StorageService } from '@kd-learn/storage/port';
import type { ServerStorage } from '@kd-learn/storage/sqlite-node';
import type { Logger } from '../handler.ts';
import { activeProfile } from '../profile.ts';
import type { ResolveResult, SettingsService } from '../settings/service.ts';

export interface ModelFailure {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export type PracticeResult<A> =
  | { readonly _tag: 'Ok'; readonly value: A }
  /** Unknown id, or one of another user (same answer, risk 26). */
  | { readonly _tag: 'NotFound' }
  /** Nothing to practice (empty graph), or every exercise became stale while it was written. */
  | { readonly _tag: 'NothingToPractice' }
  /** A start of this user is already running. */
  | { readonly _tag: 'InProgress' }
  /** The practice has ended, or the exercise is already answered. */
  | { readonly _tag: 'Closed'; readonly message: string }
  /** The answer does not fit the exercise (wrong type, an option that does not exist). */
  | { readonly _tag: 'InvalidAnswer'; readonly message: string }
  | { readonly _tag: 'ModelUnavailable'; readonly result: Exclude<ResolveResult, { _tag: 'Ok' }> }
  | { readonly _tag: 'ModelFailed'; readonly failure: ModelFailure }
  | { readonly _tag: 'Timeout' };

export interface PracticeService {
  /** The open practices, oldest first. */
  readonly list: (userId: string) => Promise<PracticeList>;
  readonly get: (userId: string, practiceId: string) => Promise<PracticeView | undefined>;
  readonly start: (
    userId: string,
    options: { readonly count?: number; readonly types?: ReadonlyArray<ExerciseTypeId> },
  ) => Promise<PracticeResult<PracticeView>>;
  /** Writes the answer, then grades it. */
  readonly answer: (
    userId: string,
    exerciseId: string,
    answer: ExerciseAnswer,
  ) => Promise<PracticeResult<ExerciseView>>;
  /** Grades the stored answer, unless it is graded already. */
  readonly grade: (userId: string, exerciseId: string) => Promise<PracticeResult<ExerciseView>>;
  /** Ends an open practice; an ended one is returned as it is. */
  readonly end: (userId: string, practiceId: string) => Promise<PracticeResult<PracticeView>>;
}

/** Upper bound on one model call of practice. Default 3 minutes. */
const DEFAULT_TIMEOUT_MS = 3 * 60 * 1000;

const readGraph = (storage: StorageService) =>
  storage.readKnowledge.pipe(
    Effect.map((log) => {
      const projected = projectKnowledge(log);
      if (Result.isFailure(projected)) {
        throw new Error(`Stored knowledge log does not project: ${projected.failure.message}`);
      }
      return projected.success;
    }),
  );

export const makePracticeService = (deps: {
  readonly storage: ServerStorage;
  readonly settings: SettingsService;
  readonly ai: Layer.Layer<AiPort>;
  readonly log: Logger;
  readonly timeoutMs?: number;
  readonly now?: () => number;
  readonly newId?: () => string;
}): PracticeService => {
  const now = deps.now ?? Date.now;
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  /** Users with a start running: a double click must not pay for two practices. */
  const starting = new Set<string>();

  const graphOf = (userId: string) => Effect.runPromise(readGraph(deps.storage.forUser(userId)));

  /** Runs a model call to the end, whatever happens to the request; maps its failure. */
  const callModel = async <A>(
    program: Effect.Effect<A, AiError, AiPort>,
    model: Parameters<typeof failureOf>[1],
    event: string,
  ): Promise<{ readonly _tag: 'Ok'; readonly value: A } | PracticeResult<never>> => {
    const exit = await Effect.runPromiseExit(
      program.pipe(Effect.provide(deps.ai), Effect.timeoutOption(timeoutMs)),
    );
    if (Exit.isSuccess(exit)) {
      if (exit.value._tag === 'None') {
        deps.log({ event, fields: { outcome: 'timeout' } });
        return { _tag: 'Timeout' };
      }
      return { _tag: 'Ok', value: exit.value.value };
    }
    const error = Cause.findErrorOption(exit.cause);
    if (error._tag === 'Some') {
      const failure = failureOf(error.value, model);
      deps.log({ event, fields: { outcome: 'failed', code: failure.code } });
      return { _tag: 'ModelFailed', failure };
    }
    throw Cause.squash(exit.cause);
  };

  /** A checked append; a rejected batch becomes `InvalidAnswer` with the projection's reason. */
  const append = async (
    storage: StorageService,
    build: (graph: KnowledgeGraph) => ReadonlyArray<KnowledgeEvent>,
  ): Promise<{ readonly graph: KnowledgeGraph } | { readonly rejected: string }> => {
    const exit = await Effect.runPromiseExit(appendKnowledgeChecked(storage, build));
    if (Exit.isSuccess(exit)) return { graph: exit.value.graph };
    const error = Cause.findErrorOption(exit.cause);
    if (error._tag === 'Some' && error.value._tag === 'KnowledgeRejected') {
      return { rejected: error.value.message };
    }
    throw Cause.squash(exit.cause);
  };

  const gradeStored = async (
    userId: string,
    exerciseId: string,
  ): Promise<PracticeResult<ExerciseView>> => {
    const storage = deps.storage.forUser(userId);
    const graph = await Effect.runPromise(readGraph(storage));
    const exercise = graph.exercises[exerciseId];
    if (exercise === undefined) return { _tag: 'NotFound' };
    if (exercise.grade !== undefined) return { _tag: 'Ok', value: exerciseView(graph, exercise) };
    const answer = exercise.answer;
    if (answer === undefined)
      return { _tag: 'Closed', message: 'This exercise has no answer yet.' };

    // Graded from the stored content only, never from what the client sends.
    let grade: { readonly score: number; readonly feedback: string; readonly profileId?: string };
    const byCode = gradeByCode(exercise.content, answer);
    if (byCode !== undefined) grade = byCode;
    else {
      const resolved = deps.settings.resolveModel(userId, 'practitioner');
      if (resolved._tag !== 'Ok') return { _tag: 'ModelUnavailable', result: resolved };
      const { profile } = await Effect.runPromise(activeProfile(storage));
      const called = await callModel(
        gradeExercise({ content: exercise.content, answer, profile, model: resolved.model }),
        resolved.model,
        'practice.grade',
      );
      if (called._tag !== 'Ok') return called;
      grade = { score: called.value.score, feedback: called.value.feedback, profileId: profile.id };
    }
    const written = await append(storage, (current) =>
      // Graded meanwhile (two grade requests at once): keep the first grade.
      current.exercises[exerciseId]?.grade !== undefined
        ? []
        : [{ _tag: 'ExerciseGraded', id: newId(), at: now(), exerciseId, ...grade }],
    );
    if ('rejected' in written) return { _tag: 'InvalidAnswer', message: written.rejected };
    return { _tag: 'Ok', value: exerciseView(written.graph, written.graph.exercises[exerciseId]!) };
  };

  return {
    list: async (userId) => practiceList(await graphOf(userId)),

    get: async (userId, practiceId) => practiceView(await graphOf(userId), practiceId),

    start: async (userId, options) => {
      if (starting.has(userId)) return { _tag: 'InProgress' };
      starting.add(userId);
      try {
        const storage = deps.storage.forUser(userId);
        const graph = await Effect.runPromise(readGraph(storage));
        const targets = selectExercises(graph, {
          now: now(),
          ...(options.count === undefined ? {} : { count: options.count }),
          ...(options.types === undefined ? {} : { types: options.types }),
        });
        if (targets.length === 0) return { _tag: 'NothingToPractice' };
        const practiceId = newId();
        // The role is needed even when every exercise is built by code (plan step 3).
        const resolved = deps.settings.resolveModel(userId, 'practitioner');
        if (resolved._tag !== 'Ok') return { _tag: 'ModelUnavailable', result: resolved };
        const { profile } = await Effect.runPromise(activeProfile(storage));
        const called = await callModel(
          writeExercises({ graph, targets, profile, model: resolved.model, seed: practiceId }),
          resolved.model,
          'practice.start',
        );
        if (called._tag !== 'Ok') return called;
        const written = called.value.exercises;

        const appended = await append(storage, (current) => {
          // Drop what went stale while the model wrote (a proposition retired or merged).
          const fresh = written.filter(
            ({ target }) =>
              target.propositionIds.every((id) => current.propositions[id] !== undefined) &&
              target.edgeIds.every((id) => current.edges[id] !== undefined),
          );
          if (fresh.length === 0) return [];
          const at = now();
          return [
            { _tag: 'PracticeStarted', id: newId(), at, practiceId },
            ...fresh.map(({ target, content }): KnowledgeEvent => ({
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
        });
        if ('rejected' in appended) {
          deps.log({ event: 'practice.start', fields: { outcome: 'rejected' } });
          return { _tag: 'NothingToPractice' };
        }
        const view = practiceView(appended.graph, practiceId);
        if (view === undefined) return { _tag: 'NothingToPractice' };
        deps.log({
          event: 'practice.start',
          fields: { outcome: 'completed', exercises: view.exercises.length },
        });
        return { _tag: 'Ok', value: view };
      } finally {
        starting.delete(userId);
      }
    },

    answer: async (userId, exerciseId, answer) => {
      const storage = deps.storage.forUser(userId);
      const graph = await Effect.runPromise(readGraph(storage));
      const exercise = graph.exercises[exerciseId];
      if (exercise === undefined) return { _tag: 'NotFound' };
      if (graph.practices[exercise.practiceId]?.endedAt !== undefined) {
        return { _tag: 'Closed', message: 'This practice has ended.' };
      }
      if (exercise.answer !== undefined) {
        return { _tag: 'Closed', message: 'This exercise is already answered.' };
      }
      // The answer is written before grading: if grading fails or the connection drops, it stays,
      // and `grade` finishes the job.
      const written = await append(storage, () => [
        { _tag: 'AnswerSubmitted', id: newId(), at: now(), exerciseId, answer },
      ]);
      if ('rejected' in written) {
        const current = written.rejected;
        return /already answered|has ended/.test(current)
          ? { _tag: 'Closed', message: current }
          : { _tag: 'InvalidAnswer', message: current };
      }
      return gradeStored(userId, exerciseId);
    },

    grade: gradeStored,

    end: async (userId, practiceId) => {
      const storage = deps.storage.forUser(userId);
      const written = await append(storage, (graph) => {
        const practice = graph.practices[practiceId];
        return practice === undefined || practice.endedAt !== undefined
          ? []
          : [{ _tag: 'PracticeEnded', id: newId(), at: now(), practiceId }];
      });
      if ('rejected' in written) return { _tag: 'NotFound' };
      const view = practiceView(written.graph, practiceId);
      return view === undefined ? { _tag: 'NotFound' } : { _tag: 'Ok', value: view };
    },
  };
};
