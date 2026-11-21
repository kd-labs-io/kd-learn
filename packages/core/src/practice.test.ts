import { Result } from 'effect';
import { describe, expect, it } from 'vitest';
import type { ExerciseAnswer, ExerciseContent, ExerciseTypeId } from './exercise-schema.ts';
import {
  chainAround,
  gradeByCode,
  multipleChoiceContent,
  orderChainContent,
  orderScore,
  referenceOf,
  selectExercises,
} from './exercises.ts';
import { projectKnowledge, type KnowledgeGraph } from './knowledge.ts';
import type { KnowledgeEvent, Relation } from './knowledge-event.ts';
import { boxIntervalDays, mergeMastery, nextMastery } from './practice.ts';

const day = 24 * 60 * 60 * 1000;
let counter = 0;
const meta = (at = 1000 + counter) => ({ id: `e${counter++}`, at });

const added = (propositionId: string, at?: number): KnowledgeEvent => ({
  _tag: 'PropositionAdded',
  ...meta(at),
  propositionId,
  text: `Claim ${propositionId}.`,
  topic: 'Search',
  source: { sessionId: 's1' },
});
const edge = (edgeId: string, from: string, to: string, relation: Relation): KnowledgeEvent => ({
  _tag: 'EdgeAdded',
  ...meta(),
  edgeId,
  from,
  to,
  relation,
  label: '',
});
const start = (practiceId: string): KnowledgeEvent => ({
  _tag: 'PracticeStarted',
  ...meta(),
  practiceId,
});
const end = (practiceId: string): KnowledgeEvent => ({
  _tag: 'PracticeEnded',
  ...meta(),
  practiceId,
});
const shortAnswer: ExerciseContent = {
  type: 'shortAnswer',
  question: 'Why?',
  reference: { propositions: [], edges: [] },
};
const issue = (
  exerciseId: string,
  propositionIds: [string, ...string[]],
  content: ExerciseContent = shortAnswer,
  practiceId = 'pr1',
  edgeIds: string[] = [],
): KnowledgeEvent => ({
  _tag: 'ExerciseIssued',
  ...meta(),
  practiceId,
  exerciseId,
  type: content.type,
  propositionIds,
  edgeIds,
  content,
});
const answer = (
  exerciseId: string,
  value: ExerciseAnswer = { type: 'shortAnswer', text: 'Because.' },
): KnowledgeEvent => ({ _tag: 'AnswerSubmitted', ...meta(), exerciseId, answer: value });
const grade = (exerciseId: string, score: number, at?: number): KnowledgeEvent => ({
  _tag: 'ExerciseGraded',
  ...meta(at),
  exerciseId,
  score,
  feedback: 'ok',
  profileId: 'default',
});

const project = (events: ReadonlyArray<KnowledgeEvent>): KnowledgeGraph => {
  const result = projectKnowledge(events);
  if (Result.isFailure(result)) throw new Error(result.failure.message);
  return result.success;
};
const rejection = (events: ReadonlyArray<KnowledgeEvent>) => {
  const result = projectKnowledge(events);
  if (Result.isSuccess(result)) throw new Error('expected a ProjectionError');
  return result.failure.message;
};

describe('projectKnowledge: practice', () => {
  it('records issue, answer and grade of an exercise', () => {
    const graph = project([
      added('a'),
      start('pr1'),
      issue('x1', ['a']),
      answer('x1'),
      grade('x1', 1),
      end('pr1'),
    ]);
    expect(graph.practices.pr1).toMatchObject({ exerciseIds: ['x1'], endedAt: expect.any(Number) });
    expect(graph.exercises.x1).toMatchObject({
      answer: { type: 'shortAnswer', text: 'Because.' },
      grade: { score: 1, feedback: 'ok', profileId: 'default' },
    });
    expect(graph.mastery.a).toMatchObject({ box: 2, attempts: 1, lastScore: 1 });
  });

  it('issues only into an open practice, about active propositions and edges', () => {
    expect(rejection([added('a'), issue('x1', ['a'])])).toMatch(/never started/);
    expect(rejection([added('a'), start('pr1'), end('pr1'), issue('x1', ['a'])])).toMatch(
      /has ended/,
    );
    expect(rejection([start('pr1'), issue('x1', ['nope'])])).toMatch(/Unknown proposition/);
    expect(
      rejection([added('a'), start('pr1'), issue('x1', ['a'], shortAnswer, 'pr1', ['e9'])]),
    ).toMatch(/Edge "e9"/);
    expect(rejection([added('a'), start('pr1'), issue('x1', ['a']), issue('x1', ['a'])])).toMatch(
      /already exists/,
    );
    expect(rejection([added('a'), start('pr1'), issue('x1', ['a', 'a'])])).toMatch(/twice/);
    expect(rejection([start('pr1'), start('pr1')])).toMatch(/already exists/);
  });

  it('checks the content against its type', () => {
    const mc: ExerciseContent = {
      type: 'multipleChoice',
      question: 'Which?',
      options: ['x', 'y'],
      correctIndex: 2,
    };
    expect(rejection([added('a'), start('pr1'), issue('x1', ['a'], mc)])).toMatch(/correct option/);
    const order: ExerciseContent = {
      type: 'orderChain',
      items: [
        { propositionId: 'a', text: 'A' },
        { propositionId: 'b', text: 'B' },
        { propositionId: 'z', text: 'Z' },
      ],
      constraints: [],
    };
    expect(
      rejection([
        added('a'),
        added('b'),
        added('c'),
        start('pr1'),
        issue('x1', ['a', 'b', 'c'], order),
      ]),
    ).toMatch(/items of an ordering exercise/);
  });

  it('answers once, while open, with an answer of the same type', () => {
    const base = [added('a'), start('pr1'), issue('x1', ['a'])];
    expect(rejection([...base, answer('x1'), answer('x1')])).toMatch(/already answered/);
    expect(rejection([...base, end('pr1'), answer('x1')])).toMatch(/has ended/);
    expect(rejection([...base, answer('x1', { type: 'multipleChoice', choice: 0 })])).toMatch(
      /Answer of type multipleChoice/,
    );
    expect(rejection([answer('nope')])).toMatch(/never issued/);
  });

  it('grades once, after the answer, also after the practice ended', () => {
    const base = [added('a'), start('pr1'), issue('x1', ['a'])];
    expect(rejection([...base, grade('x1', 1)])).toMatch(/no answer/);
    expect(rejection([...base, answer('x1'), grade('x1', 1), grade('x1', 0)])).toMatch(
      /already graded/,
    );
    project([...base, answer('x1'), end('pr1'), grade('x1', 0.5)]);
  });

  it('keeps an exercise whose proposition was retired, and gives the grade to no one', () => {
    const graph = project([
      added('a'),
      start('pr1'),
      issue('x1', ['a']),
      { _tag: 'PropositionRetired', ...meta(), propositionId: 'a' },
      answer('x1'),
      grade('x1', 1),
    ]);
    expect(graph.exercises.x1?.grade?.score).toBe(1);
    expect(graph.mastery).toEqual({});
  });

  it('counts a grade for the proposition a tested one was merged into, once', () => {
    const graph = project([
      added('a'),
      added('b'),
      start('pr1'),
      issue('x1', ['a', 'b']),
      { _tag: 'PropositionsMerged', ...meta(), from: 'a', into: 'b' },
      answer('x1'),
      grade('x1', 1),
    ]);
    expect(Object.keys(graph.mastery)).toEqual(['b']);
    expect(graph.mastery.b?.attempts).toBe(1);
  });

  it('merges mastery records into the weaker one and drops them on retire', () => {
    const graph = project([
      added('a'),
      added('b'),
      start('pr1'),
      issue('x1', ['a']),
      answer('x1'),
      grade('x1', 1),
      issue('x2', ['b']),
      answer('x2'),
      grade('x2', 0),
      { _tag: 'PropositionsMerged', ...meta(), from: 'a', into: 'b' },
    ]);
    expect(graph.mastery).toEqual({ b: expect.objectContaining({ box: 1, attempts: 2 }) });
    const retired = project([
      added('a'),
      start('pr1'),
      issue('x1', ['a']),
      answer('x1'),
      grade('x1', 1),
      { _tag: 'PropositionRetired', ...meta(), propositionId: 'a' },
    ]);
    expect(retired.mastery).toEqual({});
  });
});

describe('mastery (Leitner)', () => {
  it('moves up on a right answer, stays on a partial one, resets on a wrong one', () => {
    const first = nextMastery(undefined, 1, 0);
    expect(first).toMatchObject({ box: 2, dueAt: boxIntervalDays[1]! * day });
    const second = nextMastery(first, 0.8, day);
    expect(second.box).toBe(3);
    expect(nextMastery(second, 0.5, 2 * day).box).toBe(3);
    const wrong = nextMastery(second, 0.2, 2 * day);
    expect(wrong).toMatchObject({ box: 1, attempts: 3, dueAt: 3 * day });
    expect(nextMastery(undefined, 0, 0).box).toBe(1);
    let top = first;
    for (let i = 0; i < 10; i++) top = nextMastery(top, 1, 0);
    expect(top.box).toBe(5);
  });

  it('keeps the weaker record on merge', () => {
    const strong = nextMastery(nextMastery(undefined, 1, 0), 1, 0);
    const weak = nextMastery(undefined, 0, 0);
    expect(mergeMastery(strong, weak)).toMatchObject({ box: 1, attempts: 3 });
    expect(mergeMastery(undefined, weak)).toBe(weak);
  });
});

describe('code grading', () => {
  it('grades multiple choice by the correct index', () => {
    const content = multipleChoiceContent('Q?', 'right', ['w1', 'w2', 'w3'], 'seed');
    expect(content.options[content.correctIndex]).toBe('right');
    expect(
      gradeByCode(content, { type: 'multipleChoice', choice: content.correctIndex })?.score,
    ).toBe(1);
    expect(
      gradeByCode(content, { type: 'multipleChoice', choice: (content.correctIndex + 1) % 4 })
        ?.score,
    ).toBe(0);
    // The seed moves the right option, so the model's order does not give it away.
    const positions = new Set(
      ['s1', 's2', 's3', 's4', 's5', 's6'].map(
        (seed) => multipleChoiceContent('Q?', 'right', ['w1', 'w2', 'w3'], seed).correctIndex,
      ),
    );
    expect(positions.size).toBeGreaterThan(1);
  });

  it('accepts every topological order of a chain', () => {
    // a before c, b before c: a b c and b a c are both right.
    const constraints = [
      { before: 'a', after: 'c' },
      { before: 'b', after: 'c' },
    ];
    expect(orderScore(constraints, ['a', 'b', 'c'])).toBe(1);
    expect(orderScore(constraints, ['b', 'a', 'c'])).toBe(1);
    expect(orderScore(constraints, ['c', 'a', 'b'])).toBe(0);
    expect(orderScore(constraints, ['a', 'c', 'b'])).toBe(0.5);
  });

  it('leaves model-graded types to the model', () => {
    expect(gradeByCode(shortAnswer, { type: 'shortAnswer', text: 'x' })).toBeUndefined();
  });
});

describe('chains and targets', () => {
  // a -> b -> c -> d (implies), and e requires d (d before e).
  const graph = project([
    added('a'),
    added('b'),
    added('c'),
    added('d'),
    added('e'),
    added('lonely'),
    edge('e1', 'a', 'b', 'implies'),
    edge('e2', 'b', 'c', 'implies'),
    edge('e3', 'c', 'd', 'implies'),
    edge('e4', 'e', 'd', 'requires'),
    edge('e5', 'a', 'lonely', 'supports'),
  ]);

  it('collects the chain around a proposition with every ordered link inside it', () => {
    const chain = chainAround(graph, 'c')!;
    expect(new Set(chain.propositionIds)).toEqual(new Set(['a', 'b', 'c', 'd', 'e']));
    expect(chain.propositionIds[0]).toBe('c');
    expect(chain.constraints).toContainEqual({ before: 'd', after: 'e' });
    expect(chain.edgeIds).toEqual(['e1', 'e2', 'e3', 'e4']);
    expect(chainAround(graph, 'lonely')).toBeUndefined();
  });

  it('shuffles an ordering exercise so it is not already solved', () => {
    const target = { type: 'orderChain' as const, propositionIds: ['a'] as [string], edgeIds: [] };
    const content = orderChainContent(graph, target, 'seed')!;
    expect(content.items).toHaveLength(5);
    expect(
      orderScore(
        content.constraints,
        content.items.map((i) => i.propositionId),
      ),
    ).toBeLessThan(1);
    expect(orderScore(content.constraints, ['a', 'b', 'c', 'd', 'e'])).toBe(1);
  });

  it('takes the reference of a model-graded exercise from the graph', () => {
    expect(
      referenceOf(graph, { type: 'explainReasoning', propositionIds: ['a', 'b'], edgeIds: ['e1'] }),
    ).toEqual({
      propositions: [
        { propositionId: 'a', text: 'Claim a.' },
        { propositionId: 'b', text: 'Claim b.' },
      ],
      edges: [{ from: 'a', to: 'b', relation: 'implies', label: '' }],
    });
  });
});

describe('selectExercises', () => {
  const types = (targets: ReadonlyArray<{ type: ExerciseTypeId }>) => targets.map((t) => t.type);

  it('puts due propositions first, then new ones, then the weakest', () => {
    const now = 100 * day;
    const graph = project([
      added('fresh', 5),
      added('due', 1),
      added('later', 2),
      start('pr1'),
      issue('x1', ['due']),
      answer('x1'),
      grade('x1', 0, 0),
      issue('x2', ['later']),
      answer('x2'),
      grade('x2', 1, now),
    ]);
    const targets = selectExercises(graph, { now, count: 3, types: ['shortAnswer'] });
    expect(targets.map((t) => t.propositionIds[0])).toEqual(['due', 'fresh', 'later']);
    expect(selectExercises(graph, { now, count: 1 })).toHaveLength(1);
  });

  it('rotates types, uses only allowed ones that fit, and does not test a proposition twice', () => {
    const graph = project([
      added('a'),
      added('b'),
      added('c'),
      added('d'),
      edge('e1', 'a', 'b', 'implies'),
      edge('e2', 'b', 'c', 'implies'),
    ]);
    const targets = selectExercises(graph, { now: 0, count: 4 });
    // a: ordering chain a, b, c; then d (no edges): rotation starts at explainReasoning, which
    // does not fit, so multiple choice.
    expect(types(targets)).toEqual(['orderChain', 'multipleChoice']);
    expect(selectExercises(graph, { now: 0, count: 4, types: ['shortAnswer'] })).toHaveLength(4);
    // Two allowed types alternate.
    expect(
      types(selectExercises(graph, { now: 0, count: 4, types: ['multipleChoice', 'shortAnswer'] })),
    ).toEqual(['multipleChoice', 'shortAnswer', 'multipleChoice', 'shortAnswer']);
    expect(selectExercises(graph, { now: 0, types: [] })).toEqual([]);
  });
});
