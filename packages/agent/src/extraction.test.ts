import { Effect, Result } from 'effect';
import { describe, expect, it } from 'vitest';
import { ProviderError, type ModelRef } from '@kd-learn/ai/port';
import {
  fitKnowledgeBatch,
  projectKnowledge,
  selectSessionSlice,
  type DomainEvent,
  type KnowledgeEvent,
  type KnowledgeGraph,
} from '@kd-learn/core';
import { defaultProfile } from './client.ts';
import { runExtraction, type ExtractionParams } from './extraction.ts';
import { counterIds, fakeAi, type Action } from './testing.ts';

const KEY = 'sk-ant-very-secret-key';
const model: ModelRef = { provider: 'anthropic', model: 'fake-model', apiKey: KEY };

const sessionLog: DomainEvent[] = [
  {
    _tag: 'SessionCreated',
    id: 'e1',
    at: 1,
    sessionId: 's1',
    topic: 'Binary search',
    profile: { ...defaultProfile, language: 'vi' },
  },
  { _tag: 'TurnStarted', id: 'e2', at: 2, turnId: 't1', input: 'I know arrays' },
  {
    _tag: 'AssessmentRecorded',
    id: 'e3',
    at: 3,
    turnId: 't1',
    level: 'beginner',
    summary: 'Knows arrays.',
    strengths: [],
    gaps: ['Sorting'],
  },
  {
    _tag: 'PlanCreated',
    id: 'e4',
    at: 4,
    turnId: 't1',
    plan: { nodes: [{ id: 'n1', title: 'Halving', goal: 'Halve the interval', dependsOn: [] }] },
  },
  {
    _tag: 'MessageAppended',
    id: 'e5',
    at: 5,
    turnId: 't1',
    messageId: 'm1',
    agent: 'teacher',
    content: 'Binary search needs a sorted array.',
  },
  { _tag: 'TurnCompleted', id: 'e6', at: 6, turnId: 't1', reason: 'stop' },
  // A failed turn: its text must not reach the model.
  { _tag: 'TurnStarted', id: 'e7', at: 7, turnId: 't2', input: 'SECRET FAILED INPUT' },
  { _tag: 'TurnFailed', id: 'e8', at: 8, turnId: 't2', code: 'x', message: 'x', retryable: true },
];

/** A graph with one proposition close to the session, to be found as a merge candidate. */
const graphEvents: KnowledgeEvent[] = [
  {
    _tag: 'PropositionAdded',
    id: 'g1',
    at: 1,
    propositionId: 'old-sorted',
    text: 'Binary search only works on a sorted array.',
    topic: 'Search',
    source: { sessionId: 's0' },
  },
  {
    _tag: 'PropositionAdded',
    id: 'g2',
    at: 1,
    propositionId: 'old-bayes',
    text: 'Bayes rule updates a prior with evidence.',
    topic: 'Probability',
    source: { sessionId: 's0' },
  },
];
const graph = (): KnowledgeGraph => {
  const result = projectKnowledge(graphEvents);
  if (Result.isFailure(result)) throw result.failure;
  return result.success;
};

const extracted = {
  propositions: [
    { key: 'sorted', text: 'Binary search requires a sorted array.', stepId: 'n1' },
    { key: 'halve', text: 'Binary search halves the search interval at every step.', stepId: 'n1' },
    { key: 'trivia', text: 'The teacher used an array of 7.', stepId: 'n1' },
    { key: 'two', text: 'Binary search is O(log n) and needs random access.', stepId: 'nope' },
  ],
  edges: [
    { from: 'halve', to: 'sorted', relation: 'requires', label: 'needs order' },
    { from: 'sorted', to: 'halve', relation: 'implies', label: 'wrong way' },
    { from: 'halve', to: 'ghost', relation: 'supports', label: 'unknown key' },
    { from: 'trivia', to: 'halve', relation: 'exampleOf', label: 'dropped end' },
  ],
};
const audited = {
  propositions: [
    { key: 'sorted', verdict: 'keep', text: '', parts: [], reason: '' },
    {
      key: 'halve',
      verdict: 'revise',
      text: 'Binary search halves the interval each step.',
      parts: [],
      reason: 'shorter',
    },
    { key: 'trivia', verdict: 'drop', text: '', parts: [], reason: 'trivia' },
    {
      key: 'two',
      verdict: 'split',
      text: '',
      parts: ['Binary search runs in O(log n) time.', 'Binary search needs random access.'],
      reason: 'two ideas',
    },
  ],
  edges: [
    { index: 0, verdict: 'keep', from: '', to: '', relation: 'requires', reason: '' },
    // Repeats edge 0 once fixed: the batch keeps only one of them.
    { index: 1, verdict: 'fix', from: 'halve', to: 'sorted', relation: 'requires', reason: 'flip' },
  ],
};
const merged = {
  decisions: [
    { key: 'sorted', action: 'same', existingId: 'old-sorted', reason: 'same claim' },
    // Not a candidate of this key: must not be trusted.
    { key: 'halve', action: 'same', existingId: 'old-bayes', reason: 'bogus' },
  ],
  edges: [
    { from: 'two#1', to: 'old-sorted', relation: 'supports', label: 'ok' },
    { from: 'halve', to: 'not-in-slice', relation: 'supports', label: 'bogus id' },
  ],
};

const run = (
  script: ReadonlyArray<ReadonlyArray<Action>>,
  overrides: Partial<ExtractionParams> = {},
) => {
  const fake = fakeAi(script);
  const params: ExtractionParams = {
    log: sessionLog,
    slice: selectSessionSlice(graph(), 'Binary search sorted array halving'),
    profile: defaultProfile,
    model,
    extractionId: 'x1',
    newId: counterIds('k'),
    maxOutputTokens: 8192,
    ...overrides,
  };
  return {
    fake,
    exit: Effect.runPromiseExit(runExtraction(params).pipe(fake.layer)),
  };
};

const ok = (value: unknown): Action[] => [{ usage: [100, 50] }, { result: value }];

describe('runExtraction', () => {
  it('turns a session into one valid batch that only refers to the slice', async () => {
    const { fake, exit } = run([ok(extracted), ok(audited), ok(merged)]);
    const result = await exit;
    if (result._tag === 'Failure') throw new Error(String(result.cause));
    const { events, usage } = result.value;

    // Three calls, with the role prompts, the cap and no failed turn in the transcript.
    expect(fake.requests.map((r) => r.system)).toEqual([
      defaultProfile.prompts.extractor,
      defaultProfile.prompts.auditor,
      defaultProfile.prompts.merge,
    ]);
    expect(fake.requests.every((r) => r.maxOutputTokens === 8192)).toBe(true);
    expect(fake.requests[0]!.messages[0]!.content).not.toContain('SECRET FAILED INPUT');
    expect(fake.requests[0]!.messages[0]!.content).toContain('"vi"');
    expect(usage).toEqual({ model: 'fake-model', calls: 3, inputTokens: 300, outputTokens: 150 });

    const added = events.filter((e) => e._tag === 'PropositionAdded');
    expect(added.map((e) => e.text)).toEqual([
      'Binary search halves the interval each step.',
      'Binary search runs in O(log n) time.',
      'Binary search needs random access.',
    ]);
    // `sorted` merged into the old proposition; `halve` stayed new despite the bogus id.
    expect(events.filter((e) => e._tag === 'PropositionSourced')).toMatchObject([
      { propositionId: 'old-sorted', source: { sessionId: 's1', stepId: 'n1' } },
    ]);
    // An unknown step id is not kept as a source step.
    expect(added[1]!.source).toEqual({ sessionId: 's1' });
    const edges = events.filter((e) => e._tag === 'EdgeAdded');
    expect(edges.map((e) => [e.from, e.relation, e.to])).toEqual([
      [added[0]!.propositionId, 'requires', 'old-sorted'],
      [added[1]!.propositionId, 'supports', 'old-sorted'],
    ]);
    expect(events.at(-1)).toMatchObject({
      _tag: 'SessionExtracted',
      sessionId: 's1',
      extractionId: 'x1',
      profileId: 'default',
      usage: { calls: 3 },
    });

    // The batch projects on the graph after `ExtractionStarted`.
    const started: KnowledgeEvent = {
      _tag: 'ExtractionStarted',
      id: 'st',
      at: 1,
      sessionId: 's1',
      extractionId: 'x1',
    };
    const fit = fitKnowledgeBatch(graph(), events);
    expect(fit.droppedEdges).toEqual([]);
    const after = projectKnowledge([...graphEvents, started, ...fit.events]);
    expect(Result.isSuccess(after)).toBe(true);

    // Extracting the same session again cannot add propositions twice: the second batch is rejected.
    const again = run([ok(extracted), ok(audited), ok(merged)], {
      extractionId: 'x2',
      newId: counterIds('j'),
    });
    const second = await again.exit;
    if (second._tag === 'Failure') throw new Error('unexpected');
    const retry: KnowledgeEvent = { ...started, id: 'st2', extractionId: 'x2' };
    expect(
      Result.isFailure(
        projectKnowledge([...graphEvents, started, ...fit.events, retry, ...second.value.events]),
      ),
    ).toBe(true);
  });

  it('skips merge when no proposition has a candidate', async () => {
    const { fake, exit } = run([ok(extracted), ok(audited)], { slice: [] });
    const result = await exit;
    if (result._tag === 'Failure') throw new Error(String(result.cause));
    expect(fake.requests).toHaveLength(2);
    expect(result.value.events.filter((e) => e._tag === 'PropositionSourced')).toEqual([]);
    expect(result.value.usage.calls).toBe(2);
  });

  it('turns output that breaks the schema into a typed failure', async () => {
    const { exit } = run([ok({ propositions: 'nope' })]);
    const result = await exit;
    expect(result._tag).toBe('Failure');
    expect(JSON.stringify(result)).toContain('ExtractionModelFailed');
    expect(JSON.stringify(result)).toContain('OutputInvalid');
  });

  it('reports a provider failure without the key, with the usage so far', async () => {
    const { exit } = run([
      ok(extracted),
      [{ fail: new ProviderError({ message: `bad key ${KEY}`, code: '401' }) }],
    ]);
    const result = await exit;
    if (result._tag === 'Success') throw new Error('expected a failure');
    const text = JSON.stringify(result.cause);
    expect(text).not.toContain(KEY);
    expect(text).toContain('"step":"auditor"');
    expect(text).toContain('"retryable":false');
    expect(text).toContain('"calls":2');
  });

  it('refuses a session with no completed turn', async () => {
    const { fake, exit } = run([], { log: sessionLog.slice(0, 2) });
    const result = await exit;
    expect(JSON.stringify(result)).toContain('InvalidExtraction');
    expect(fake.requests).toHaveLength(0);
  });
});
