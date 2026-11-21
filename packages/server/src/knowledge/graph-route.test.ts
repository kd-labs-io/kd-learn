// `/api/account/knowledge` (phase 3 A9): the graph without exercises, and retiring a proposition.
import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import type { KnowledgeEvent } from '@kd-learn/core';
import {
  makeServerStorage,
  openServerDatabase,
  type ServerDatabase,
} from '@kd-learn/storage/sqlite-node';
import { make } from '../auth/test-support.ts';
import type { Handlers } from '../index.ts';

const request = (
  handler: Handlers[keyof Handlers],
  method: string,
  path: string,
  token?: string,
  body?: unknown,
) =>
  handler(
    new Request(`http://kd.test${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );

const graphLog: ReadonlyArray<KnowledgeEvent> = [
  {
    _tag: 'PropositionAdded',
    id: 'e1',
    at: 1,
    propositionId: 'a',
    text: 'Binary search needs a sorted array.',
    topic: 'Search',
    source: { sessionId: 's1' },
  },
  {
    _tag: 'PropositionAdded',
    id: 'e2',
    at: 2,
    propositionId: 'b:2 ü',
    text: 'Binary search halves the interval each step.',
    topic: 'Search',
    source: { sessionId: 's1' },
  },
  {
    _tag: 'EdgeAdded',
    id: 'e3',
    at: 3,
    edgeId: 'ab',
    from: 'b:2 ü',
    to: 'a',
    relation: 'requires',
    label: 'needs order',
  },
  { _tag: 'PracticeStarted', id: 'e4', at: 4, practiceId: 'p1' },
  {
    _tag: 'ExerciseIssued',
    id: 'e5',
    at: 5,
    practiceId: 'p1',
    exerciseId: 'x1',
    type: 'multipleChoice',
    propositionIds: ['a'],
    edgeIds: [],
    content: {
      type: 'multipleChoice',
      question: 'What does binary search need?',
      options: ['A sorted array', 'A hash table'],
      correctIndex: 0,
    },
  },
  {
    _tag: 'AnswerSubmitted',
    id: 'e6',
    at: 6,
    exerciseId: 'x1',
    answer: { type: 'multipleChoice', choice: 0 },
  },
  { _tag: 'ExerciseGraded', id: 'e7', at: 7, exerciseId: 'x1', score: 1, feedback: 'Right.' },
];

const setup = async () => {
  const database: ServerDatabase = Effect.runSync(openServerDatabase({ path: ':memory:' }));
  const { handlers, logs } = make({}, { database });
  const signUp = async (email: string) =>
    (await (
      await request(handlers.register, 'POST', '/api/auth/register', undefined, {
        email,
        password: 'password-123',
      })
    ).json()) as { token: string; user: { id: string } };
  const a = await signUp('a@kd.test');
  const b = await signUp('b@kd.test');
  const storage = makeServerStorage(database).forUser(a.user.id);
  Effect.runSync(storage.appendKnowledge(graphLog, { expectedLastSeq: -1 }));
  const account = (method: string, path: string, token = a.token) =>
    request(handlers.account, method, `/api/account/${path}`, token);
  return { account, other: b.token, logs, storage };
};

describe('account knowledge graph', () => {
  it('answers propositions with mastery and edges, and nothing about exercises', async () => {
    const t = await setup();
    const response = await t.account('GET', 'knowledge');
    expect(response.status).toBe(200);
    const text = await response.text();
    const body = JSON.parse(text) as {
      propositions: Array<{ propositionId: string; mastery?: { box: number } }>;
      edges: Array<{ edgeId: string }>;
    };
    // Newest first.
    expect(body.propositions.map((p) => p.propositionId)).toEqual(['b:2 ü', 'a']);
    expect(body.propositions[1]!.mastery).toMatchObject({ box: 2, attempts: 1 });
    expect(body.propositions[0]).not.toHaveProperty('mastery');
    expect(body.edges).toEqual([
      { edgeId: 'ab', from: 'b:2 ü', to: 'a', relation: 'requires', label: 'needs order' },
    ]);
    for (const leak of ['correctIndex', 'A hash table', 'x1', 'p1', 'exercise']) {
      expect(text).not.toContain(leak);
    }
  });

  it('retires a proposition, which drops its edges; an unknown one is 404', async () => {
    const t = await setup();
    const retired = await t.account('POST', 'knowledge/propositions/a/retire');
    expect(retired.status).toBe(200);
    const body = (await retired.json()) as {
      propositions: Array<{ propositionId: string }>;
      edges: unknown[];
    };
    expect(body.propositions.map((p) => p.propositionId)).toEqual(['b:2 ü']);
    expect(body.edges).toEqual([]);
    const tags = (Effect.runSync(t.storage.readKnowledge) as ReadonlyArray<KnowledgeEvent>).map(
      (e) => e._tag,
    );
    expect(tags.at(-1)).toBe('PropositionRetired');
    expect((await t.account('POST', 'knowledge/propositions/a/retire')).status).toBe(404);
    expect((await t.account('POST', 'knowledge/propositions/zz/retire')).status).toBe(404);
    expect((await t.account('GET', 'knowledge/propositions/a/retire')).status).toBe(405);
    const encoded = `knowledge/propositions/${encodeURIComponent('b:2 ü')}/retire`;
    expect((await t.account('POST', encoded)).status).toBe(200);
    expect((await t.account('POST', 'knowledge/propositions/%E0%A4%A/retire')).status).toBe(404);
  });

  it('keeps users apart and refuses without a token', async () => {
    const t = await setup();
    const other = (await (await t.account('GET', 'knowledge', t.other)).json()) as {
      propositions: unknown[];
    };
    expect(other.propositions).toEqual([]);
    expect((await t.account('POST', 'knowledge/propositions/a/retire', t.other)).status).toBe(404);
    const anonymous = await t.account('GET', 'knowledge', '');
    expect(anonymous.status).toBe(401);
  });
});
