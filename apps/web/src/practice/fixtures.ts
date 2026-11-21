// A knowledge log for practice tests (vitest and Playwright): a three-step chain, one linked pair
// and two single claims, so `selectExercises` issues one exercise of each type. Types only: the
// browser test imports it too.
import type { KnowledgeEvent } from '@kd-learn/core';

const claims: ReadonlyArray<readonly [string, string]> = [
  ['c1', 'Binary search halves the range at every step.'],
  ['c2', 'Halving needs the middle element to be compared.'],
  ['c3', 'Comparing to the middle needs a sorted array.'],
  ['x1', 'A sorted array allows lookups in logarithmic time.'],
  ['x2', 'Logarithmic time grows slowly with the input size.'],
  ['y1', 'An unsorted array must be scanned element by element.'],
  ['z1', 'Sorting first costs more than one linear scan.'],
];

const links = [
  ['e1', 'c1', 'c2', 'requires'],
  ['e2', 'c2', 'c3', 'requires'],
  ['e3', 'x1', 'x2', 'implies'],
] as const;

export const practiceSeed = (at: number): KnowledgeEvent[] => [
  ...claims.map(([propositionId, text], i): KnowledgeEvent => ({
    _tag: 'PropositionAdded',
    id: `seed-${propositionId}`,
    at: at + i,
    propositionId,
    text,
    topic: 'Binary search',
    source: { sessionId: 'seed' },
  })),
  ...links.map(([edgeId, from, to, relation], i): KnowledgeEvent => ({
    _tag: 'EdgeAdded',
    id: `seed-${edgeId}`,
    at: at + claims.length + i,
    edgeId,
    from,
    to,
    relation,
    label: '',
  })),
];
