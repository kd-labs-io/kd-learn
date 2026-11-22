// Worker that owns the SQLite database (wa-sqlite on OPFS, OPFSCoopSyncVFS). Plan step 5.
// Synchronous OPFS handles only exist in a Worker. Every write is a whole batch run here, between
// BEGIN IMMEDIATE and COMMIT, so no transaction ever stays open across messages: a transaction
// held by one tab would make every other tab wait forever (plan risk 20).
import SQLiteESMFactory from '@journeyapps/wa-sqlite/dist/wa-sqlite.mjs';
import wasmUrl from '@journeyapps/wa-sqlite/dist/wa-sqlite.wasm?url';
import * as SQLite from '@journeyapps/wa-sqlite';
import { OPFSCoopSyncVFS } from '@journeyapps/wa-sqlite/src/examples/OPFSCoopSyncVFS.js';
import { guestOwner, migrations, schemaVersion } from '../sqlite/schema.ts';
import type {
  AppendReply,
  Request,
  Response,
  WireChunk,
  WireEvent,
  WireSession,
  WireStoredChunk,
} from './protocol.ts';
import type { FigureRow } from '../sqlite/codec.ts';

type Row = Record<string, unknown>;
type Sqlite3 = ReturnType<typeof SQLite.Factory>;

let sqlite3: Sqlite3 | undefined;
let handle = 0;
let vfs: { close(): Promise<void> } | undefined;

class Unavailable extends Error {}

class SourceStateError extends Error {}

class Conflict extends Error {
  constructor(
    readonly expectedLastSeq: number,
    readonly lastSeq: number,
  ) {
    super(`The knowledge log ends at seq ${lastSeq}, not ${expectedLastSeq}`);
  }
}

async function run(sql: string, params: ReadonlyArray<unknown> = []): Promise<Row[]> {
  const db = sqlite3!;
  const rows: Row[] = [];
  for await (const stmt of db.statements(handle, sql)) {
    if (params.length > 0) db.bind_collection(stmt, params as never);
    const columns = db.column_names(stmt);
    while ((await db.step(stmt)) === SQLite.SQLITE_ROW) {
      const values = db.row(stmt);
      rows.push(Object.fromEntries(columns.map((column, i) => [column, values[i]])));
    }
  }
  return rows;
}

/** BEGIN IMMEDIATE ... COMMIT around `work`; ROLLBACK when it throws, so a failed batch writes nothing. */
async function transaction<T>(work: () => Promise<T>): Promise<T> {
  await run('BEGIN IMMEDIATE');
  try {
    const result = await work();
    await run('COMMIT');
    return result;
  } catch (error) {
    await run('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

async function open(name: string): Promise<void> {
  try {
    if (typeof navigator.storage?.getDirectory !== 'function') {
      throw new Error('OPFS is not available in this context');
    }
    const module = await SQLiteESMFactory({ locateFile: () => wasmUrl });
    sqlite3 = SQLite.Factory(module);
    const coop = await OPFSCoopSyncVFS.create('kd-coop', module);
    sqlite3.vfs_register(coop as never, true);
    vfs = coop;
    handle = await sqlite3.open_v2(
      `file:${name}?vfs=kd-coop`,
      SQLite.SQLITE_OPEN_CREATE | SQLite.SQLITE_OPEN_READWRITE | SQLite.SQLITE_OPEN_URI,
      'kd-coop',
    );
  } catch (error) {
    throw new Unavailable(error instanceof Error ? error.message : String(error));
  }
  await migrate();
}

/**
 * Applies the migrations the file has not seen. Two tabs may open a new database at the same time:
 * the version is read again inside the write transaction, so each migration runs once.
 */
async function migrate(): Promise<void> {
  await transaction(async () => {
    const version = Number((await run('PRAGMA user_version'))[0]?.user_version ?? 0);
    if (version > schemaVersion) {
      throw new Error(`Database schema v${version} is newer than this app (v${schemaVersion})`);
    }
    for (let next = version; next < schemaVersion; next++) {
      for (const statement of migrations[next] ?? []) await run(statement);
      // PRAGMA takes no bound parameters; `next` is a number from our own loop.
      await run(`PRAGMA user_version = ${next + 1}`);
    }
  });
}

async function append(
  sessionId: string,
  events: ReadonlyArray<WireEvent>,
  figures: ReadonlyArray<FigureRow>,
): Promise<AppendReply> {
  return transaction(async () => {
    const [head] = await run(
      'SELECT COALESCE(MAX(seq), -1) AS last FROM events WHERE session_id = ?',
      [sessionId],
    );
    let seq = Number(head?.last ?? -1);
    for (const event of events) {
      seq += 1;
      await run(
        'INSERT INTO events (session_id, seq, id, tag, at, payload) VALUES (?, ?, ?, ?, ?, ?)',
        [sessionId, seq, event.id, event.tag, event.at, event.payload],
      );
    }
    for (const figure of figures) {
      await run(
        'INSERT INTO figures (owner, figure_id, session_id, text, blob) VALUES (?, ?, ?, ?, ?)',
        [guestOwner, figure.figureId, sessionId, figure.text, figure.blob],
      );
    }
    return { lastSeq: seq };
  });
}

async function read(sessionId: string): Promise<string[]> {
  const rows = await run('SELECT payload FROM events WHERE session_id = ? ORDER BY seq', [
    sessionId,
  ]);
  return rows.map((row) => String(row.payload));
}

async function appendKnowledge(
  events: ReadonlyArray<WireEvent>,
  expectedLastSeq: number,
): Promise<AppendReply> {
  return transaction(async () => {
    const [head] = await run(
      'SELECT COALESCE(MAX(seq), -1) AS last FROM knowledge_events WHERE owner = ?',
      [guestOwner],
    );
    const last = Number(head?.last ?? -1);
    if (expectedLastSeq !== last) {
      throw new Conflict(expectedLastSeq, last);
    }
    let seq = last;
    for (const event of events) {
      seq += 1;
      await run(
        'INSERT INTO knowledge_events (owner, seq, id, tag, at, payload) VALUES (?, ?, ?, ?, ?, ?)',
        [guestOwner, seq, event.id, event.tag, event.at, event.payload],
      );
    }
    return { lastSeq: seq };
  });
}

async function list(): Promise<WireSession[]> {
  const sessions = await run(
    `SELECT session_id, MIN(at) AS created_at, MAX(at) AS updated_at, COUNT(*) AS event_count,
            MAX(CASE WHEN tag = 'SessionCreated' THEN payload END) AS created,
            MAX(CASE WHEN tag = 'PlanCreated' THEN payload END) AS plan,
            SUM(CASE WHEN tag IN ('StepCompleted', 'StepSkipped') THEN 1 ELSE 0 END) AS resolved,
            MAX(CASE WHEN tag = 'SessionCompleted' THEN 1 ELSE 0 END) AS completed
       FROM events GROUP BY session_id ORDER BY updated_at DESC, session_id`,
  );
  return sessions.map((row) => ({
    sessionId: String(row.session_id),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    eventCount: Number(row.event_count),
    created: row.created == null ? undefined : String(row.created),
    plan: row.plan == null ? undefined : String(row.plan),
    resolved: Number(row.resolved),
    completed: Number(row.completed) === 1,
  }));
}

const insertChunks = async (sourceId: string, chunks: ReadonlyArray<WireChunk>) => {
  for (const chunk of chunks) {
    await run(
      'INSERT INTO source_chunks (owner, source_id, ordinal, text, locator) VALUES (?, ?, ?, ?, ?)',
      [guestOwner, sourceId, chunk.ordinal, chunk.text, chunk.locator],
    );
  }
};

const sourceRow = async (sourceId: string) =>
  (await run('SELECT * FROM sources WHERE owner = ? AND source_id = ?', [guestOwner, sourceId]))[0];

async function handleSources(request: Request): Promise<unknown> {
  switch (request.op) {
    case 'createSource':
      return transaction(async () => {
        const { row } = request;
        await run(
          `INSERT INTO sources (owner, source_id, kind, title, origin, state, failure, bytes, chunk_count, created_at)
           VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
          [
            guestOwner,
            row.source_id,
            row.kind,
            row.title,
            row.origin,
            row.state,
            row.bytes,
            row.chunk_count,
            row.created_at,
          ],
        );
        await insertChunks(row.source_id, request.chunks);
        if (request.file !== undefined) {
          await run('INSERT INTO source_files (owner, source_id, bytes) VALUES (?, ?, ?)', [
            guestOwner,
            row.source_id,
            request.file,
          ]);
        }
      });
    case 'completeSource':
      return transaction(async () => {
        const row = await sourceRow(request.sourceId);
        if (row?.state !== 'pending') throw new SourceStateError('The source is not pending.');
        await run('DELETE FROM source_chunks WHERE owner = ? AND source_id = ?', [
          guestOwner,
          request.sourceId,
        ]);
        await insertChunks(request.sourceId, request.chunks);
        await run(
          `UPDATE sources SET state = 'ready', failure = NULL, bytes = ?, chunk_count = ?,
                  title = COALESCE(?, title) WHERE owner = ? AND source_id = ?`,
          [
            request.bytes,
            request.chunks.length,
            request.title ?? null,
            guestOwner,
            request.sourceId,
          ],
        );
        await run('DELETE FROM source_files WHERE owner = ? AND source_id = ?', [
          guestOwner,
          request.sourceId,
        ]);
      });
    case 'failSource':
      return transaction(async () => {
        const row = await sourceRow(request.sourceId);
        if (row?.state !== 'pending') throw new SourceStateError('The source is not pending.');
        await run(
          "UPDATE sources SET state = 'failed', failure = ? WHERE owner = ? AND source_id = ?",
          [request.failure, guestOwner, request.sourceId],
        );
      });
    case 'retrySource':
      return transaction(async () => {
        const row = await sourceRow(request.sourceId);
        if (row === undefined || row.state === 'ready') {
          throw new SourceStateError('The source cannot run again.');
        }
        await run(
          "UPDATE sources SET state = 'pending', failure = NULL WHERE owner = ? AND source_id = ?",
          [guestOwner, request.sourceId],
        );
      });
    case 'listSources':
      return run('SELECT * FROM sources WHERE owner = ? ORDER BY created_at DESC, source_id', [
        guestOwner,
      ]);
    case 'getSource':
      return sourceRow(request.sourceId);
    case 'readSourceFile': {
      const [row] = await run('SELECT bytes FROM source_files WHERE owner = ? AND source_id = ?', [
        guestOwner,
        request.sourceId,
      ]);
      return row === undefined ? undefined : new Uint8Array(row.bytes as Uint8Array);
    }
    case 'readChunks': {
      const out: WireStoredChunk[] = [];
      for (const sourceId of request.sourceIds) {
        const row = await sourceRow(sourceId);
        if (row === undefined) continue;
        for (const chunk of await run(
          'SELECT ordinal, text, locator FROM source_chunks WHERE owner = ? AND source_id = ? ORDER BY ordinal',
          [guestOwner, sourceId],
        )) {
          out.push({
            sourceId,
            title: String(row.title),
            ordinal: Number(chunk.ordinal),
            text: String(chunk.text),
            locator: String(chunk.locator),
          });
        }
      }
      return out;
    }
    case 'deleteSource':
      return transaction(async () => {
        for (const table of ['source_chunks', 'source_files', 'sources']) {
          await run(`DELETE FROM ${table} WHERE owner = ? AND source_id = ?`, [
            guestOwner,
            request.sourceId,
          ]);
        }
      });
    default:
      throw new Error(`Unknown operation ${request.op}`);
  }
}

async function handleRequest(request: Request): Promise<unknown> {
  switch (request.op) {
    case 'open':
      return open(request.name);
    case 'append':
      return append(request.sessionId, request.events, request.figures);
    case 'readFigure':
      return (
        await run('SELECT figure_id, text, blob FROM figures WHERE owner = ? AND figure_id = ?', [
          guestOwner,
          request.figureId,
        ])
      )[0];
    case 'read':
      return read(request.sessionId);
    case 'list':
      return list();
    case 'appendKnowledge':
      return appendKnowledge(request.events, request.expectedLastSeq);
    case 'readKnowledge':
      return (
        await run('SELECT payload FROM knowledge_events WHERE owner = ? ORDER BY seq', [guestOwner])
      ).map((row) => String(row.payload));
    case 'getSettings':
      return Object.fromEntries(
        (await run('SELECT key, value FROM settings')).map((row) => [row.key, row.value]),
      );
    case 'putSettings':
      return transaction(async () => {
        for (const [key, value] of Object.entries(request.entries)) {
          await run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [key, value]);
        }
        for (const key of request.remove) await run('DELETE FROM settings WHERE key = ?', [key]);
      });
    case 'getProfile': {
      const [row] = await run('SELECT payload FROM teaching_profile WHERE slot = 1');
      return row === undefined ? undefined : String(row.payload);
    }
    case 'putProfile':
      if (request.payload === undefined) {
        await run('DELETE FROM teaching_profile WHERE slot = 1');
      } else {
        await run(
          `INSERT INTO teaching_profile (slot, payload, updated_at) VALUES (1, ?, ?)
             ON CONFLICT (slot) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`,
          [request.payload, request.at],
        );
      }
      return undefined;
    case 'close':
      await sqlite3?.close(handle);
      await vfs?.close();
      return undefined;
    default:
      return handleSources(request);
  }
}

// One request at a time. The connection is shared and a transaction spans several awaits, so a
// second request starting in the middle would hit "transaction within a transaction", and its
// ROLLBACK would undo the first batch. The queue makes batch atomicity structural.
let queue: Promise<void> = Promise.resolve();

self.onmessage = (event: MessageEvent<Request>) => {
  const request = event.data;
  queue = queue.then(async () => {
    let response: Response;
    try {
      response = { id: request.id, ok: true, result: await handleRequest(request) };
    } catch (error) {
      response =
        error instanceof Conflict
          ? {
              id: request.id,
              ok: false,
              kind: 'conflict',
              message: error.message,
              expectedLastSeq: error.expectedLastSeq,
              lastSeq: error.lastSeq,
            }
          : {
              id: request.id,
              ok: false,
              kind:
                error instanceof Unavailable
                  ? 'unavailable'
                  : error instanceof SourceStateError
                    ? 'sourceConflict'
                    : 'failure',
              message: error instanceof Error ? error.message : String(error),
            };
    }
    self.postMessage(response);
  });
};
