import { Result, Schema } from 'effect';
import { describe, expect, it } from 'vitest';
import {
  emptyKnowledgeGraph,
  extractionStatus,
  fitKnowledgeBatch,
  projectKnowledge,
  resolveProposition,
  shouldAutoExtract,
  type KnowledgeGraph,
} from './knowledge.ts';
import { KnowledgeLog, type KnowledgeEvent, type Relation } from './knowledge-event.ts';

let counter = 0;
const meta = () => ({ id: `k${counter++}`, at: 1000 + counter });

const added = (propositionId: string, text = `Claim ${propositionId}.`): KnowledgeEvent => ({
  _tag: 'PropositionAdded',
  ...meta(),
  propositionId,
  text,
  topic: 'Search',
  source: { sessionId: 's1', stepId: 'step-1' },
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
const started = (sessionId: string, extractionId: string): KnowledgeEvent => ({
  _tag: 'ExtractionStarted',
  ...meta(),
  sessionId,
  extractionId,
});
const extracted = (sessionId: string, extractionId: string): KnowledgeEvent => ({
  _tag: 'SessionExtracted',
  ...meta(),
  sessionId,
  extractionId,
  profileId: 'default',
});
const failed = (sessionId: string, extractionId: string): KnowledgeEvent => ({
  _tag: 'ExtractionFailed',
  ...meta(),
  sessionId,
  extractionId,
  code: 'ProviderError',
  message: 'boom',
  retryable: true,
});

const project = (events: ReadonlyArray<KnowledgeEvent>): KnowledgeGraph => {
  const result = projectKnowledge(events);
  if (Result.isFailure(result)) throw new Error(result.failure.message);
  return result.success;
};
/** The message of the projection error, with its index. */
const rejection = (events: ReadonlyArray<KnowledgeEvent>) => {
  const result = projectKnowledge(events);
  if (Result.isSuccess(result)) throw new Error('expected a ProjectionError');
  return { index: result.failure.index, message: result.failure.message };
};

describe('projectKnowledge: propositions', () => {
  it('projects an empty log to an empty graph', () => {
    expect(project([])).toEqual(emptyKnowledgeGraph);
  });

  it('adds, revises and sources a proposition, without repeating a source', () => {
    const graph = project([
      added('p1'),
      { _tag: 'PropositionRevised', ...meta(), propositionId: 'p1', text: 'Better claim.' },
      { _tag: 'PropositionSourced', ...meta(), propositionId: 'p1', source: { sessionId: 's2' } },
      {
        _tag: 'PropositionSourced',
        ...meta(),
        propositionId: 'p1',
        source: { sessionId: 's1', stepId: 'step-1' },
      },
    ]);
    expect(graph.propositions.p1).toMatchObject({
      text: 'Better claim.',
      sources: [{ sessionId: 's1', stepId: 'step-1' }, { sessionId: 's2' }],
    });
  });

  it('rejects a repeated proposition id, even after it was retired', () => {
    expect(rejection([added('p1'), added('p1')]).index).toBe(1);
    const retired: KnowledgeEvent = { _tag: 'PropositionRetired', ...meta(), propositionId: 'p1' };
    expect(rejection([added('p1'), retired, added('p1')]).index).toBe(2);
  });

  it('rejects events that refer to an unknown, retired or merged-away proposition', () => {
    const revise = (propositionId: string): KnowledgeEvent => ({
      _tag: 'PropositionRevised',
      ...meta(),
      propositionId,
      text: 'x',
    });
    expect(rejection([revise('nope')]).message).toMatch(/Unknown proposition/);
    expect(
      rejection([
        added('p1'),
        { _tag: 'PropositionRetired', ...meta(), propositionId: 'p1' },
        revise('p1'),
      ]).message,
    ).toMatch(/retired/);
    expect(
      rejection([
        added('p1'),
        added('p2'),
        { _tag: 'PropositionsMerged', ...meta(), from: 'p1', into: 'p2' },
        edge('e1', 'p1', 'p2', 'supports'),
      ]).message,
    ).toMatch(/merged into "p2"/);
  });

  it('retiring a proposition removes its edges', () => {
    const graph = project([
      added('p1'),
      added('p2'),
      added('p3'),
      edge('e1', 'p1', 'p2', 'implies'),
      edge('e2', 'p2', 'p3', 'implies'),
      { _tag: 'PropositionRetired', ...meta(), propositionId: 'p2' },
    ]);
    expect(Object.keys(graph.propositions)).toEqual(['p1', 'p3']);
    expect(graph.edges).toEqual({});
    expect(graph.inactive.p2).toEqual({ _tag: 'Retired' });
    expect(resolveProposition(graph, 'p2')).toBeUndefined();
  });
});

describe('projectKnowledge: edges', () => {
  it('rejects self-loops, unknown ends, repeated ids and repeated edges', () => {
    expect(rejection([added('p1'), edge('e1', 'p1', 'p1', 'supports')]).message).toMatch(/itself/);
    expect(rejection([added('p1'), edge('e1', 'p1', 'p9', 'supports')]).message).toMatch(/Unknown/);
    expect(
      rejection([
        added('p1'),
        added('p2'),
        edge('e1', 'p1', 'p2', 'supports'),
        edge('e1', 'p2', 'p1', 'implies'),
      ]).message,
    ).toMatch(/already exists/);
    expect(
      rejection([
        added('p1'),
        added('p2'),
        edge('e1', 'p1', 'p2', 'supports'),
        edge('e2', 'p1', 'p2', 'supports'),
      ]).message,
    ).toMatch(/repeats edge "e1"/);
  });

  it('treats contrastsWith as undirected', () => {
    expect(
      rejection([
        added('p1'),
        added('p2'),
        edge('e1', 'p1', 'p2', 'contrastsWith'),
        edge('e2', 'p2', 'p1', 'contrastsWith'),
      ]).message,
    ).toMatch(/repeats/);
    // `supports` has a direction: both ways are two edges.
    const graph = project([
      added('p1'),
      added('p2'),
      edge('e1', 'p1', 'p2', 'supports'),
      edge('e2', 'p2', 'p1', 'supports'),
    ]);
    expect(Object.keys(graph.edges)).toEqual(['e1', 'e2']);
  });

  it('rejects a cycle of implies', () => {
    const result = rejection([
      added('a'),
      added('b'),
      added('c'),
      edge('e1', 'a', 'b', 'implies'),
      edge('e2', 'b', 'c', 'implies'),
      edge('e3', 'c', 'a', 'implies'),
    ]);
    expect(result).toEqual({ index: 5, message: expect.stringMatching(/cycle/) });
  });

  it('reads requires against implies: A requires B puts B first', () => {
    // A implies B and A requires B contradict each other (A before B, and B before A).
    expect(
      rejection([
        added('a'),
        added('b'),
        edge('e1', 'a', 'b', 'implies'),
        edge('e2', 'a', 'b', 'requires'),
      ]).message,
    ).toMatch(/cycle/);
    // B implies A and A requires B agree (B before A).
    project([
      added('a'),
      added('b'),
      edge('e1', 'b', 'a', 'implies'),
      edge('e2', 'a', 'b', 'requires'),
    ]);
    // A cycle made of both relations: a -> b (implies), b -> c (c requires b), c -> a (implies).
    expect(
      rejection([
        added('a'),
        added('b'),
        added('c'),
        edge('e1', 'a', 'b', 'implies'),
        edge('e2', 'c', 'b', 'requires'),
        edge('e3', 'c', 'a', 'implies'),
      ]).message,
    ).toMatch(/cycle/);
  });

  it('allows cycles of the unordered relations', () => {
    project([
      added('a'),
      added('b'),
      edge('e1', 'a', 'b', 'supports'),
      edge('e2', 'b', 'a', 'supports'),
      edge('e3', 'a', 'b', 'implies'),
    ]);
  });

  it('removes an edge once', () => {
    const remove: KnowledgeEvent = { _tag: 'EdgeRemoved', ...meta(), edgeId: 'e1' };
    const log = [added('a'), added('b'), edge('e1', 'a', 'b', 'implies'), remove];
    expect(project(log).edges).toEqual({});
    expect(rejection([...log, { ...remove, id: 'again' }]).message).toMatch(/not in the graph/);
    // A removed edge id is not reused.
    expect(rejection([...log, edge('e1', 'a', 'b', 'implies')]).message).toMatch(/already exists/);
  });
});

describe('projectKnowledge: merge', () => {
  it('moves sources and edges to the kept proposition, dropping self-loops and repeats', () => {
    const graph = project([
      added('keep'),
      { ...added('dup'), source: { sessionId: 's2' } } as KnowledgeEvent,
      added('other'),
      edge('e1', 'dup', 'keep', 'supports'),
      edge('e2', 'dup', 'other', 'implies'),
      edge('e3', 'keep', 'other', 'implies'),
      edge('e4', 'other', 'dup', 'contrastsWith'),
      { _tag: 'PropositionsMerged', ...meta(), from: 'dup', into: 'keep' },
    ]);
    expect(graph.propositions.keep?.sources).toEqual([
      { sessionId: 's1', stepId: 'step-1' },
      { sessionId: 's2' },
    ]);
    expect(graph.propositions.dup).toBeUndefined();
    expect(graph.inactive.dup).toEqual({ _tag: 'Merged', into: 'keep' });
    // e1 became a self-loop, e2 repeats e3; e4 is re-pointed.
    expect(graph.edges).toEqual({
      e3: { edgeId: 'e3', from: 'keep', to: 'other', relation: 'implies', label: '' },
      e4: { edgeId: 'e4', from: 'other', to: 'keep', relation: 'contrastsWith', label: '' },
    });
    expect(resolveProposition(graph, 'dup')?.propositionId).toBe('keep');
  });

  it('rejects a merge that makes a cycle', () => {
    // a implies b implies c; merging a into c gives c implies b implies c.
    expect(
      rejection([
        added('a'),
        added('b'),
        added('c'),
        edge('e1', 'a', 'b', 'implies'),
        edge('e2', 'b', 'c', 'implies'),
        { _tag: 'PropositionsMerged', ...meta(), from: 'a', into: 'c' },
      ]).message,
    ).toMatch(/cycle/);
  });

  it('rejects merging a proposition into itself or into one that is gone', () => {
    expect(
      rejection([added('a'), { _tag: 'PropositionsMerged', ...meta(), from: 'a', into: 'a' }])
        .message,
    ).toMatch(/itself/);
    expect(
      rejection([
        added('a'),
        added('b'),
        { _tag: 'PropositionRetired', ...meta(), propositionId: 'b' },
        { _tag: 'PropositionsMerged', ...meta(), from: 'a', into: 'b' },
      ]).message,
    ).toMatch(/retired/);
  });
});

describe('projectKnowledge: extraction', () => {
  it('runs a session once: a second SessionExtracted is rejected', () => {
    const first = [started('s1', 'x1'), added('p1'), extracted('s1', 'x1')];
    const graph = project(first);
    expect(extractionStatus(graph, 's1')).toBe('extracted');
    expect(graph.extractions.s1?.extractedBy).toBe('x1');

    // Two writers each started an attempt; the second result batch must not project.
    const race = [started('s1', 'x1'), started('s1', 'x2'), added('p1'), extracted('s1', 'x1')];
    expect(rejection([...race, added('p2'), extracted('s1', 'x2')]).index).toBe(5);
    // And no new attempt starts after the session is extracted.
    expect(rejection([...first, started('s1', 'x3')]).message).toMatch(/already extracted/);
  });

  it('ends an attempt only once, and only one that was started for that session', () => {
    expect(rejection([extracted('s1', 'x1')]).message).toMatch(/never started/);
    expect(rejection([started('s1', 'x1'), extracted('s2', 'x1')]).message).toMatch(
      /never started/,
    );
    expect(
      rejection([started('s1', 'x1'), failed('s1', 'x1'), failed('s1', 'x1')]).message,
    ).toMatch(/already ended/);
    expect(rejection([started('s1', 'x1'), started('s2', 'x1')]).message).toMatch(/already exists/);
  });

  it('auto-extracts only a session that was never attempted', () => {
    expect(shouldAutoExtract(project([]), 's1')).toBe(true);
    const interrupted = project([started('s1', 'x1')]);
    expect(extractionStatus(interrupted, 's1')).toBe('running');
    expect(shouldAutoExtract(interrupted, 's1')).toBe(false);
    const afterFailure = project([started('s1', 'x1'), failed('s1', 'x1')]);
    expect(extractionStatus(afterFailure, 's1')).toBe('failed');
    expect(shouldAutoExtract(afterFailure, 's1')).toBe(false);
    // The retry button starts a new attempt, which may succeed.
    const retried = project([
      started('s1', 'x1'),
      failed('s1', 'x1'),
      started('s1', 'x2'),
      extracted('s1', 'x2'),
    ]);
    expect(retried.extractions.s1?.attempts.map((a) => a.status)).toEqual(['failed', 'extracted']);
  });
});

describe('KnowledgeLog schema', () => {
  it('round-trips through JSON and rejects an unknown relation', () => {
    const log = [added('a'), added('b'), edge('e1', 'a', 'b', 'requires')];
    const decode = Schema.decodeUnknownSync(KnowledgeLog);
    expect(decode(JSON.parse(JSON.stringify(log)))).toEqual(log);
    expect(() => decode([{ ...edge('e2', 'a', 'b', 'implies'), relation: 'causes' }])).toThrow();
  });
});

describe('projectKnowledge: scale', () => {
  it('projects 3,000 propositions and 4,000 ordered edges quickly', () => {
    const events: KnowledgeEvent[] = [];
    const n = 3000;
    for (let i = 0; i < n; i++) events.push(added(`n${i}`));
    let seed = 1;
    const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let e = 0; e < 4000; e++) {
      const a = Math.floor(random() * n);
      const b = Math.floor(random() * n);
      if (a === b) continue;
      // Low index before high index, through either relation, so the graph stays acyclic.
      const [lo, hi] = a < b ? [a, b] : [b, a];
      events.push(
        e % 2 === 0
          ? edge(`x${e}`, `n${lo}`, `n${hi}`, 'implies')
          : edge(`x${e}`, `n${hi}`, `n${lo}`, 'requires'),
      );
    }
    const start = Date.now();
    const result = projectKnowledge(events);
    const elapsed = Date.now() - start;
    expect(Result.isSuccess(result)).toBe(true);
    // About 10 ms on a laptop; the bound only catches a return to quadratic work.
    expect(elapsed).toBeLessThan(500);
  });
});

describe('fitKnowledgeBatch', () => {
  it('drops edges that repeat, loop or make a cycle on the current graph, and keeps the rest', () => {
    const graphLog: KnowledgeEvent[] = [
      added('a'),
      added('b'),
      added('gone'),
      edge('e1', 'a', 'b', 'implies'),
      { _tag: 'PropositionRetired', ...meta(), propositionId: 'gone' },
    ];
    const graph = project(graphLog);
    const batch = [
      added('c'),
      edge('n1', 'b', 'a', 'implies'), // cycle with e1
      edge('n2', 'a', 'b', 'implies'), // repeats e1
      edge('n3', 'c', 'c', 'supports'), // self-loop
      edge('n4', 'c', 'gone', 'supports'), // retired end
      edge('n5', 'b', 'c', 'implies'), // fine
      edge('n6', 'c', 'a', 'implies'), // cycle through n5, accepted earlier in the batch
    ];
    const fit = fitKnowledgeBatch(graph, batch);
    expect(fit.droppedEdges.map((d) => d.edgeId)).toEqual(['n1', 'n2', 'n3', 'n4', 'n6']);
    expect(fit.events.map((e) => ('edgeId' in e ? e.edgeId : e._tag))).toEqual([
      'PropositionAdded',
      'n5',
    ]);
    expect(Result.isSuccess(projectKnowledge([...graphLog, ...fit.events]))).toBe(true);
  });

  it('moves a source or an edge end from a merged-away proposition to the one it went into', () => {
    const log: KnowledgeEvent[] = [
      added('a'),
      added('b'),
      added('c'),
      { _tag: 'PropositionsMerged', ...meta(), from: 'a', into: 'b' },
    ];
    const graph = project(log);
    const fit = fitKnowledgeBatch(graph, [
      { _tag: 'PropositionSourced', ...meta(), propositionId: 'a', source: { sessionId: 's9' } },
      edge('m1', 'c', 'a', 'supports'),
    ]);
    expect(fit.events).toMatchObject([{ propositionId: 'b' }, { from: 'c', to: 'b' }]);
    expect(Result.isSuccess(projectKnowledge([...log, ...fit.events]))).toBe(true);
  });
});
