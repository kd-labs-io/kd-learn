// The guest practice flow against a scripted practice server and the memory storage.
import { Effect, Result } from 'effect';
import { describe, expect, it } from 'vitest';
import type { GradeAnswerRequest, IssueExercisesRequest } from '@kd-learn/api';
import {
  exerciseTypeIds,
  projectKnowledge,
  selectExercises,
  type ExerciseContent,
  type KnowledgeEvent,
  type KnowledgeGraph,
} from '@kd-learn/core';
import { makeMemoryStorage } from '@kd-learn/storage/memory';
import type { StorageService } from '@kd-learn/storage/port';
import { practiceSeed } from './fixtures';
import { makeGuestPractice, openPractice, sliceFor } from './guest-practice';

type Request = IssueExercisesRequest | GradeAnswerRequest;

/** Writes each target as the Practitioner would, with the right option last. */
const contentOf = (
  graph: KnowledgeGraph,
  target: IssueExercisesRequest['targets'][number],
): ExerciseContent => {
  const text = (id: string) => graph.propositions[id]?.text ?? id;
  switch (target.type) {
    case 'multipleChoice':
      return {
        type: 'multipleChoice',
        question: 'Which?',
        options: ['w1', 'w2', 'w3', 'right'],
        correctIndex: 3,
      };
    case 'orderChain': {
      const items = target.propositionIds.map((propositionId) => ({
        propositionId,
        text: text(propositionId),
      }));
      return {
        type: 'orderChain',
        items: [...items].reverse(),
        constraints: target.propositionIds
          .slice(1)
          .map((after, i) => ({ before: target.propositionIds[i]!, after })),
      };
    }
    default:
      return {
        type: target.type,
        question: 'Why?',
        reference: {
          propositions: target.propositionIds.map((propositionId) => ({
            propositionId,
            text: text(propositionId),
          })),
          edges: [],
        },
      };
  }
};

const server = (options: { failGrade?: () => boolean } = {}) => {
  const requests: Array<{ path: string; body: Request }> = [];
  let n = 0;
  const fetch = (async (url: string, init: RequestInit) => {
    const path = new URL(url, 'http://kd.test').pathname;
    const body = JSON.parse(String(init.body)) as Request;
    requests.push({ path, body });
    if (path === '/api/practice/issue') {
      const issue = body as IssueExercisesRequest;
      const graph: KnowledgeGraph = {
        ...(Result.getOrThrow(projectKnowledge([])) as KnowledgeGraph),
        propositions: Object.fromEntries(
          issue.slice.propositions.map((p) => [
            p.propositionId,
            { ...p, topic: '', sources: [], addedAt: 0, updatedAt: 0 },
          ]),
        ),
      };
      const practiceId = `pr${++n}`;
      const events: KnowledgeEvent[] = [
        { _tag: 'PracticeStarted', id: `${practiceId}-s`, at: 100, practiceId },
        ...issue.targets.map((target, i): KnowledgeEvent => ({
          _tag: 'ExerciseIssued',
          id: `${practiceId}-e${i}`,
          at: 100,
          practiceId,
          exerciseId: `${practiceId}-x${i}`,
          type: target.type,
          propositionIds: target.propositionIds as [string, ...string[]],
          edgeIds: target.edgeIds,
          content: contentOf(graph, target),
        })),
      ];
      return Response.json({ events });
    }
    const grade = body as GradeAnswerRequest;
    if (options.failGrade?.()) {
      return Response.json(
        { error: { code: 'ProviderError', message: 'down', retryable: true } },
        { status: 502 },
      );
    }
    return Response.json({
      events: [
        {
          _tag: 'ExerciseGraded',
          id: `g-${grade.exerciseId}`,
          at: 200,
          exerciseId: grade.exerciseId,
          score: 0.5,
          feedback: 'Partly.',
          profileId: 'default',
        },
      ],
    });
  }) as typeof globalThis.fetch;
  return { fetch, requests };
};

const setup = async (
  fetch: typeof globalThis.fetch,
  options: { demo?: boolean; key?: boolean } = {},
) => {
  const storage: StorageService = makeMemoryStorage();
  if (options.key !== false) {
    await Effect.runPromise(
      storage.saveSettings({ provider: 'anthropic', model: 'claude-test', apiKey: 'sk-test-key' }),
    );
  }
  await Effect.runPromise(storage.appendKnowledge(practiceSeed(1), { expectedLastSeq: -1 }));
  let n = 0;
  const practice = makeGuestPractice({
    storage: async () => storage,
    fetch,
    language: () => 'vi',
    newId: () => `id${++n}`,
    now: () => 1_000,
    demo: () => options.demo === true,
  });
  const graph = async () =>
    Result.getOrThrow(projectKnowledge(await Effect.runPromise(storage.readKnowledge)));
  return { storage, practice, graph };
};

describe('guest practice', () => {
  it('the seed issues one exercise of each type', async () => {
    const graph = Result.getOrThrow(projectKnowledge(practiceSeed(1)));
    const types = selectExercises(graph, { now: 1_000, count: 5, types: exerciseTypeIds }).map(
      (t) => t.type,
    );
    expect([...types].sort()).toEqual([...exerciseTypeIds].sort());
  });

  it('sends the slice the targets need and appends the batch', async () => {
    const s = server();
    const t = await setup(s.fetch);
    const graph = await t.graph();
    const practiceId = await t.practice.start(exerciseTypeIds);
    const issue = s.requests[0]!.body as IssueExercisesRequest;
    expect(s.requests[0]!.path).toBe('/api/practice/issue');
    expect(issue.model).toMatchObject({ provider: 'anthropic', apiKey: 'sk-test-key' });
    expect(issue.profile.language).toBe('vi');
    expect(issue.slice).toEqual(
      sliceFor(graph, selectExercises(graph, { now: 1_000, count: 5, types: exerciseTypeIds })),
    );
    for (const target of issue.targets) {
      for (const id of target.propositionIds) {
        expect(issue.slice.propositions.map((p) => p.propositionId)).toContain(id);
      }
    }
    const after = await t.graph();
    expect(openPractice(after)?.practiceId).toBe(practiceId);
    expect(after.practices[practiceId]!.exerciseIds).toHaveLength(issue.targets.length);

    // An open practice is resumed, not doubled.
    expect(await t.practice.start(exerciseTypeIds)).toBe(practiceId);
    expect(s.requests).toHaveLength(1);
  });

  it('grades code types locally in one batch, and model types through the server', async () => {
    const s = server();
    const t = await setup(s.fetch);
    const practiceId = await t.practice.start(exerciseTypeIds);
    const exercises = (await t.graph()).practices[practiceId]!.exerciseIds.map(
      (id) => [id, (async () => (await t.graph()).exercises[id]!)()] as const,
    );
    for (const [id, pending] of exercises) {
      const exercise = await pending;
      switch (exercise.content.type) {
        case 'multipleChoice':
          await t.practice.answer(id, { type: 'multipleChoice', choice: 3 });
          break;
        case 'orderChain':
          await t.practice.answer(id, {
            type: 'orderChain',
            order: exercise.propositionIds.slice(),
          });
          break;
        default:
          await t.practice.answer(id, { type: exercise.content.type, text: 'Because.' });
      }
    }
    const graph = await t.graph();
    const grades = Object.fromEntries(
      Object.values(graph.exercises).map((e) => [e.type, e.grade?.score]),
    );
    expect(grades).toEqual({
      multipleChoice: 1,
      orderChain: 1,
      shortAnswer: 0.5,
      explainReasoning: 0.5,
    });
    // Only the two model-graded answers reached the server.
    expect(s.requests.filter((r) => r.path === '/api/practice/grade')).toHaveLength(2);
    // Mastery follows the grades (A7).
    const mc = Object.values(graph.exercises).find((e) => e.type === 'multipleChoice')!;
    expect(graph.mastery[mc.propositionIds[0]!]).toMatchObject({ box: 2, attempts: 1 });

    await t.practice.end(practiceId);
    await t.practice.end(practiceId);
    expect(openPractice(await t.graph())).toBeUndefined();
  });

  it('keeps the answer when the grade fails, and grades it on retry', async () => {
    let fail = true;
    const s = server({ failGrade: () => fail });
    const t = await setup(s.fetch);
    const practiceId = await t.practice.start(['shortAnswer']);
    const id = (await t.graph()).practices[practiceId]!.exerciseIds[0]!;
    await expect(
      t.practice.answer(id, { type: 'shortAnswer', text: 'Because.' }),
    ).rejects.toMatchObject({ code: 'ProviderError' });
    const answered = (await t.graph()).exercises[id]!;
    expect(answered.answer).toEqual({ type: 'shortAnswer', text: 'Because.' });
    expect(answered.grade).toBeUndefined();
    fail = false;
    await t.practice.grade(id);
    expect((await t.graph()).exercises[id]!.grade).toMatchObject({ score: 0.5 });
    // Graded once: grading again sends nothing.
    await t.practice.grade(id);
    expect(s.requests.filter((r) => r.path === '/api/practice/grade')).toHaveLength(2);
  });

  it('demo sends the demo model and the default profile; no key, no request', async () => {
    const s = server();
    const demo = await setup(s.fetch, { demo: true, key: false });
    await demo.practice.start(exerciseTypeIds);
    const issue = s.requests[0]!.body as IssueExercisesRequest;
    expect(issue.model).toEqual({ provider: 'demo' });
    expect(issue.profile).toMatchObject({ id: 'default', language: 'vi' });

    const none = await setup(s.fetch, { key: false });
    await expect(none.practice.start(exerciseTypeIds)).rejects.toMatchObject({ code: 'NoKey' });
    expect(s.requests).toHaveLength(1);
  });

  it('refuses to start on an empty graph without a request', async () => {
    const s = server();
    const storage = makeMemoryStorage();
    await Effect.runPromise(
      storage.saveSettings({ provider: 'anthropic', model: 'm', apiKey: 'sk-test-key' }),
    );
    const practice = makeGuestPractice({
      storage: async () => storage,
      fetch: s.fetch,
      language: () => 'en',
    });
    await expect(practice.start(exerciseTypeIds)).rejects.toMatchObject({ code: 'NothingToRun' });
    expect(s.requests).toHaveLength(0);
  });
});
