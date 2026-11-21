// Projection of the knowledge log (plan luyen-tap-graph.md A1, A3, A7): the graph, the extraction
// status of each session, the practices and the mastery of each proposition. Pure and strict like `projectSession`: a log that breaks a rule gives a
// `ProjectionError`, never a half-built graph. Writers project log + batch before appending, and
// drop a batch that does not project.
import { Result } from 'effect';
import type {
  EdgeId,
  KnowledgeEvent,
  PropositionId,
  PropositionSource,
  Relation,
} from './knowledge-event.ts';
import {
  checkAnswer,
  checkContent,
  mergeMastery,
  nextMastery,
  type Exercise,
  type Mastery,
  type Practice,
} from './practice.ts';
import { ProjectionError } from './session.ts';

export interface Proposition {
  readonly propositionId: PropositionId;
  readonly text: string;
  readonly topic: string;
  /** Sessions (and steps) that taught it, oldest first, without repeats. */
  readonly sources: ReadonlyArray<PropositionSource>;
  readonly addedAt: number;
  /** `at` of the last event that changed it (wording, source, merge). */
  readonly updatedAt: number;
}

export interface Edge {
  readonly edgeId: EdgeId;
  readonly from: PropositionId;
  readonly to: PropositionId;
  readonly relation: Relation;
  readonly label: string;
}

/** What became of a proposition that is no longer active. */
export type InactiveProposition =
  { readonly _tag: 'Retired' } | { readonly _tag: 'Merged'; readonly into: PropositionId };

export type ExtractionStatus = 'started' | 'extracted' | 'failed';

export interface ExtractionAttempt {
  readonly extractionId: string;
  readonly status: ExtractionStatus;
  readonly startedAt: number;
  /** Present when `status` is `failed`. */
  readonly failure?: {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
  };
}

export interface SessionExtraction {
  /** Every attempt, oldest first. */
  readonly attempts: ReadonlyArray<ExtractionAttempt>;
  /** The attempt whose `SessionExtracted` was written. At most one per session. */
  readonly extractedBy: string | undefined;
}

export interface KnowledgeGraph {
  /** Active propositions by id. */
  readonly propositions: Readonly<Record<PropositionId, Proposition>>;
  /** Active edges by id. Both ends of an active edge are active propositions. */
  readonly edges: Readonly<Record<EdgeId, Edge>>;
  /** Propositions that were retired or merged away, so an old id can still be explained. */
  readonly inactive: Readonly<Record<PropositionId, InactiveProposition>>;
  /** Extraction attempts by session id. */
  readonly extractions: Readonly<Record<string, SessionExtraction>>;
  /** Practices by id (A7). */
  readonly practices: Readonly<Record<string, Practice>>;
  /** Exercises of every practice by id. */
  readonly exercises: Readonly<Record<string, Exercise>>;
  /**
   * Mastery of the active propositions that were graded at least once. A grade counts for the
   * propositions of its exercise as they are at grading time: through merges to the proposition
   * kept, not at all for a retired one.
   */
  readonly mastery: Readonly<Record<PropositionId, Mastery>>;
}

export const emptyKnowledgeGraph: KnowledgeGraph = {
  propositions: {},
  edges: {},
  inactive: {},
  extractions: {},
  practices: {},
  exercises: {},
  mastery: {},
};

/** True for the relations that must stay acyclic (A1). */
export const isOrderedRelation = (relation: Relation): boolean =>
  relation === 'requires' || relation === 'implies';

/**
 * The ordered relations read in one direction, "before -> after": `A implies B` puts A before B,
 * `A requires B` puts B before A. Undefined for the other relations.
 */
export const precedence = (
  edge: Pick<Edge, 'from' | 'to' | 'relation'>,
): { readonly before: PropositionId; readonly after: PropositionId } | undefined => {
  if (edge.relation === 'implies') return { before: edge.from, after: edge.to };
  if (edge.relation === 'requires') return { before: edge.to, after: edge.from };
  return undefined;
};

/** Two edges with the same key say the same thing. `contrastsWith` has no direction. */
const edgeKey = ({ from, to, relation }: Pick<Edge, 'from' | 'to' | 'relation'>) =>
  relation === 'contrastsWith'
    ? `${relation}|${from < to ? from : to}|${from < to ? to : from}`
    : `${relation}|${from}|${to}`;

const sameSource = (a: PropositionSource, b: PropositionSource) =>
  a.sessionId === b.sessionId && a.stepId === b.stepId;

const addSource = (sources: ReadonlyArray<PropositionSource>, source: PropositionSource) =>
  sources.some((known) => sameSource(known, source)) ? sources : [...sources, source];

/**
 * "before -> after" links of the active ordered edges, kept up to date while projecting so a new
 * edge costs one search, not a rebuild. Counts, because two edges can give the same link
 * (`A implies B` and `B requires A`).
 */
type Precedence = Map<PropositionId, Map<PropositionId, number>>;

const link = (order: Precedence, edge: Edge) => {
  const step = precedence(edge);
  if (step === undefined) return;
  let next = order.get(step.before);
  if (next === undefined) order.set(step.before, (next = new Map()));
  next.set(step.after, (next.get(step.after) ?? 0) + 1);
};

const unlink = (order: Precedence, edge: Edge) => {
  const step = precedence(edge);
  if (step === undefined) return;
  const next = order.get(step.before);
  const count = next?.get(step.after) ?? 0;
  if (count > 1) next!.set(step.after, count - 1);
  else {
    next?.delete(step.after);
    if (next?.size === 0) order.delete(step.before);
  }
};

/** True when `target` can be reached from `start` along "before -> after" links. */
const reaches = (order: Precedence, start: PropositionId, target: PropositionId): boolean => {
  const seen = new Set<PropositionId>([start]);
  const stack = [start];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node === target) return true;
    for (const next of order.get(node)?.keys() ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        stack.push(next);
      }
    }
  }
  return false;
};

/** True when the links contain a cycle (Kahn's algorithm). */
const hasCycle = (order: Precedence): boolean => {
  const indegree = new Map<PropositionId, number>();
  for (const [node, nexts] of order) {
    if (!indegree.has(node)) indegree.set(node, 0);
    for (const next of nexts.keys()) indegree.set(next, (indegree.get(next) ?? 0) + 1);
  }
  const ready = [...indegree].filter(([, n]) => n === 0).map(([node]) => node);
  let visited = 0;
  while (ready.length > 0) {
    const node = ready.pop()!;
    visited += 1;
    for (const next of order.get(node)?.keys() ?? []) {
      const n = indegree.get(next)! - 1;
      indegree.set(next, n);
      if (n === 0) ready.push(next);
    }
  }
  return visited < indegree.size;
};

/** Builds the graph from a knowledge log, oldest event first. An empty log is an empty graph. */
export const projectKnowledge = (
  events: ReadonlyArray<KnowledgeEvent>,
): Result.Result<KnowledgeGraph, ProjectionError> => {
  const propositions = new Map<PropositionId, Proposition>();
  const edges = new Map<EdgeId, Edge>();
  const edgeIdsByKey = new Map<string, EdgeId>();
  const order: Precedence = new Map();
  const inactive = new Map<PropositionId, InactiveProposition>();
  const usedEdgeIds = new Set<EdgeId>();
  const extractions = new Map<
    string,
    { attempts: Array<ExtractionAttempt>; extractedBy: string | undefined }
  >();
  const attemptById = new Map<string, { sessionId: string; index: number }>();
  const practices = new Map<string, Practice>();
  const exercises = new Map<string, Exercise>();
  const mastery = new Map<PropositionId, Mastery>();

  const fail = (index: number, message: string) =>
    Result.fail(new ProjectionError({ index, message }));

  /** Undefined when the proposition is active, otherwise why the event may not refer to it. */
  const notActive = (id: PropositionId): string | undefined => {
    if (propositions.has(id)) return undefined;
    const gone = inactive.get(id);
    if (gone === undefined) return `Unknown proposition "${id}".`;
    return gone._tag === 'Retired'
      ? `Proposition "${id}" was retired.`
      : `Proposition "${id}" was merged into "${gone.into}".`;
  };

  const putEdge = (edge: Edge) => {
    edges.set(edge.edgeId, edge);
    edgeIdsByKey.set(edgeKey(edge), edge.edgeId);
    link(order, edge);
  };

  const removeEdge = (edge: Edge) => {
    edges.delete(edge.edgeId);
    edgeIdsByKey.delete(edgeKey(edge));
    unlink(order, edge);
  };

  /** Ends an open attempt of `sessionId`; a message when there is no such attempt. */
  const endAttempt = (
    sessionId: string,
    extractionId: string,
    end: (attempt: ExtractionAttempt) => ExtractionAttempt,
  ): string | undefined => {
    const found = attemptById.get(extractionId);
    if (found === undefined || found.sessionId !== sessionId) {
      return `Extraction "${extractionId}" of session "${sessionId}" was never started.`;
    }
    const extraction = extractions.get(sessionId)!;
    const attempt = extraction.attempts[found.index]!;
    if (attempt.status !== 'started') return `Extraction "${extractionId}" has already ended.`;
    extraction.attempts[found.index] = end(attempt);
    return undefined;
  };

  for (let index = 0; index < events.length; index++) {
    const event = events[index]!;
    switch (event._tag) {
      case 'PropositionAdded': {
        if (propositions.has(event.propositionId) || inactive.has(event.propositionId)) {
          return fail(index, `Proposition "${event.propositionId}" already exists.`);
        }
        propositions.set(event.propositionId, {
          propositionId: event.propositionId,
          text: event.text,
          topic: event.topic,
          sources: [event.source],
          addedAt: event.at,
          updatedAt: event.at,
        });
        break;
      }

      case 'PropositionSourced': {
        const problem = notActive(event.propositionId);
        if (problem !== undefined) return fail(index, problem);
        const current = propositions.get(event.propositionId)!;
        propositions.set(event.propositionId, {
          ...current,
          sources: addSource(current.sources, event.source),
          updatedAt: event.at,
        });
        break;
      }

      case 'PropositionRevised': {
        const problem = notActive(event.propositionId);
        if (problem !== undefined) return fail(index, problem);
        const current = propositions.get(event.propositionId)!;
        propositions.set(event.propositionId, {
          ...current,
          text: event.text,
          updatedAt: event.at,
        });
        break;
      }

      case 'PropositionsMerged': {
        if (event.from === event.into) {
          return fail(index, `Proposition "${event.from}" cannot be merged into itself.`);
        }
        const problem = notActive(event.from) ?? notActive(event.into);
        if (problem !== undefined) return fail(index, problem);
        const from = propositions.get(event.from)!;
        const into = propositions.get(event.into)!;
        propositions.set(event.into, {
          ...into,
          sources: from.sources.reduce(addSource, into.sources),
          updatedAt: event.at,
        });
        propositions.delete(event.from);
        inactive.set(event.from, { _tag: 'Merged', into: event.into });
        const merged = mergeMastery(mastery.get(event.from), mastery.get(event.into));
        mastery.delete(event.from);
        if (merged !== undefined) mastery.set(event.into, merged);
        // Re-point the edges of `from`. One that becomes a self-loop or repeats an edge of `into`
        // says nothing new and is dropped.
        for (const edge of [...edges.values()]) {
          if (edge.from !== event.from && edge.to !== event.from) continue;
          removeEdge(edge);
          const moved: Edge = {
            ...edge,
            from: edge.from === event.from ? event.into : edge.from,
            to: edge.to === event.from ? event.into : edge.to,
          };
          if (moved.from === moved.to || edgeIdsByKey.has(edgeKey(moved))) continue;
          putEdge(moved);
        }
        if (hasCycle(order)) {
          return fail(
            index,
            `Merging "${event.from}" into "${event.into}" makes a cycle of requires / implies.`,
          );
        }
        break;
      }

      case 'PropositionRetired': {
        const problem = notActive(event.propositionId);
        if (problem !== undefined) return fail(index, problem);
        propositions.delete(event.propositionId);
        inactive.set(event.propositionId, { _tag: 'Retired' });
        mastery.delete(event.propositionId);
        for (const edge of [...edges.values()]) {
          if (edge.from === event.propositionId || edge.to === event.propositionId) {
            removeEdge(edge);
          }
        }
        break;
      }

      case 'EdgeAdded': {
        if (usedEdgeIds.has(event.edgeId)) {
          return fail(index, `Edge "${event.edgeId}" already exists.`);
        }
        const problem = notActive(event.from) ?? notActive(event.to);
        if (problem !== undefined) return fail(index, problem);
        if (event.from === event.to) {
          return fail(index, `Edge "${event.edgeId}" links proposition "${event.from}" to itself.`);
        }
        const edge: Edge = {
          edgeId: event.edgeId,
          from: event.from,
          to: event.to,
          relation: event.relation,
          label: event.label,
        };
        const same = edgeIdsByKey.get(edgeKey(edge));
        if (same !== undefined) {
          return fail(index, `Edge "${event.edgeId}" repeats edge "${same}".`);
        }
        const step = precedence(edge);
        if (step !== undefined && reaches(order, step.after, step.before)) {
          return fail(index, `Edge "${event.edgeId}" makes a cycle of requires / implies.`);
        }
        usedEdgeIds.add(edge.edgeId);
        putEdge(edge);
        break;
      }

      case 'EdgeRemoved': {
        const edge = edges.get(event.edgeId);
        if (edge === undefined) {
          return fail(index, `Edge "${event.edgeId}" is not in the graph.`);
        }
        removeEdge(edge);
        break;
      }

      case 'ExtractionStarted': {
        if (attemptById.has(event.extractionId)) {
          return fail(index, `Extraction "${event.extractionId}" already exists.`);
        }
        let extraction = extractions.get(event.sessionId);
        if (extraction === undefined) {
          extraction = { attempts: [], extractedBy: undefined };
          extractions.set(event.sessionId, extraction);
        }
        if (extraction.extractedBy !== undefined) {
          return fail(index, `Session "${event.sessionId}" is already extracted.`);
        }
        attemptById.set(event.extractionId, {
          sessionId: event.sessionId,
          index: extraction.attempts.length,
        });
        extraction.attempts.push({
          extractionId: event.extractionId,
          status: 'started',
          startedAt: event.at,
        });
        break;
      }

      case 'SessionExtracted': {
        const extraction = extractions.get(event.sessionId);
        if (extraction?.extractedBy !== undefined) {
          return fail(index, `Session "${event.sessionId}" is already extracted.`);
        }
        const problem = endAttempt(event.sessionId, event.extractionId, (attempt) => ({
          ...attempt,
          status: 'extracted',
        }));
        if (problem !== undefined) return fail(index, problem);
        extraction!.extractedBy = event.extractionId;
        break;
      }

      case 'ExtractionFailed': {
        const problem = endAttempt(event.sessionId, event.extractionId, (attempt) => ({
          ...attempt,
          status: 'failed',
          failure: { code: event.code, message: event.message, retryable: event.retryable },
        }));
        if (problem !== undefined) return fail(index, problem);
        break;
      }

      case 'PracticeStarted': {
        if (practices.has(event.practiceId)) {
          return fail(index, `Practice "${event.practiceId}" already exists.`);
        }
        practices.set(event.practiceId, {
          practiceId: event.practiceId,
          startedAt: event.at,
          exerciseIds: [],
        });
        break;
      }

      case 'ExerciseIssued': {
        const practice = practices.get(event.practiceId);
        if (practice === undefined) {
          return fail(index, `Practice "${event.practiceId}" was never started.`);
        }
        if (practice.endedAt !== undefined) {
          return fail(index, `Practice "${event.practiceId}" has ended.`);
        }
        if (exercises.has(event.exerciseId)) {
          return fail(index, `Exercise "${event.exerciseId}" already exists.`);
        }
        const problem =
          event.propositionIds.map(notActive).find((p) => p !== undefined) ??
          event.edgeIds
            .map((id) => (edges.has(id) ? undefined : `Edge "${id}" is not in the graph.`))
            .find((p) => p !== undefined) ??
          checkContent(event.type, event.propositionIds, event.content);
        if (problem !== undefined) return fail(index, problem);
        exercises.set(event.exerciseId, {
          exerciseId: event.exerciseId,
          practiceId: event.practiceId,
          type: event.type,
          propositionIds: event.propositionIds,
          edgeIds: event.edgeIds,
          content: event.content,
          issuedAt: event.at,
        });
        practices.set(event.practiceId, {
          ...practice,
          exerciseIds: [...practice.exerciseIds, event.exerciseId],
        });
        break;
      }

      case 'AnswerSubmitted': {
        const exercise = exercises.get(event.exerciseId);
        if (exercise === undefined) {
          return fail(index, `Exercise "${event.exerciseId}" was never issued.`);
        }
        if (practices.get(exercise.practiceId)!.endedAt !== undefined) {
          return fail(index, `Practice "${exercise.practiceId}" has ended.`);
        }
        if (exercise.answer !== undefined) {
          return fail(index, `Exercise "${event.exerciseId}" is already answered.`);
        }
        const problem = checkAnswer(exercise, event.answer);
        if (problem !== undefined) return fail(index, problem);
        exercises.set(event.exerciseId, {
          ...exercise,
          answer: event.answer,
          answeredAt: event.at,
        });
        break;
      }

      case 'ExerciseGraded': {
        const exercise = exercises.get(event.exerciseId);
        if (exercise === undefined) {
          return fail(index, `Exercise "${event.exerciseId}" was never issued.`);
        }
        if (exercise.answer === undefined) {
          return fail(index, `Exercise "${event.exerciseId}" has no answer to grade.`);
        }
        if (exercise.grade !== undefined) {
          return fail(index, `Exercise "${event.exerciseId}" is already graded.`);
        }
        exercises.set(event.exerciseId, {
          ...exercise,
          grade: {
            score: event.score,
            feedback: event.feedback,
            ...(event.profileId === undefined ? {} : { profileId: event.profileId }),
            gradedAt: event.at,
          },
        });
        // The grade counts for each proposition as it is now (one record even if two of them
        // were merged into one since the exercise was issued).
        const current = new Set<PropositionId>();
        for (const id of exercise.propositionIds) {
          let now: PropositionId | undefined = id;
          while (now !== undefined && !propositions.has(now)) {
            const gone = inactive.get(now);
            now = gone?._tag === 'Merged' ? gone.into : undefined;
          }
          if (now !== undefined) current.add(now);
        }
        for (const id of current)
          mastery.set(id, nextMastery(mastery.get(id), event.score, event.at));
        break;
      }

      case 'PracticeEnded': {
        const practice = practices.get(event.practiceId);
        if (practice === undefined) {
          return fail(index, `Practice "${event.practiceId}" was never started.`);
        }
        if (practice.endedAt !== undefined) {
          return fail(index, `Practice "${event.practiceId}" has already ended.`);
        }
        practices.set(event.practiceId, { ...practice, endedAt: event.at });
        break;
      }
    }
  }

  return Result.succeed({
    propositions: Object.fromEntries(propositions),
    edges: Object.fromEntries(edges),
    inactive: Object.fromEntries(inactive),
    extractions: Object.fromEntries(extractions),
    practices: Object.fromEntries(practices),
    exercises: Object.fromEntries(exercises),
    mastery: Object.fromEntries(mastery),
  });
};

/**
 * Extraction status of one session for the UI and the runners (A3):
 * - `none`: never attempted;
 * - `running`: the last attempt has started and not ended (or was interrupted: only the writer
 *   knows whether it still runs);
 * - `failed`: the last attempt failed;
 * - `extracted`: done, no further attempt is allowed.
 */
export const extractionStatus = (
  graph: KnowledgeGraph,
  sessionId: string,
): 'none' | 'running' | 'failed' | 'extracted' => {
  const extraction = graph.extractions[sessionId];
  if (extraction === undefined || extraction.attempts.length === 0) return 'none';
  if (extraction.extractedBy !== undefined) return 'extracted';
  const last = extraction.attempts[extraction.attempts.length - 1]!;
  return last.status === 'failed' ? 'failed' : 'running';
};

/**
 * A completed session is extracted automatically only when it has never been attempted (A3): after
 * a failure or an interruption only the retry button runs it, so each session runs by itself once.
 */
export const shouldAutoExtract = (graph: KnowledgeGraph, sessionId: string): boolean =>
  extractionStatus(graph, sessionId) === 'none';

/** The active proposition an id stands for now, following merges. Undefined when retired. */
export const resolveProposition = (
  graph: KnowledgeGraph,
  id: PropositionId,
): Proposition | undefined => {
  const seen = new Set<PropositionId>();
  let current = id;
  while (!seen.has(current)) {
    const active = graph.propositions[current];
    if (active !== undefined) return active;
    const gone = graph.inactive[current];
    if (gone === undefined || gone._tag === 'Retired') return undefined;
    seen.add(current);
    current = gone.into;
  }
  return undefined;
};
