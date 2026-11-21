import { Effect, Stream } from 'effect';
import { describe, expect, it } from 'vitest';
import type { DomainEvent } from '@kd-learn/core';
import type { StorageChange } from '../port/index.ts';
import { makeMemoryStorage } from './index.ts';

const turnStarted = (id: string, at: number): DomainEvent => ({
  _tag: 'TurnStarted',
  id,
  at,
  turnId: `turn-${id}`,
  input: 'hello',
});

describe('memory storage', () => {
  it('reads back what was appended, in order', async () => {
    const storage = makeMemoryStorage();
    await Effect.runPromise(storage.appendEvents('s1', [turnStarted('a', 1), turnStarted('b', 2)]));
    const result = await Effect.runPromise(storage.appendEvents('s1', [turnStarted('c', 3)]));
    expect(result.lastSeq).toBe(2);
    const log = await Effect.runPromise(storage.readSession('s1'));
    expect(log.map((event) => event.id)).toEqual(['a', 'b', 'c']);
    expect(await Effect.runPromise(storage.readSession('unknown'))).toEqual([]);
  });

  it('rejects a whole batch that contains a duplicate id', async () => {
    const storage = makeMemoryStorage();
    await Effect.runPromise(storage.appendEvents('s1', [turnStarted('a', 1)]));
    const exit = await Effect.runPromiseExit(
      storage.appendEvents('s1', [turnStarted('b', 2), turnStarted('a', 3)]),
    );
    expect(exit._tag).toBe('Failure');
    const log = await Effect.runPromise(storage.readSession('s1'));
    expect(log.map((event) => event.id)).toEqual(['a']);
  });

  it('lists sessions, newest activity first, with the topic', async () => {
    const storage = makeMemoryStorage();
    const created = (sessionId: string, topic: string, at: number): DomainEvent => ({
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
    await Effect.runPromise(storage.appendEvents('old', [created('old', 'Fractions', 10)]));
    await Effect.runPromise(storage.appendEvents('new', [created('new', 'Graphs', 20)]));
    const list = await Effect.runPromise(storage.listSessions);
    expect(list.map((row) => [row.sessionId, row.topic])).toEqual([
      ['new', 'Graphs'],
      ['old', 'Fractions'],
    ]);
  });

  it('saves settings and deletes only the key', async () => {
    const storage = makeMemoryStorage();
    expect(await Effect.runPromise(storage.getSettings)).toBeUndefined();
    await Effect.runPromise(
      storage.saveSettings({ provider: 'anthropic', model: 'haiku', apiKey: 'secret' }),
    );
    await Effect.runPromise(storage.deleteApiKey);
    expect(await Effect.runPromise(storage.getSettings)).toEqual({
      provider: 'anthropic',
      model: 'haiku',
    });
  });

  it('announces commits to subscribers', async () => {
    const storage = makeMemoryStorage();
    const seen = Effect.runPromise(
      storage.changes.pipe(Stream.take(1), Stream.runCollect),
    ) as Promise<ReadonlyArray<StorageChange>>;
    // Let the subscriber register before writing.
    await new Promise((resolve) => setTimeout(resolve, 10));
    await Effect.runPromise(storage.appendEvents('s1', [turnStarted('a', 1)]));
    expect(await seen).toEqual([{ _tag: 'SessionChanged', sessionId: 's1' }]);
  });
});
