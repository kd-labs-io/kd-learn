// Behaviour every driver of the storage port must have (plan step 1: run the port suite on each
// driver). Imported by each driver's test file; not a test file itself.
import { Effect, Stream } from 'effect';
import { describe, expect, it } from 'vitest';
import {
  MAX_PROMPT_LENGTH,
  type DomainEvent,
  type KnowledgeEvent,
  type SavedProfile,
} from '@kd-learn/core';
import { appendKnowledgeChecked, type StorageChange, type StorageService } from '../port/index.ts';

export const turnStarted = (id: string, at: number): DomainEvent => ({
  _tag: 'TurnStarted',
  id,
  at,
  turnId: `turn-${id}`,
  input: 'hello',
});

export const sessionCreated = (sessionId: string, topic: string, at: number): DomainEvent => ({
  _tag: 'SessionCreated',
  id: `created-${sessionId}`,
  at,
  sessionId,
  topic,
  profile: {
    id: 'p',
    language: 'en',
    maxProbeQuestions: 3,
    maxTurnsPerStep: 4,
    prompts: { prober: 'p', teacher: 't', sideChat: 's' },
  },
});

export const savedProfile: SavedProfile = {
  id: 'mine',
  language: 'vi',
  maxProbeQuestions: 3,
  maxTurnsPerStep: 4,
  prompts: { prober: 'p', teacher: 't', sideChat: 's', merge: 'm' },
};
export const propositionAdded = (id: string, at: number): KnowledgeEvent => ({
  _tag: 'PropositionAdded',
  id,
  at,
  propositionId: `prop-${id}`,
  text: `Claim ${id}.`,
  topic: 'Search',
  source: { sessionId: 's1' },
});

export const portContract = (name: string, make: () => StorageService) =>
  describe(`${name}: storage port contract`, () => {
    it('reads back what was appended, in order', async () => {
      const storage = make();
      await Effect.runPromise(
        storage.appendEvents('s1', [turnStarted('a', 1), turnStarted('b', 2)]),
      );
      const result = await Effect.runPromise(storage.appendEvents('s1', [turnStarted('c', 3)]));
      expect(result.lastSeq).toBe(2);
      const log = await Effect.runPromise(storage.readSession('s1'));
      expect(log.map((event) => event.id)).toEqual(['a', 'b', 'c']);
      expect(await Effect.runPromise(storage.readSession('unknown'))).toEqual([]);
    });

    it('reports the end of the log for an empty batch', async () => {
      const storage = make();
      expect((await Effect.runPromise(storage.appendEvents('s1', []))).lastSeq).toBe(-1);
      await Effect.runPromise(storage.appendEvents('s1', [turnStarted('a', 1)]));
      expect((await Effect.runPromise(storage.appendEvents('s1', []))).lastSeq).toBe(0);
    });

    it('rejects a whole batch that contains a duplicate id', async () => {
      const storage = make();
      await Effect.runPromise(storage.appendEvents('s1', [turnStarted('a', 1)]));
      const exit = await Effect.runPromiseExit(
        storage.appendEvents('s1', [turnStarted('b', 2), turnStarted('a', 3)]),
      );
      expect(exit._tag).toBe('Failure');
      const log = await Effect.runPromise(storage.readSession('s1'));
      expect(log.map((event) => event.id)).toEqual(['a']);
    });

    it('lists sessions, newest activity first, with the topic', async () => {
      const storage = make();
      await Effect.runPromise(
        storage.appendEvents('old', [sessionCreated('old', 'Fractions', 10)]),
      );
      await Effect.runPromise(storage.appendEvents('new', [sessionCreated('new', 'Graphs', 20)]));
      const list = await Effect.runPromise(storage.listSessions);
      expect(list.map((row) => [row.sessionId, row.topic, row.eventCount])).toEqual([
        ['new', 'Graphs', 1],
        ['old', 'Fractions', 1],
      ]);
    });

    it('saves, replaces and resets the teaching profile', async () => {
      const storage = make();
      expect(await Effect.runPromise(storage.getProfile)).toBeUndefined();
      const mine = { ...savedProfile, name: 'Mine' };
      await Effect.runPromise(storage.saveProfile(mine));
      expect(await Effect.runPromise(storage.getProfile)).toEqual(mine);
      const next = { ...mine, maxTurnsPerStep: 9 };
      await Effect.runPromise(storage.saveProfile(next));
      expect(await Effect.runPromise(storage.getProfile)).toEqual(next);
      await Effect.runPromise(storage.saveProfile(undefined));
      expect(await Effect.runPromise(storage.getProfile)).toBeUndefined();
    });

    it('rejects a profile outside the saving limits and keeps the old one', async () => {
      const storage = make();
      await Effect.runPromise(storage.saveProfile(savedProfile));
      const tooLong = {
        ...savedProfile,
        prompts: { ...savedProfile.prompts, teacher: 'x'.repeat(MAX_PROMPT_LENGTH + 1) },
      };
      const exit = await Effect.runPromiseExit(storage.saveProfile(tooLong));
      expect(exit._tag).toBe('Failure');
      expect(await Effect.runPromise(storage.getProfile)).toEqual(savedProfile);
    });

    it('announces a profile change', async () => {
      const storage = make();
      const seen = Effect.runPromise(
        storage.changes.pipe(Stream.take(1), Stream.runCollect),
      ) as Promise<ReadonlyArray<StorageChange>>;
      await new Promise((resolve) => setTimeout(resolve, 10));
      await Effect.runPromise(storage.saveProfile(savedProfile));
      expect(await seen).toEqual([{ _tag: 'ProfileChanged' }]);
    });

    it('announces commits to subscribers', async () => {
      const storage = make();
      const seen = Effect.runPromise(
        storage.changes.pipe(Stream.take(1), Stream.runCollect),
      ) as Promise<ReadonlyArray<StorageChange>>;
      // Let the subscriber register before writing.
      await new Promise((resolve) => setTimeout(resolve, 10));
      await Effect.runPromise(storage.appendEvents('s1', [turnStarted('a', 1)]));
      expect(await seen).toEqual([{ _tag: 'SessionChanged', sessionId: 's1' }]);
    });

    it('appends to the knowledge log and reads it back, in order', async () => {
      const storage = make();
      expect(await Effect.runPromise(storage.readKnowledge)).toEqual([]);
      const first = await Effect.runPromise(
        storage.appendKnowledge([propositionAdded('k1', 1), propositionAdded('k2', 2)], {
          expectedLastSeq: -1,
        }),
      );
      expect(first.lastSeq).toBe(1);
      const next = await Effect.runPromise(
        storage.appendKnowledge([propositionAdded('k3', 3)], { expectedLastSeq: 1 }),
      );
      expect(next.lastSeq).toBe(2);
      expect(
        (await Effect.runPromise(storage.appendKnowledge([], { expectedLastSeq: 2 }))).lastSeq,
      ).toBe(2);
      const log = await Effect.runPromise(storage.readKnowledge);
      expect(log).toEqual([
        propositionAdded('k1', 1),
        propositionAdded('k2', 2),
        propositionAdded('k3', 3),
      ]);
      // The session log is a separate log.
      expect(await Effect.runPromise(storage.readSession('s1'))).toEqual([]);
    });

    it('rejects a whole knowledge batch that contains a duplicate id', async () => {
      const storage = make();
      await Effect.runPromise(
        storage.appendKnowledge([propositionAdded('k1', 1)], { expectedLastSeq: -1 }),
      );
      const exit = await Effect.runPromiseExit(
        storage.appendKnowledge([propositionAdded('k2', 2), propositionAdded('k1', 3)], {
          expectedLastSeq: 0,
        }),
      );
      expect(exit._tag).toBe('Failure');
      expect((await Effect.runPromise(storage.readKnowledge)).map((e) => e.id)).toEqual(['k1']);
    });

    it('writes a knowledge batch only when the log still ends at the expected seq', async () => {
      const storage = make();
      // Two writers read the empty log (last seq -1) and both try to append.
      const first = await Effect.runPromise(
        storage.appendKnowledge([propositionAdded('a', 1)], { expectedLastSeq: -1 }),
      );
      expect(first.lastSeq).toBe(0);
      const second = await Effect.runPromise(
        Effect.flip(storage.appendKnowledge([propositionAdded('b', 2)], { expectedLastSeq: -1 })),
      );
      expect(second).toMatchObject({ _tag: 'KnowledgeConflict', expectedLastSeq: -1, lastSeq: 0 });
      expect((await Effect.runPromise(storage.readKnowledge)).map((e) => e.id)).toEqual(['a']);
      // After reading again it goes through.
      await Effect.runPromise(
        storage.appendKnowledge([propositionAdded('b', 2)], { expectedLastSeq: 0 }),
      );
      expect((await Effect.runPromise(storage.readKnowledge)).map((e) => e.id)).toEqual(['a', 'b']);
    });

    it('announces knowledge commits to subscribers', async () => {
      const storage = make();
      const seen = Effect.runPromise(
        storage.changes.pipe(Stream.take(1), Stream.runCollect),
      ) as Promise<ReadonlyArray<StorageChange>>;
      await new Promise((resolve) => setTimeout(resolve, 10));
      await Effect.runPromise(
        storage.appendKnowledge([propositionAdded('a', 1)], { expectedLastSeq: -1 }),
      );
      expect(await seen).toEqual([{ _tag: 'KnowledgeChanged' }]);
    });

    it('checked append: builds from the current graph and refuses a batch that does not project', async () => {
      const storage = make();
      const extraction = (extractionId: string): KnowledgeEvent[] => [
        {
          _tag: 'ExtractionStarted',
          id: `${extractionId}-s`,
          at: 1,
          sessionId: 's1',
          extractionId,
        },
        propositionAdded(`${extractionId}-p`, 2),
        {
          _tag: 'SessionExtracted',
          id: `${extractionId}-e`,
          at: 3,
          sessionId: 's1',
          extractionId,
          profileId: 'default',
        },
      ];
      const first = await Effect.runPromise(
        appendKnowledgeChecked(storage, () => extraction('x1')),
      );
      expect(first.lastSeq).toBe(2);
      expect(first.graph.extractions.s1?.extractedBy).toBe('x1');
      // A second extraction of the same session is refused as a whole, and writes nothing.
      const second = await Effect.runPromise(
        Effect.flip(appendKnowledgeChecked(storage, () => extraction('x2'))),
      );
      expect(second).toMatchObject({ _tag: 'KnowledgeRejected', index: 0 });
      expect(await Effect.runPromise(storage.readKnowledge)).toHaveLength(3);
    });

    it('checked append: reads again and rebuilds when another writer got in first', async () => {
      const storage = make();
      let builds = 0;
      const result = await Effect.runPromise(
        appendKnowledgeChecked(storage, (graph) => {
          builds += 1;
          if (builds === 1) {
            // Another writer appends between this read and the append. `runSync` works because the
            // contract runs on the synchronous drivers (memory, sqlite-node).
            Effect.runSync(
              Effect.ignore(
                storage.appendKnowledge([propositionAdded('other', 1)], { expectedLastSeq: -1 }),
              ),
            );
          }
          return [propositionAdded(`mine-${Object.keys(graph.propositions).length}`, 2)];
        }),
      );
      expect(builds).toBe(2);
      expect(result.lastSeq).toBe(1);
      // The rebuilt batch saw the other writer's proposition.
      expect((await Effect.runPromise(storage.readKnowledge)).map((e) => e.id)).toEqual([
        'other',
        'mine-1',
      ]);
    });
  });
