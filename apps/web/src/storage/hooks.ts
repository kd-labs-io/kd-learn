// React hooks over the storage port: read once, re-read when a commit touches what is shown
// (this tab or another one). Plain React and Effect, no query library (TanStack DB was rejected
// for phase 1, plan 2.4).
import { Effect, Stream, type Result } from 'effect';
import { projectSession, type EventLog, type ProjectionError, type Session } from '@kd-learn/core';
import type {
  GuestSettings,
  SessionSummary,
  StorageChange,
  StorageError,
  StorageService,
} from '@kd-learn/storage/port';
import { useEffect, useState, type DependencyList } from 'react';
import { getStorage } from './client';

export type StorageQuery<A> =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly data: A }
  | { readonly status: 'error'; readonly error: StorageError };

/**
 * Runs `read` now and again after every change for which `relevant` is true. Keeps the previous
 * data while it reloads, so the screen does not flash.
 */
export function useStorageQuery<A>(
  read: (storage: StorageService) => Effect.Effect<A, StorageError>,
  relevant: (change: StorageChange) => boolean,
  deps: DependencyList,
): StorageQuery<A> {
  const [state, setState] = useState<StorageQuery<A>>({ status: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    const load = (storage: StorageService) =>
      read(storage).pipe(
        Effect.match({
          onSuccess: (data) => {
            if (!signal.aborted) setState({ status: 'ready', data });
          },
          onFailure: (error) => {
            if (!signal.aborted) setState({ status: 'error', error });
          },
        }),
      );
    void getStorage().then((storage) => {
      if (signal.aborted) return;
      // Subscribe first, then load, so a commit between the two is not missed.
      void Effect.runPromise(
        Stream.runForEach(storage.changes.pipe(Stream.filter(relevant)), () => load(storage)),
        { signal },
      ).catch(() => undefined);
      void Effect.runPromise(load(storage), { signal }).catch(() => undefined);
    });
    return () => controller.abort();
  }, deps);

  return state;
}

export const useSessionList = (): StorageQuery<ReadonlyArray<SessionSummary>> =>
  useStorageQuery(
    (storage) => storage.listSessions,
    (change) => change._tag === 'SessionChanged',
    [],
  );

export interface SessionView {
  readonly log: EventLog;
  /** Projection of `log` with the `core` rules. A failure means the log breaks them. */
  readonly session: Result.Result<Session, ProjectionError>;
}

export const useSession = (sessionId: string): StorageQuery<SessionView> =>
  useStorageQuery(
    (storage) =>
      storage
        .readSession(sessionId)
        .pipe(Effect.map((log): SessionView => ({ log, session: projectSession(log) }))),
    (change) => change._tag === 'SessionChanged' && change.sessionId === sessionId,
    [sessionId],
  );

export const useGuestSettings = (): StorageQuery<GuestSettings | undefined> =>
  useStorageQuery(
    (storage) => storage.getSettings,
    (change) => change._tag === 'SettingsChanged',
    [],
  );
