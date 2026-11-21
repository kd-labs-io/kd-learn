// Worker that owns the SQLite database (wa-sqlite on OPFS, OPFSCoopSyncVFS). Plan step 5.
// Synchronous OPFS handles only exist in a Worker. Every write is a whole batch run here, between
// BEGIN IMMEDIATE and COMMIT, so no transaction ever stays open across messages: a transaction
// held by one tab would make every other tab wait forever (plan risk 20).
import SQLiteESMFactory from '@journeyapps/wa-sqlite/dist/wa-sqlite.mjs';
import wasmUrl from '@journeyapps/wa-sqlite/dist/wa-sqlite.wasm?url';
import * as SQLite from '@journeyapps/wa-sqlite';
import { OPFSCoopSyncVFS } from '@journeyapps/wa-sqlite/src/examples/OPFSCoopSyncVFS.js';
import { migrations, schemaVersion } from '../sqlite/schema.ts';
import type { AppendReply, Request, Response, WireEvent, WireSession } from './protocol.ts';

type Row = Record<string, unknown>;
type Sqlite3 = ReturnType<typeof SQLite.Factory>;

let sqlite3: Sqlite3 | undefined;
let handle = 0;
let vfs: { close(): Promise<void> } | undefined;

class Unavailable extends Error {}

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

async function append(sessionId: string, events: ReadonlyArray<WireEvent>): Promise<AppendReply> {
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
    return { lastSeq: seq };
  });
}

async function read(sessionId: string): Promise<string[]> {
  const rows = await run('SELECT payload FROM events WHERE session_id = ? ORDER BY seq', [
    sessionId,
  ]);
  return rows.map((row) => String(row.payload));
}

async function list(): Promise<WireSession[]> {
  const sessions = await run(
    `SELECT session_id, MIN(at) AS created_at, MAX(at) AS updated_at, COUNT(*) AS event_count
       FROM events GROUP BY session_id ORDER BY updated_at DESC, session_id`,
  );
  const created = new Map(
    (await run("SELECT session_id, payload FROM events WHERE tag = 'SessionCreated'")).map(
      (row) => [String(row.session_id), String(row.payload)],
    ),
  );
  return sessions.map((row) => ({
    sessionId: String(row.session_id),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    eventCount: Number(row.event_count),
    created: created.get(String(row.session_id)),
  }));
}

async function handleRequest(request: Request): Promise<unknown> {
  switch (request.op) {
    case 'open':
      return open(request.name);
    case 'append':
      return append(request.sessionId, request.events);
    case 'read':
      return read(request.sessionId);
    case 'list':
      return list();
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
    case 'close':
      await sqlite3?.close(handle);
      await vfs?.close();
      return undefined;
  }
}

self.onmessage = async (event: MessageEvent<Request>) => {
  const request = event.data;
  let response: Response;
  try {
    response = { id: request.id, ok: true, result: await handleRequest(request) };
  } catch (error) {
    response = {
      id: request.id,
      ok: false,
      kind: error instanceof Unavailable ? 'unavailable' : 'failure',
      message: error instanceof Error ? error.message : String(error),
    };
  }
  self.postMessage(response);
};
