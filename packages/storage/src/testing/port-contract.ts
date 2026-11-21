// Behaviour every driver of the storage port must have (plan step 1: run the port suite on each
// driver). Imported by each driver's test file; not a test file itself.
import { Effect, Stream } from 'effect';
import { describe, expect, it } from 'vitest';
import type { DomainEvent } from '@kd-learn/core';
import type { StorageChange, StorageService } from '../port/index.ts';

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
  });
