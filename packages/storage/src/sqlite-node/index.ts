// Server driver of the storage port (plan tai-khoan.md A3): `node:sqlite`, one database for every
// account. SERVER ONLY: import it from server code, never from code that reaches the browser.
//
// `forUser(userId)` hands out a `StorageService` bound to one user. Every query filters by owner
// inside this file, so code holding the service cannot forget to. The owner of a session is the
// `sessions` table: the first batch written to a new session id claims it in the same transaction.
// Another user's session looks exactly like an unknown one (plan: 404, not 403).
import { Effect, Queue, Stream } from 'effect';
import {
  StorageFailure,
  type AppendResult,
  type StorageChange,
  type StorageError,
  type StorageService,
} from '../port/index.ts';
import { decodeLog, summarize, toEventRow, type SessionRow } from '../sqlite/codec.ts';
import { toStorageError, type ServerDatabase } from './database.ts';

export { openServerDatabase, toStorageError } from './database.ts';
export type { ServerDatabase, ServerDatabaseOptions } from './database.ts';
export { serverMigrations } from './schema.ts';

export interface ServerStorage {
  /** The port, restricted to the sessions of `userId`. Cheap: call it per request. */
  readonly forUser: (userId: string) => StorageService;
}

/** Thrown inside a transaction when the session belongs to someone else. */
const unknownSession = (sessionId: string) =>
  new StorageFailure({ message: `Unknown session ${sessionId}` });

const guestOnly = Effect.fail(
  new StorageFailure({
    message: 'Guest settings are not stored on the server; account settings have their own service',
  }),
);

export const makeServerStorage = (database: ServerDatabase): ServerStorage => {
  const { db, transaction } = database;
  const listeners = new Map<string, Set<(change: StorageChange) => void>>();

  const owner = db.prepare('SELECT user_id FROM sessions WHERE session_id = ?');
  const claim = db.prepare(
    'INSERT INTO sessions (session_id, user_id, created_at) VALUES (?, ?, ?)',
  );
  const lastSeq = db.prepare(
    'SELECT COALESCE(MAX(seq), -1) AS last FROM events WHERE session_id = ?',
  );
  const insert = db.prepare(
    'INSERT INTO events (session_id, seq, id, tag, at, payload) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const read = db.prepare(
    `SELECT e.payload FROM events e JOIN sessions s ON s.session_id = e.session_id
      WHERE e.session_id = ? AND s.user_id = ? ORDER BY e.seq`,
  );
  const ownedLastSeq = db.prepare(
    `SELECT COALESCE(MAX(e.seq), -1) AS last FROM events e
       JOIN sessions s ON s.session_id = e.session_id
      WHERE e.session_id = ? AND s.user_id = ?`,
  );
  const list = db.prepare(
    `SELECT e.session_id, MIN(e.at) AS created_at, MAX(e.at) AS updated_at, COUNT(*) AS event_count,
            MAX(CASE WHEN e.tag = 'SessionCreated' THEN e.payload END) AS created
       FROM events e JOIN sessions s ON s.session_id = e.session_id
      WHERE s.user_id = ?
      GROUP BY e.session_id
      ORDER BY updated_at DESC, e.session_id`,
  );

  /** Runs a synchronous query as an Effect, mapping anything thrown to a typed storage error. */
  const run = <T>(work: () => T): Effect.Effect<T, StorageError> =>
    Effect.try({ try: work, catch: toStorageError });

  const notify = (userId: string, change: StorageChange) =>
    listeners.get(userId)?.forEach((listener) => listener(change));

  const forUser = (userId: string): StorageService => ({
    persistent: true,

    appendEvents: (sessionId, events) =>
      events.length === 0
        ? run((): AppendResult => ({
            lastSeq: Number((ownedLastSeq.get(sessionId, userId) as { last: number }).last),
          }))
        : run((): AppendResult => {
            const result = transaction(() => {
              const row = owner.get(sessionId) as { user_id: string } | undefined;
              if (row === undefined) claim.run(sessionId, userId, Date.now());
              else if (row.user_id !== userId) throw unknownSession(sessionId);
              let seq = Number((lastSeq.get(sessionId) as { last: number }).last);
              for (const event of events) {
                const { id, tag, at, payload } = toEventRow(event);
                seq += 1;
                insert.run(sessionId, seq, id, tag, at, payload);
              }
              return { lastSeq: seq };
            });
            // After COMMIT only.
            notify(userId, { _tag: 'SessionChanged', sessionId });
            return result;
          }),

    readSession: (sessionId) =>
      run(() =>
        (read.all(sessionId, userId) as Array<{ payload: string }>).map((r) => r.payload),
      ).pipe(
        Effect.flatMap((payloads) =>
          Effect.try({
            try: () => decodeLog(payloads),
            catch: (error) =>
              new StorageFailure({
                message: `Stored event is not valid: ${error instanceof Error ? error.message : String(error)}`,
              }),
          }),
        ),
      ),

    listSessions: run(() =>
      (
        list.all(userId) as Array<{
          session_id: string;
          created_at: number;
          updated_at: number;
          event_count: number;
          created: string | null;
        }>
      ).map((row) => {
        const session: SessionRow = {
          sessionId: row.session_id,
          createdAt: Number(row.created_at),
          updatedAt: Number(row.updated_at),
          eventCount: Number(row.event_count),
          created: row.created ?? undefined,
        };
        return summarize(session);
      }),
    ),

    getSettings: Effect.succeed(undefined),
    saveSettings: () => guestOnly,
    deleteApiKey: guestOnly,

    changes: Stream.callback<StorageChange>((queue) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const listener = (change: StorageChange) => void Queue.offerUnsafe(queue, change);
          let set = listeners.get(userId);
          if (set === undefined) listeners.set(userId, (set = new Set()));
          set.add(listener);
          return listener;
        }),
        (listener) =>
          Effect.sync(() => {
            const set = listeners.get(userId);
            set?.delete(listener);
            if (set?.size === 0) listeners.delete(userId);
          }),
      ),
    ),
  });

  return { forUser };
};
