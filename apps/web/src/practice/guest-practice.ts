// Practice in guest and demo mode (plan luyen-tap-graph.md A7, A8). The local knowledge log holds
// the practice; the server only writes exercises (`POST /api/practice/issue`) and grades the
// model-graded answers (`POST /api/practice/grade`), keeping no state. Code-graded types are graded
// here. Plain TypeScript, no React.
//
// Every read-build-append runs under the knowledge lock shared with the extractor, as a checked
// append built from the graph at write time. Model calls run outside the lock: an answer is
// written first, then graded, so a failed or interrupted grade leaves "answered, not graded",
// which `grade` retries.
import { Effect, Result } from 'effect';
import { defaultProfile, resolveProfile } from '@kd-learn/agent/client';
import {
  accountClient,
  ApiError,
  MAX_PRACTICE_EXERCISES,
  type ExerciseTargetInput,
  type KnowledgeSlice,
  type ModelChoice,
} from '@kd-learn/api';
import {
  gradeByCode,
  projectKnowledge,
  selectExercises,
  type ExerciseAnswer,
  type ExerciseTarget,
  type ExerciseTypeId,
  type KnowledgeEvent,
  type KnowledgeGraph,
  type Practice,
  type TeachingProfile,
} from '@kd-learn/core';
import { appendKnowledgeChecked, type StorageService } from '@kd-learn/storage/port';
import { KNOWLEDGE_LOCK, queuedLock, type QueuedLock } from '../knowledge/guest-extractor';
import { modelChoiceOf } from '../learn/model';

/** Exercises of one practice. */
export const PRACTICE_SIZE = 5;
const MAX_SLICE_PROPOSITIONS = 200;
const MAX_SLICE_EDGES = 400;

export interface GuestPracticeDeps {
  readonly storage: () => Promise<StorageService>;
  readonly demo?: () => boolean;
  /** The learner's language: exercises and feedback are written in it. */
  readonly language: () => string;
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
  readonly lock?: QueuedLock;
  readonly newId?: () => string;
  readonly now?: () => number;
}

/** Why an action did nothing: no model yet, nothing to practice, or a failure with its message. */
export class PracticeFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const graphOf = (log: Parameters<typeof projectKnowledge>[0]): KnowledgeGraph => {
  const projected = projectKnowledge(log);
  if (Result.isFailure(projected)) throw new Error('The knowledge log does not project.');
  return projected.success;
};

/** The open practice the screen resumes: the latest one started. */
export const openPractice = (graph: KnowledgeGraph): Practice | undefined =>
  Object.values(graph.practices)
    .filter((p) => p.endedAt === undefined)
    .sort((a, b) => b.startedAt - a.startedAt)[0];

/**
 * The part of the graph the targets need (A8): their propositions, the neighbours of each (for
 * distractors) and the edges between all of them, within the request's caps.
 */
export const sliceFor = (
  graph: KnowledgeGraph,
  targets: ReadonlyArray<ExerciseTarget>,
): KnowledgeSlice => {
  const ids = new Set<string>();
  for (const target of targets) target.propositionIds.forEach((id) => ids.add(id));
  const edges = Object.values(graph.edges);
  for (const target of targets) {
    for (const edge of edges) {
      if (ids.size >= MAX_SLICE_PROPOSITIONS) break;
      if (target.propositionIds.includes(edge.from)) ids.add(edge.to);
      if (target.propositionIds.includes(edge.to)) ids.add(edge.from);
    }
  }
  const kept = [...ids].slice(0, MAX_SLICE_PROPOSITIONS);
  const inside = new Set(kept);
  return {
    propositions: kept.flatMap((propositionId) => {
      const p = graph.propositions[propositionId];
      return p === undefined ? [] : [{ propositionId, text: p.text }];
    }),
    edges: edges
      .filter((e) => inside.has(e.from) && inside.has(e.to))
      .slice(0, MAX_SLICE_EDGES)
      .map(({ edgeId, from, to, relation, label }) => ({ edgeId, from, to, relation, label })),
  };
};

const failureOf = (error: unknown): PracticeFailure =>
  error instanceof PracticeFailure
    ? error
    : error instanceof ApiError
      ? new PracticeFailure(error.failure.code, error.failure.message)
      : new PracticeFailure('Storage', error instanceof Error ? error.message : String(error));

export const makeGuestPractice = (deps: GuestPracticeDeps) => {
  const lock = deps.lock ?? queuedLock;
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const now = deps.now ?? (() => Date.now());
  const api = accountClient({
    ...(deps.baseUrl === undefined || deps.baseUrl === '' ? {} : { baseUrl: deps.baseUrl }),
    ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
  });

  /** The model and profile a request carries. Demo sends the default profile in its language. */
  const requestBase = async (
    storage: StorageService,
  ): Promise<{ readonly model: ModelChoice; readonly profile: TeachingProfile }> => {
    const demo = deps.demo?.() === true;
    const model: ModelChoice | undefined = demo
      ? { provider: 'demo' }
      : modelChoiceOf(await Effect.runPromise(storage.getSettings));
    if (model === undefined) throw new PracticeFailure('NoKey', 'Add your API key first.');
    const saved = demo ? undefined : await Effect.runPromise(storage.getProfile);
    const profile = saved === undefined ? defaultProfile : resolveProfile(saved);
    return { model, profile: { ...profile, language: deps.language() } };
  };

  const append = (
    storage: StorageService,
    build: (graph: KnowledgeGraph) => ReadonlyArray<KnowledgeEvent>,
  ) =>
    lock(KNOWLEDGE_LOCK, () =>
      Effect.runPromise(appendKnowledgeChecked(storage, build)).then((r) => r.graph),
    );

  const exerciseOf = (graph: KnowledgeGraph, exerciseId: string) => {
    const exercise = graph.exercises[exerciseId];
    if (exercise === undefined) throw new PracticeFailure('NotFound', 'No such exercise.');
    return exercise;
  };

  /** Grades a stored answer by model and writes the grade (the first grade wins). */
  const gradeByModel = async (storage: StorageService, exerciseId: string) => {
    const exercise = exerciseOf(
      graphOf(await Effect.runPromise(storage.readKnowledge)),
      exerciseId,
    );
    if (exercise.grade !== undefined || exercise.answer === undefined) return;
    const base = await requestBase(storage);
    const { events } = await Effect.runPromise(
      api.gradeAnswer({ ...base, exerciseId, content: exercise.content, answer: exercise.answer }),
    );
    await append(storage, (graph) =>
      graph.exercises[exerciseId]?.grade === undefined ? events : [],
    );
  };

  const guarded = async <A>(run: () => Promise<A>): Promise<A> => {
    try {
      return await run();
    } catch (error) {
      throw failureOf(error);
    }
  };

  return {
    /**
     * Starts a practice of the graph's most due propositions, in the types the screen renders.
     * Resolves with its id; an open practice is resumed instead of starting a second one.
     */
    start: (types: ReadonlyArray<ExerciseTypeId>): Promise<string> =>
      guarded(async () => {
        const storage = await deps.storage();
        const graph = graphOf(await Effect.runPromise(storage.readKnowledge));
        const open = openPractice(graph);
        if (open !== undefined) return open.practiceId;
        const targets = selectExercises(graph, {
          now: now(),
          count: Math.min(PRACTICE_SIZE, MAX_PRACTICE_EXERCISES),
          types,
        });
        if (targets.length === 0) {
          throw new PracticeFailure('NothingToRun', 'There is nothing to practice yet.');
        }
        const base = await requestBase(storage);
        const { events } = await Effect.runPromise(
          api.issueExercises({
            ...base,
            slice: sliceFor(graph, targets),
            targets: targets as ReadonlyArray<ExerciseTargetInput>,
          }),
        );
        const started = events.find((e) => e._tag === 'PracticeStarted');
        if (started === undefined || started._tag !== 'PracticeStarted') {
          throw new PracticeFailure('Protocol', 'The server returned no practice.');
        }
        // A rejected batch (a proposition retired meanwhile) fails the start; the next one picks
        // from the graph as it is then.
        await append(storage, () => events);
        return started.practiceId;
      }),

    /** Writes the answer, then grades it: by code in the same batch, by model after. */
    answer: (exerciseId: string, answer: ExerciseAnswer): Promise<void> =>
      guarded(async () => {
        const storage = await deps.storage();
        let byModel = false;
        await append(storage, (graph) => {
          const exercise = exerciseOf(graph, exerciseId);
          const submitted: KnowledgeEvent = {
            _tag: 'AnswerSubmitted',
            id: newId(),
            at: now(),
            exerciseId,
            answer,
          };
          const grade = gradeByCode(exercise.content, answer);
          if (grade === undefined) {
            byModel = true;
            return [submitted];
          }
          return [
            submitted,
            { _tag: 'ExerciseGraded', id: newId(), at: now(), exerciseId, ...grade },
          ];
        });
        if (byModel) await gradeByModel(storage, exerciseId);
      }),

    /** Grades the stored answer again, after a failed or interrupted grade. */
    grade: (exerciseId: string): Promise<void> =>
      guarded(async () => gradeByModel(await deps.storage(), exerciseId)),

    /** Ends the practice; exercises not answered stay unanswered. */
    end: (practiceId: string): Promise<void> =>
      guarded(async () => {
        const storage = await deps.storage();
        await append(storage, (graph) =>
          graph.practices[practiceId]?.endedAt === undefined
            ? [{ _tag: 'PracticeEnded', id: newId(), at: now(), practiceId }]
            : [],
        );
      }),
  };
};

export type GuestPractice = ReturnType<typeof makeGuestPractice>;
