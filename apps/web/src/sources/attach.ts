// Attach and detach sources of a local session (guest, demo; phase 4 A2). Under the turn lock of
// the session, like the server's refusal while a turn runs: a turn reads its sources when it
// starts, and two tabs cannot attach the same source twice (a log that would break the rules).
import { Effect, Result } from 'effect';
import { projectSession, type DomainEvent } from '@kd-learn/core';
import type { StorageService } from '@kd-learn/storage/port';
import { turnLockName, withLock, type WithLock } from '../learn/locks';

export interface SourceChange {
  readonly attach: ReadonlyArray<string>;
  readonly detach: ReadonlyArray<string>;
}

export type SetSourcesResult = 'ok' | 'busy' | 'notFound' | 'invalid';

export const setLocalSessionSources = async (
  storage: StorageService,
  sessionId: string,
  change: SourceChange,
  lock: WithLock = withLock,
): Promise<SetSourcesResult> => {
  const outcome = await lock(turnLockName(sessionId), async (): Promise<SetSourcesResult> => {
    const log = await Effect.runPromise(storage.readSession(sessionId));
    if (log.length === 0) return 'notFound';
    const projected = projectSession(log);
    if (Result.isFailure(projected)) return 'invalid';
    const current = new Set(projected.success.sources.map((s) => s.sourceId));
    const detach = [...new Set(change.detach)].filter((id) => current.has(id));
    const attach = [...new Set(change.attach)].filter(
      (id) => !current.has(id) && !detach.includes(id),
    );
    const at = Date.now();
    const batch: DomainEvent[] = detach.map((sourceId) => ({
      _tag: 'SourceDetached',
      id: crypto.randomUUID(),
      at,
      sourceId,
    }));
    for (const sourceId of attach) {
      const info = await Effect.runPromise(storage.getSource(sourceId));
      if (info === undefined || info.state !== 'ready') return 'notFound';
      batch.push({
        _tag: 'SourceAttached',
        id: crypto.randomUUID(),
        at,
        sourceId,
        title: info.title,
        kind: info.kind,
      });
    }
    if (batch.length === 0) return 'ok';
    if (Result.isFailure(projectSession([...log, ...batch]))) return 'invalid';
    await Effect.runPromise(storage.appendEvents(sessionId, batch));
    return 'ok';
  });
  return outcome.acquired ? outcome.value : 'busy';
};

/** Waits until a turn ends, then attaches (a research that ends while the lesson runs). */
export const attachWhenIdle = async (
  storage: StorageService,
  sessionId: string,
  sourceIds: ReadonlyArray<string>,
  tries = 150,
): Promise<SetSourcesResult> => {
  for (let i = 0; i < tries; i++) {
    const result = await setLocalSessionSources(storage, sessionId, {
      attach: sourceIds,
      detach: [],
    });
    if (result !== 'busy') return result;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return 'busy';
};
