import { Result } from 'effect';
import { describe, expect, it } from 'vitest';
import { projectKnowledge, type KnowledgeGraph } from './knowledge.ts';
import type { KnowledgeEvent } from './knowledge-event.ts';
import {
  lexicalSimilarity,
  selectCandidates,
  selectSessionSlice,
  sessionQueryText,
  tokenize,
} from './slice.ts';
import { projectSession } from './session.ts';
import type { DomainEvent } from './event.ts';

const graphOf = (texts: Record<string, string>): KnowledgeGraph => {
  const events: KnowledgeEvent[] = Object.entries(texts).map(([propositionId, text], i) => ({
    _tag: 'PropositionAdded',
    id: `k${i}`,
    at: i,
    propositionId,
    text,
    topic: 't',
    source: { sessionId: 's' },
  }));
  const result = projectKnowledge(events);
  if (Result.isFailure(result)) throw new Error(result.failure.message);
  return result.success;
};

describe('tokenize', () => {
  it('drops stopwords and short words, lower-cases and cuts plurals', () => {
    expect([...tokenize('The Arrays are sorted, and a search halves it.')]).toEqual([
      'array',
      'sorted',
      'search',
      'halv',
    ]);
  });

  it('keeps Vietnamese letters and drops Vietnamese function words', () => {
    expect([...tokenize('Tìm kiếm nhị phân là thuật toán chia đôi mảng đã sắp xếp')]).toEqual([
      'tìm',
      'kiếm',
      'nhị',
      'phân',
      'thuật',
      'toán',
      'chia',
      'đôi',
      'mảng',
      'sắp',
      'xếp',
    ]);
  });

  it('treats composed and decomposed accents the same', () => {
    expect(tokenize('Tìm kiếm'.normalize('NFD'))).toEqual(tokenize('Tìm kiếm'));
  });
});

describe('lexicalSimilarity', () => {
  it('is a binary cosine and 0 for an empty set', () => {
    expect(lexicalSimilarity(new Set(['a', 'b']), new Set(['b', 'c']))).toBeCloseTo(0.5);
    expect(lexicalSimilarity(new Set(), new Set(['a']))).toBe(0);
  });
});

describe('selectSessionSlice', () => {
  const graph = graphOf({
    p1: 'Binary search needs a sorted array.',
    p2: 'Binary search halves the search interval each step.',
    p3: 'Bayes rule updates a prior with evidence.',
    p4: 'Merge sort splits an array in halves.',
  });

  it('keeps the closest propositions, best first, and drops those sharing no word', () => {
    const slice = selectSessionSlice(graph, 'Binary search on a sorted array');
    expect(slice.map((p) => p.propositionId)).toEqual(['p1', 'p2', 'p4']);
  });

  it('respects the count and byte limits', () => {
    expect(selectSessionSlice(graph, 'binary search array', { limit: 1 })).toHaveLength(1);
    const one = JSON.stringify(selectSessionSlice(graph, 'binary search array', { limit: 1 }));
    const cut = selectSessionSlice(graph, 'binary search array', { maxBytes: one.length });
    expect(cut).toHaveLength(1);
    expect(JSON.stringify(cut).length).toBeLessThanOrEqual(one.length);
  });

  it('breaks ties by id, so guest and server pick the same slice', () => {
    const tied = graphOf({ b: 'Sorted array.', a: 'Sorted array.', c: 'Sorted array.' });
    expect(selectSessionSlice(tied, 'sorted array').map((p) => p.propositionId)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('leaves out retired propositions', () => {
    const result = projectKnowledge([
      {
        _tag: 'PropositionAdded',
        id: 'k1',
        at: 1,
        propositionId: 'p1',
        text: 'Sorted array.',
        topic: 't',
        source: { sessionId: 's' },
      },
      { _tag: 'PropositionRetired', id: 'k2', at: 2, propositionId: 'p1' },
    ]);
    if (Result.isFailure(result)) throw new Error('unexpected');
    expect(selectSessionSlice(result.success, 'sorted array')).toEqual([]);
  });
});

describe('selectCandidates', () => {
  it('returns the k closest propositions of the slice', () => {
    const graph = graphOf({
      p1: 'Binary search needs a sorted array.',
      p2: 'Binary search halves the interval.',
      p3: 'A sorted array allows binary search.',
    });
    const slice = selectSessionSlice(graph, 'binary search sorted array');
    expect(
      selectCandidates(slice, 'Binary search requires sorted input.', 2).map(
        (p) => p.propositionId,
      ),
    ).toEqual(['p1', 'p3']);
  });
});

describe('sessionQueryText', () => {
  it('joins the topic, the plan steps and the assessment', () => {
    const profile = {
      id: 'p',
      language: 'en',
      maxProbeQuestions: 3,
      maxTurnsPerStep: 4,
      prompts: { prober: 'p', teacher: 't', sideChat: 's' },
    };
    const log: DomainEvent[] = [
      { _tag: 'SessionCreated', id: 'e1', at: 1, sessionId: 's1', topic: 'Binary search', profile },
      { _tag: 'TurnStarted', id: 'e2', at: 2, turnId: 't1', input: '' },
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
        plan: {
          nodes: [{ id: 'n1', title: 'Halving', goal: 'Halve the interval', dependsOn: [] }],
        },
      },
      { _tag: 'TurnCompleted', id: 'e5', at: 5, turnId: 't1', reason: 'stop' },
    ];
    const session = projectSession(log);
    if (Result.isFailure(session)) throw new Error(session.failure.message);
    expect(sessionQueryText(session.success)).toBe(
      'Binary search\nHalving\nHalve the interval\nKnows arrays.\nSorting',
    );
  });
});
