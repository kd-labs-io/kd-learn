// Durable background jobs of accounts (phase 4 A1). A job is a row in `jobs` while it has work
// left; the runner deletes the row when the job ends, however it ends. Results never live here:
// every kind writes its result to the domain data (knowledge log, sources) in one final batch, so
// running a job again from the start is safe.
//
// After a restart, `resume` reads the rows the last process left. A `running` row was cut by the
// restart: it runs again, up to `maxAttempts` starts in all, then the kind's `abandon` closes it
// (the domain data shows "interrupted"). A restart is not a failure of the job; real failures
// (provider, key, invalid output, timeout) end the job and are never retried by the runner.
//
// One job of a kind runs at a time per user; `global` bounds a kind across users. Single
// instance only (risk 25).
import { Cause, Effect, Exit, Fiber, Schema } from 'effect';
import type { ServerDatabase } from '@kd-learn/storage/sqlite-node';
import type { Logger } from '../handler.ts';

export interface JobKind<P> {
  readonly kind: string;
  readonly payload: Schema.Codec<P, unknown>;
  /** Jobs of this kind running at once across users. Default: no bound. */
  readonly global?: number;
  /** Does the work and writes the result. Must not fail; interruption means the process stops. */
  readonly run: (userId: string, payload: P) => Effect.Effect<void>;
  /** A job cut by restarts `maxAttempts` times: write the domain end ("interrupted"). */
  readonly abandon: (userId: string, payload: P) => void;
}

export type JobState = 'queued' | 'running';

export interface JobRunner {
  readonly register: <P>(kind: JobKind<P>) => void;
  /** Persists and queues a job. False when a job with this key is already queued or running. */
  readonly enqueue: <P>(userId: string, kind: JobKind<P>, key: string, payload: P) => boolean;
  readonly state: (userId: string, kind: string, key: string) => JobState | undefined;
  /** Startup: takes over the rows of the last process. Call once, after every `register`. */
  readonly resume: () => void;
  /** Resolves when nothing is queued or running (for one user, or at all). Tests. */
  readonly idle: (userId?: string) => Promise<void>;
  /** Interrupts every running job and keeps the rows, as a process stop would. */
  readonly stopAll: () => Promise<void>;
}

export interface JobRunnerDeps {
  readonly database: ServerDatabase;
  readonly log: Logger;
  /** Starts of one job before it is abandoned. Default 3. */
  readonly maxAttempts?: number;
  readonly newId?: () => string;
  readonly now?: () => number;
}

interface Entry {
  readonly id: string;
  readonly userId: string;
  readonly kind: string;
  readonly key: string;
  readonly payload: unknown;
  fiber?: Fiber.Fiber<void>;
}

interface Row {
  readonly id: string;
  readonly user_id: string;
  readonly kind: string;
  readonly key: string;
  readonly payload: string;
  readonly state: JobState;
  readonly attempts: number;
}

export const makeJobRunner = (deps: JobRunnerDeps): JobRunner => {
  const { db, transaction } = deps.database;
  const maxAttempts = deps.maxAttempts ?? 3;
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const now = deps.now ?? Date.now;
  const kinds = new Map<string, JobKind<unknown>>();
  const waiting: Entry[] = [];
  const running: Entry[] = [];
  const idlers: Array<{ readonly userId?: string; readonly resolve: () => void }> = [];
  let stopping = false;

  const sql = {
    insert: db.prepare(
      `INSERT INTO jobs (id, user_id, kind, key, payload, state, attempts, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'queued', 0, ?, ?)`,
    ),
    start: db.prepare(
      `UPDATE jobs SET state = 'running', attempts = attempts + 1, updated_at = ? WHERE id = ?`,
    ),
    requeue: db.prepare(`UPDATE jobs SET state = 'queued', updated_at = ? WHERE id = ?`),
    remove: db.prepare('DELETE FROM jobs WHERE id = ?'),
    all: db.prepare('SELECT * FROM jobs ORDER BY created_at, rowid'),
  };

  const matches = (entry: Entry, userId: string, kind: string, key: string) =>
    entry.userId === userId && entry.kind === kind && entry.key === key;

  const settleIdlers = () => {
    for (let i = idlers.length - 1; i >= 0; i--) {
      const idler = idlers[i]!;
      const busy = [...waiting, ...running].some(
        (entry) => idler.userId === undefined || entry.userId === idler.userId,
      );
      if (!busy) {
        idlers.splice(i, 1);
        idler.resolve();
      }
    }
  };

  const canStart = (entry: Entry, kind: JobKind<unknown>) =>
    !running.some((r) => r.userId === entry.userId && r.kind === entry.kind) &&
    running.filter((r) => r.kind === entry.kind).length < (kind.global ?? Infinity);

  const pump = () => {
    if (stopping) return;
    for (let i = 0; i < waiting.length; ) {
      const entry = waiting[i]!;
      const kind = kinds.get(entry.kind);
      if (kind === undefined || !canStart(entry, kind)) {
        i++;
        continue;
      }
      waiting.splice(i, 1);
      running.push(entry);
      transaction(() => sql.start.run(now(), entry.id));
      entry.fiber = Effect.runFork(
        kind.run(entry.userId, entry.payload).pipe(
          Effect.onExit((exit) =>
            Effect.sync(() => {
              const at = running.indexOf(entry);
              if (at >= 0) running.splice(at, 1);
              // A process stop: the row stays `running`, the next start takes it over.
              if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)) return;
              if (Exit.isFailure(exit)) {
                deps.log({ event: 'jobs.crashed', fields: { kind: entry.kind } });
              }
              transaction(() => sql.remove.run(entry.id));
              pump();
              settleIdlers();
            }),
          ),
        ),
      );
    }
    settleIdlers();
  };

  return {
    register: (kind) => {
      kinds.set(kind.kind, kind as JobKind<unknown>);
    },

    enqueue: (userId, kind, key, payload) => {
      if ([...waiting, ...running].some((entry) => matches(entry, userId, kind.kind, key))) {
        return false;
      }
      const id = newId();
      const encoded = JSON.stringify(Schema.encodeSync(kind.payload)(payload));
      transaction(() => sql.insert.run(id, userId, kind.kind, key, encoded, now(), now()));
      waiting.push({ id, userId, kind: kind.kind, key, payload });
      deps.log({ event: 'jobs.queued', fields: { kind: kind.kind } });
      pump();
      return true;
    },

    state: (userId, kind, key) => {
      if (running.some((entry) => matches(entry, userId, kind, key))) return 'running';
      if (waiting.some((entry) => matches(entry, userId, kind, key))) return 'queued';
      return undefined;
    },

    resume: () => {
      const rows = sql.all.all() as unknown as ReadonlyArray<Row>;
      for (const row of rows) {
        const kind = kinds.get(row.kind);
        const decoded =
          kind === undefined
            ? undefined
            : Schema.decodeUnknownResult(kind.payload)(JSON.parse(row.payload));
        if (kind === undefined || decoded === undefined || decoded._tag === 'Failure') {
          // A kind this build does not know, or a payload it cannot read: nothing can run it.
          deps.log({ event: 'jobs.dropped', fields: { kind: row.kind } });
          transaction(() => sql.remove.run(row.id));
          continue;
        }
        if (row.state === 'running' && row.attempts >= maxAttempts) {
          deps.log({ event: 'jobs.abandoned', fields: { kind: row.kind, attempts: row.attempts } });
          try {
            kind.abandon(row.user_id, decoded.success);
          } catch {
            deps.log({ event: 'jobs.abandon.failed', fields: { kind: row.kind } });
          }
          transaction(() => sql.remove.run(row.id));
          continue;
        }
        if (row.state === 'running') {
          deps.log({ event: 'jobs.resumed', fields: { kind: row.kind, attempts: row.attempts } });
          transaction(() => sql.requeue.run(now(), row.id));
        }
        waiting.push({
          id: row.id,
          userId: row.user_id,
          kind: row.kind,
          key: row.key,
          payload: decoded.success,
        });
      }
      pump();
    },

    idle: (userId) =>
      new Promise<void>((resolve) => {
        idlers.push(userId === undefined ? { resolve } : { userId, resolve });
        settleIdlers();
      }),

    stopAll: async () => {
      stopping = true;
      const fibers = running.flatMap((entry) => (entry.fiber === undefined ? [] : [entry.fiber]));
      await Effect.runPromise(Fiber.interruptAll(fibers));
      waiting.length = 0;
      running.length = 0;
      settleIdlers();
    },
  };
};
