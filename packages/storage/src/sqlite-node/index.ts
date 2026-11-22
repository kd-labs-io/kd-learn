// Server driver of the storage port (plan tai-khoan.md A3): `node:sqlite`, one database for every
// account. SERVER ONLY: import it from server code, never from code that reaches the browser.
//
// `forUser(userId)` hands out a `StorageService` bound to one user. Every query filters by owner
// inside this file, so code holding the service cannot forget to. The owner of a session is the
// `sessions` table: the first batch written to a new session id claims it in the same transaction.
// Another user's session looks exactly like an unknown one (plan: 404, not 403).
import { Effect, Queue, Stream } from 'effect';
import {
  KnowledgeConflict,
  SourceConflict,
  StorageFailure,
  type AppendResult,
  type StorageChange,
  type StorageError,
  type StorageService,
} from '../port/index.ts';
import {
  decodeKnowledgeLog,
  decodeLog,
  decodeProfile,
  encodeProfile,
  summarize,
  toEventRow,
  toKnowledgeRow,
  checkChunks,
  checkNewSourceInfo,
  fromChunkRow,
  fromSourceRow,
  toChunkRow,
  type SessionRow,
  type SourceRow,
} from '../sqlite/codec.ts';
import { toStorageError, type ServerDatabase } from './database.ts';

export { openServerDatabase, toStorageError } from './database.ts';
export type { ServerDatabase, ServerDatabaseOptions } from './database.ts';
export { serverMigrations } from './schema.ts';

export interface ServerStorage {
  /** The port, restricted to the sessions of `userId`. Cheap: call it per request. */
  readonly forUser: (userId: string) => StorageService;
  /**
   * Users whose knowledge log has an extraction attempt (startup recovery, phase 3 A3). Ids only:
   * their data is still read through `forUser`.
   */
  readonly extractionOwners: () => ReadonlyArray<string>;
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

  const getProfile = db.prepare('SELECT payload FROM teaching_profiles WHERE user_id = ?');
  const putProfile = db.prepare(
    `INSERT INTO teaching_profiles (user_id, payload, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`,
  );
  const removeProfile = db.prepare('DELETE FROM teaching_profiles WHERE user_id = ?');
  const knowledgeLastSeq = db.prepare(
    'SELECT COALESCE(MAX(seq), -1) AS last FROM knowledge_events WHERE owner = ?',
  );
  const knowledgeInsert = db.prepare(
    'INSERT INTO knowledge_events (owner, seq, id, tag, at, payload) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const knowledgeRead = db.prepare(
    'SELECT payload FROM knowledge_events WHERE owner = ? ORDER BY seq',
  );

  const src = {
    insert: db.prepare(
      `INSERT INTO sources (owner, source_id, kind, title, origin, state, failure, bytes, chunk_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
    ),
    get: db.prepare('SELECT * FROM sources WHERE owner = ? AND source_id = ?'),
    list: db.prepare('SELECT * FROM sources WHERE owner = ? ORDER BY created_at DESC, source_id'),
    ready: db.prepare(
      `UPDATE sources SET state = 'ready', failure = NULL, bytes = ?, chunk_count = ?,
              title = COALESCE(?, title) WHERE owner = ? AND source_id = ?`,
    ),
    fail: db.prepare(
      "UPDATE sources SET state = 'failed', failure = ? WHERE owner = ? AND source_id = ?",
    ),
    pending: db.prepare(
      "UPDATE sources SET state = 'pending', failure = NULL WHERE owner = ? AND source_id = ?",
    ),
    remove: db.prepare('DELETE FROM sources WHERE owner = ? AND source_id = ?'),
    chunk: db.prepare(
      'INSERT INTO source_chunks (owner, source_id, ordinal, text, locator) VALUES (?, ?, ?, ?, ?)',
    ),
    chunks: db.prepare(
      'SELECT ordinal, text, locator FROM source_chunks WHERE owner = ? AND source_id = ? ORDER BY ordinal',
    ),
    removeChunks: db.prepare('DELETE FROM source_chunks WHERE owner = ? AND source_id = ?'),
    file: db.prepare('SELECT bytes FROM source_files WHERE owner = ? AND source_id = ?'),
    putFile: db.prepare('INSERT INTO source_files (owner, source_id, bytes) VALUES (?, ?, ?)'),
    removeFile: db.prepare('DELETE FROM source_files WHERE owner = ? AND source_id = ?'),
  };

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

    // The knowledge log of `userId` only: the owner is never taken from the caller.
    appendKnowledge: (events, { expectedLastSeq }) =>
      Effect.try({
        try: (): AppendResult => {
          const result = transaction(() => {
            const last = Number((knowledgeLastSeq.get(userId) as { last: number }).last);
            if (expectedLastSeq !== last) {
              throw new KnowledgeConflict({ expectedLastSeq, lastSeq: last });
            }
            let seq = last;
            for (const event of events) {
              const { id, tag, at, payload } = toKnowledgeRow(event);
              seq += 1;
              knowledgeInsert.run(userId, seq, id, tag, at, payload);
            }
            return { lastSeq: seq };
          });
          // After COMMIT only.
          if (events.length > 0) notify(userId, { _tag: 'KnowledgeChanged' });
          return result;
        },
        catch: (error) => (error instanceof KnowledgeConflict ? error : toStorageError(error)),
      }),

    readKnowledge: run(() =>
      (knowledgeRead.all(userId) as Array<{ payload: string }>).map((r) => r.payload),
    ).pipe(
      Effect.flatMap((payloads) =>
        Effect.try({
          try: () => decodeKnowledgeLog(payloads),
          catch: (error) =>
            new StorageFailure({
              message: `Stored knowledge event is not valid: ${error instanceof Error ? error.message : String(error)}`,
            }),
        }),
      ),
    ),

    createSource: (source) =>
      run(() => {
        const info = checkNewSourceInfo(source.info);
        const bytes = source.state === 'ready' ? checkChunks(source.chunks) : 0;
        transaction(() => {
          src.insert.run(
            userId,
            info.sourceId,
            info.kind,
            info.title,
            info.origin,
            source.state,
            bytes,
            source.state === 'ready' ? source.chunks.length : 0,
            info.createdAt,
          );
          if (source.state === 'ready') {
            for (const chunk of source.chunks) {
              const row = toChunkRow(chunk);
              src.chunk.run(userId, info.sourceId, row.ordinal, row.text, row.locator);
            }
          } else if (source.file !== undefined) {
            src.putFile.run(userId, info.sourceId, source.file);
          }
        });
        notify(userId, { _tag: 'SourcesChanged' });
      }),

    completeSource: (sourceId, chunks, options) =>
      Effect.try({
        try: () => {
          const bytes = checkChunks(chunks);
          transaction(() => {
            const row = src.get.get(userId, sourceId) as SourceRow | undefined;
            if (row?.state !== 'pending') {
              throw new SourceConflict({ message: 'The source is not pending.' });
            }
            src.removeChunks.run(userId, sourceId);
            for (const chunk of chunks) {
              const r = toChunkRow(chunk);
              src.chunk.run(userId, sourceId, r.ordinal, r.text, r.locator);
            }
            src.ready.run(bytes, chunks.length, options?.title ?? null, userId, sourceId);
            src.removeFile.run(userId, sourceId);
          });
          notify(userId, { _tag: 'SourcesChanged' });
        },
        catch: (error) => (error instanceof SourceConflict ? error : toStorageError(error)),
      }),

    failSource: (sourceId, failure) =>
      Effect.try({
        try: () => {
          transaction(() => {
            const row = src.get.get(userId, sourceId) as SourceRow | undefined;
            if (row?.state !== 'pending') {
              throw new SourceConflict({ message: 'The source is not pending.' });
            }
            src.fail.run(JSON.stringify(failure), userId, sourceId);
          });
          notify(userId, { _tag: 'SourcesChanged' });
        },
        catch: (error) => (error instanceof SourceConflict ? error : toStorageError(error)),
      }),

    retrySource: (sourceId) =>
      Effect.try({
        try: () => {
          transaction(() => {
            const row = src.get.get(userId, sourceId) as SourceRow | undefined;
            if (row === undefined || row.state === 'ready') {
              throw new SourceConflict({ message: 'The source cannot run again.' });
            }
            src.pending.run(userId, sourceId);
          });
          notify(userId, { _tag: 'SourcesChanged' });
        },
        catch: (error) => (error instanceof SourceConflict ? error : toStorageError(error)),
      }),

    listSources: run(() => (src.list.all(userId) as unknown as SourceRow[]).map(fromSourceRow)),

    getSource: (sourceId) =>
      run(() => {
        const row = src.get.get(userId, sourceId) as SourceRow | undefined;
        return row === undefined ? undefined : fromSourceRow(row);
      }),

    readSourceFile: (sourceId) =>
      run(() => {
        const row = src.file.get(userId, sourceId) as { bytes: Uint8Array } | undefined;
        return row === undefined ? undefined : new Uint8Array(row.bytes);
      }),

    readChunks: (sourceIds) =>
      run(() =>
        sourceIds.flatMap((sourceId) => {
          const row = src.get.get(userId, sourceId) as SourceRow | undefined;
          if (row === undefined) return [];
          return (
            src.chunks.all(userId, sourceId) as Array<{
              ordinal: number;
              text: string;
              locator: string;
            }>
          ).map((chunk) => ({ sourceId, title: row.title, chunk: fromChunkRow(chunk) }));
        }),
      ),

    deleteSource: (sourceId) =>
      run(() => {
        transaction(() => {
          src.removeChunks.run(userId, sourceId);
          src.removeFile.run(userId, sourceId);
          src.remove.run(userId, sourceId);
        });
        notify(userId, { _tag: 'SourcesChanged' });
      }),

    getSettings: Effect.succeed(undefined),
    saveSettings: () => guestOnly,
    deleteApiKey: guestOnly,

    getProfile: run(() => getProfile.get(userId) as { payload: string } | undefined).pipe(
      Effect.flatMap((row) =>
        row === undefined
          ? Effect.succeed(undefined)
          : Effect.try({
              try: () => decodeProfile(row.payload),
              catch: () => new StorageFailure({ message: 'Stored profile is not valid' }),
            }),
      ),
    ),

    saveProfile: (profile) =>
      Effect.try({
        try: () => (profile === undefined ? undefined : encodeProfile(profile)),
        catch: () => new StorageFailure({ message: 'Profile is not valid' }),
      }).pipe(
        Effect.flatMap((payload) =>
          run(() => {
            if (payload === undefined) removeProfile.run(userId);
            else putProfile.run(userId, payload, Date.now());
            notify(userId, { _tag: 'ProfileChanged' });
          }),
        ),
      ),

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

  const owners = db.prepare(
    "SELECT DISTINCT owner FROM knowledge_events WHERE tag = 'ExtractionStarted' ORDER BY owner",
  );
  const extractionOwners = () => (owners.all() as Array<{ owner: string }>).map((row) => row.owner);

  return { forUser, extractionOwners };
};
