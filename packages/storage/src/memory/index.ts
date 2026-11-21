// In-memory driver: tests, and the fallback when OPFS is not available (private windows, some
// WebKit contexts). `persistent` is false so the UI can warn that nothing survives a reload.
import { Effect, Queue, Stream } from 'effect';
import type { DomainEvent } from '@kd-learn/core';
import {
  StorageFailure,
  type GuestSettings,
  type SessionSummary,
  type StorageChange,
  type StorageService,
} from '../port/index.ts';

export const makeMemoryStorage = (): StorageService => {
  const sessions = new Map<string, DomainEvent[]>();
  const eventIds = new Set<string>();
  let settings: GuestSettings | undefined;
  const listeners = new Set<(change: StorageChange) => void>();
  const emit = (change: StorageChange) => listeners.forEach((listener) => listener(change));

  return {
    persistent: false,

    appendEvents: (sessionId, events) =>
      Effect.suspend(() => {
        // Validate the whole batch before touching state: all or none.
        const batchIds = new Set<string>();
        for (const event of events) {
          if (eventIds.has(event.id) || batchIds.has(event.id)) {
            return Effect.fail(new StorageFailure({ message: `Duplicate event id ${event.id}` }));
          }
          batchIds.add(event.id);
        }
        const log = sessions.get(sessionId) ?? [];
        log.push(...events);
        sessions.set(sessionId, log);
        batchIds.forEach((id) => eventIds.add(id));
        if (events.length > 0) emit({ _tag: 'SessionChanged', sessionId });
        return Effect.succeed({ lastSeq: log.length - 1 });
      }),

    readSession: (sessionId) => Effect.sync(() => [...(sessions.get(sessionId) ?? [])]),

    listSessions: Effect.sync(() => {
      const rows: SessionSummary[] = [];
      for (const [sessionId, log] of sessions) {
        const first = log[0];
        const last = log[log.length - 1];
        if (!first || !last) continue;
        const created = log.find((event) => event._tag === 'SessionCreated');
        rows.push({
          sessionId,
          topic: created?.topic ?? '',
          createdAt: first.at,
          updatedAt: last.at,
          eventCount: log.length,
        });
      }
      return rows.sort((a, b) => b.updatedAt - a.updatedAt);
    }),

    getSettings: Effect.sync(() => settings),

    saveSettings: (next) =>
      Effect.sync(() => {
        settings = next;
        emit({ _tag: 'SettingsChanged' });
      }),

    deleteApiKey: Effect.sync(() => {
      if (settings) {
        const { apiKey: _apiKey, ...rest } = settings;
        settings = rest;
      }
      emit({ _tag: 'SettingsChanged' });
    }),

    changes: Stream.callback<StorageChange>((queue) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const listener = (change: StorageChange) => void Queue.offerUnsafe(queue, change);
          listeners.add(listener);
          return listener;
        }),
        (listener) => Effect.sync(() => void listeners.delete(listener)),
      ),
    ),
  };
};
