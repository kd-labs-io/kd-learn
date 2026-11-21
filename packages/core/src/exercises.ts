// Exercise-type registry and exercise selection (plan luyen-tap-graph.md A6, A7). Pure.
// Each type has its content and answer schemas (`exercise-schema.ts`), a grading mode, and an
// eligibility rule that turns a proposition of the graph into a target (what the exercise tests).
// Code picks the propositions and the type; the Practitioner only writes the content of a target.
import type { Schema } from 'effect';
import {
  ExplainReasoningAnswer,
  ExplainReasoningContent,
  MultipleChoiceAnswer,
  MultipleChoiceContent,
  OrderChainAnswer,
  OrderChainContent,
  ShortAnswerAnswer,
  ShortAnswerContent,
  type ExerciseAnswer,
  type ExerciseContent,
  type ExerciseReference,
  type ExerciseTypeId,
  type OrderConstraint,
} from './exercise-schema.ts';
import { isOrderedRelation, precedence, type Edge, type KnowledgeGraph } from './knowledge.ts';
import type { EdgeId, PropositionId } from './knowledge-ids.ts';

/** What one exercise tests. Becomes `propositionIds` / `edgeIds` of `ExerciseIssued`. */
export interface ExerciseTarget {
  readonly type: ExerciseTypeId;
  readonly propositionIds: readonly [PropositionId, ...Array<PropositionId>];
  readonly edgeIds: ReadonlyArray<EdgeId>;
}

export interface Grade {
  readonly score: number;
  /** Empty for code grading: the screen shows the right answer instead. */
  readonly feedback: string;
}

export interface ExerciseType {
  readonly id: ExerciseTypeId;
  readonly content: Schema.Top;
  readonly answer: Schema.Top;
  /** `deterministic`: graded by `gradeByCode`, no model call. `model`: graded by the Practitioner. */
  readonly grading: 'deterministic' | 'model';
  /** The target this type would test for `propositionId`, or undefined when the type does not fit. */
  readonly target: (
    graph: KnowledgeGraph,
    propositionId: PropositionId,
  ) => ExerciseTarget | undefined;
}

export const minChain = 3;
export const maxChain = 6;

/** The edges of the graph touching `propositionId`, ordered relations first, then by id. */
const edgesOf = (graph: KnowledgeGraph, propositionId: PropositionId): ReadonlyArray<Edge> =>
  Object.values(graph.edges)
    .filter((edge) => edge.from === propositionId || edge.to === propositionId)
    .sort(
      (a, b) =>
        Number(isOrderedRelation(b.relation)) - Number(isOrderedRelation(a.relation)) ||
        (a.edgeId < b.edgeId ? -1 : a.edgeId > b.edgeId ? 1 : 0),
    );

/**
 * The reasoning chain around `propositionId` for an ordering exercise: up to `maxChain`
 * propositions reached through ordered links (either direction, nearest first, ties by id), and
 * every ordered link between them. Undefined when fewer than `minChain` are connected.
 */
export const chainAround = (
  graph: KnowledgeGraph,
  propositionId: PropositionId,
):
  | {
      readonly propositionIds: ReadonlyArray<PropositionId>;
      readonly edgeIds: ReadonlyArray<EdgeId>;
      readonly constraints: ReadonlyArray<OrderConstraint>;
    }
  | undefined => {
  const neighbours = new Map<PropositionId, Set<PropositionId>>();
  const ordered: Array<Edge> = [];
  for (const edge of Object.values(graph.edges)) {
    const step = precedence(edge);
    if (step === undefined) continue;
    ordered.push(edge);
    for (const [a, b] of [
      [step.before, step.after],
      [step.after, step.before],
    ] as const) {
      let set = neighbours.get(a);
      if (set === undefined) neighbours.set(a, (set = new Set()));
      set.add(b);
    }
  }
  const chosen: Array<PropositionId> = [propositionId];
  const seen = new Set(chosen);
  for (let i = 0; i < chosen.length && chosen.length < maxChain; i++) {
    for (const next of [...(neighbours.get(chosen[i]!) ?? [])].sort()) {
      if (chosen.length >= maxChain) break;
      if (!seen.has(next)) {
        seen.add(next);
        chosen.push(next);
      }
    }
  }
  if (chosen.length < minChain) return undefined;
  const inside = ordered.filter((edge) => seen.has(edge.from) && seen.has(edge.to));
  const constraints = new Map<string, OrderConstraint>();
  for (const edge of inside) {
    const step = precedence(edge)!;
    constraints.set(`${step.before}|${step.after}`, step);
  }
  return {
    propositionIds: chosen,
    edgeIds: inside.map((edge) => edge.edgeId).sort(),
    constraints: [...constraints.values()],
  };
};

const single =
  (type: ExerciseTypeId) =>
  (graph: KnowledgeGraph, propositionId: PropositionId): ExerciseTarget | undefined =>
    graph.propositions[propositionId] === undefined
      ? undefined
      : { type, propositionIds: [propositionId], edgeIds: [] };

export const exerciseTypes: Readonly<Record<ExerciseTypeId, ExerciseType>> = {
  multipleChoice: {
    id: 'multipleChoice',
    content: MultipleChoiceContent,
    answer: MultipleChoiceAnswer,
    grading: 'deterministic',
    target: single('multipleChoice'),
  },
  shortAnswer: {
    id: 'shortAnswer',
    content: ShortAnswerContent,
    answer: ShortAnswerAnswer,
    grading: 'model',
    target: single('shortAnswer'),
  },
  explainReasoning: {
    id: 'explainReasoning',
    content: ExplainReasoningContent,
    answer: ExplainReasoningAnswer,
    grading: 'model',
    // One edge of the proposition: explain why the link holds.
    target: (graph, propositionId) => {
      const edge = edgesOf(graph, propositionId)[0];
      return edge === undefined
        ? undefined
        : {
            type: 'explainReasoning',
            propositionIds: [edge.from, edge.to],
            edgeIds: [edge.edgeId],
          };
    },
  },
  orderChain: {
    id: 'orderChain',
    content: OrderChainContent,
    answer: OrderChainAnswer,
    grading: 'deterministic',
    target: (graph, propositionId) => {
      const chain = chainAround(graph, propositionId);
      return chain === undefined
        ? undefined
        : {
            type: 'orderChain',
            propositionIds: chain.propositionIds as ExerciseTarget['propositionIds'],
            edgeIds: chain.edgeIds,
          };
    },
  },
};

export const exerciseTypeIds = Object.keys(exerciseTypes) as ReadonlyArray<ExerciseTypeId>;

/** Share of `constraints` that `order` respects; 1 exactly when it is a valid topological order. */
export const orderScore = (
  constraints: ReadonlyArray<OrderConstraint>,
  order: ReadonlyArray<PropositionId>,
): number => {
  if (constraints.length === 0) return 1;
  const position = new Map(order.map((id, i) => [id, i]));
  const kept = constraints.filter(
    ({ before, after }) => (position.get(before) ?? -1) < (position.get(after) ?? -1),
  ).length;
  return kept / constraints.length;
};

/** Grade of a code-graded type; undefined for a model-graded one. */
export const gradeByCode = (
  content: ExerciseContent,
  answer: ExerciseAnswer,
): Grade | undefined => {
  if (content.type === 'multipleChoice' && answer.type === 'multipleChoice') {
    return { score: answer.choice === content.correctIndex ? 1 : 0, feedback: '' };
  }
  if (content.type === 'orderChain' && answer.type === 'orderChain') {
    return { score: orderScore(content.constraints, answer.order), feedback: '' };
  }
  return undefined;
};

/** Deterministic pseudo-random numbers in [0, 1) from a string seed (FNV-1a, then an LCG). */
const seeded = (seed: string) => {
  let state = 2166136261;
  for (let i = 0; i < seed.length; i++) state = Math.imul(state ^ seed.charCodeAt(i), 16777619);
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
};

const shuffle = <A>(items: ReadonlyArray<A>, random: () => number): Array<A> => {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
};

/** A multiple-choice content with the right option at a position chosen from `seed`. */
export const multipleChoiceContent = (
  question: string,
  correct: string,
  distractors: ReadonlyArray<string>,
  seed: string,
): Extract<ExerciseContent, { type: 'multipleChoice' }> => {
  const options = shuffle([correct, ...distractors], seeded(seed));
  return { type: 'multipleChoice', question, options, correctIndex: options.indexOf(correct) };
};

/**
 * The content of an ordering exercise, written by code (no model call): the chain's propositions
 * shuffled from `seed` so the shown order is not already right (when the chain allows that).
 */
export const orderChainContent = (
  graph: KnowledgeGraph,
  target: ExerciseTarget,
  seed: string,
): Extract<ExerciseContent, { type: 'orderChain' }> | undefined => {
  const chain = chainAround(graph, target.propositionIds[0]);
  if (chain === undefined) return undefined;
  const random = seeded(seed);
  let order = shuffle(chain.propositionIds, random);
  for (let tries = 0; tries < 10 && orderScore(chain.constraints, order) === 1; tries++) {
    order = shuffle(chain.propositionIds, random);
  }
  return {
    type: 'orderChain',
    items: order.map((propositionId) => ({
      propositionId,
      text: graph.propositions[propositionId]!.text,
    })),
    constraints: chain.constraints,
  };
};

/** What a model-graded exercise of `target` is graded against, taken from the graph now. */
export const referenceOf = (graph: KnowledgeGraph, target: ExerciseTarget): ExerciseReference => ({
  propositions: target.propositionIds.map((propositionId) => ({
    propositionId,
    text: graph.propositions[propositionId]?.text ?? '',
  })),
  edges: target.edgeIds.flatMap((edgeId) => {
    const edge = graph.edges[edgeId];
    return edge === undefined
      ? []
      : [{ from: edge.from, to: edge.to, relation: edge.relation, label: edge.label }];
  }),
});

/** Order in which types are tried, rotated per exercise so a set mixes them. */
const typeRotation: ReadonlyArray<ExerciseTypeId> = [
  'orderChain',
  'explainReasoning',
  'multipleChoice',
  'shortAnswer',
];

const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Picks the targets of one practice (A7):
 * 1. propositions due for review (`dueAt <= now`), weakest box first, then earliest due;
 * 2. propositions never graded, oldest first;
 * 3. the rest, weakest box first, then lowest last score, then earliest due.
 * For each, the first type that fits, trying the allowed types (`types`, for example the ones the
 * screen can render) in a rotation shifted by the exercise's position, so a set mixes them. A proposition already tested by
 * an earlier target of the set is skipped. Ties are broken by id, so the choice is deterministic.
 */
export const selectExercises = (
  graph: KnowledgeGraph,
  options: {
    readonly now: number;
    readonly count?: number;
    readonly types?: ReadonlyArray<ExerciseTypeId>;
  },
): ReadonlyArray<ExerciseTarget> => {
  const { now, count = 5, types = exerciseTypeIds } = options;
  const all = Object.values(graph.propositions);
  const due = all
    .filter((p) => (graph.mastery[p.propositionId]?.dueAt ?? Infinity) <= now)
    .sort((a, b) => {
      const ma = graph.mastery[a.propositionId]!;
      const mb = graph.mastery[b.propositionId]!;
      return ma.box - mb.box || ma.dueAt - mb.dueAt || byId(a.propositionId, b.propositionId);
    });
  const fresh = all
    .filter((p) => graph.mastery[p.propositionId] === undefined)
    .sort((a, b) => a.addedAt - b.addedAt || byId(a.propositionId, b.propositionId));
  const rest = all
    .filter((p) => (graph.mastery[p.propositionId]?.dueAt ?? -Infinity) > now)
    .sort((a, b) => {
      const ma = graph.mastery[a.propositionId]!;
      const mb = graph.mastery[b.propositionId]!;
      return (
        ma.box - mb.box ||
        ma.lastScore - mb.lastScore ||
        ma.dueAt - mb.dueAt ||
        byId(a.propositionId, b.propositionId)
      );
    });

  const allowed = typeRotation.filter((type) => types.includes(type));
  if (allowed.length === 0) return [];
  const targets: Array<ExerciseTarget> = [];
  const covered = new Set<PropositionId>();
  for (const proposition of [...due, ...fresh, ...rest]) {
    if (targets.length >= count) break;
    if (covered.has(proposition.propositionId)) continue;
    const shift = targets.length % allowed.length;
    const rotation = [...allowed.slice(shift), ...allowed.slice(0, shift)];
    for (const type of rotation) {
      const target = exerciseTypes[type].target(graph, proposition.propositionId);
      if (target === undefined) continue;
      targets.push(target);
      target.propositionIds.forEach((id) => covered.add(id));
      break;
    }
  }
  return targets;
};
