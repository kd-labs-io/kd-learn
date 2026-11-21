// SPIKE (phase 1 step 1): delete with the rest of src/spike at step 5.
// Worker owning a raw @journeyapps/wa-sqlite database on OPFS (OPFSCoopSyncVFS).
// Same engine as @tanstack/browser-db-sqlite-persistence, but our own protocol, so it
// can run a whole transaction (batch) inside the worker without TanStack in the path.
import SQLiteESMFactory from '@journeyapps/wa-sqlite/dist/wa-sqlite.mjs';
import wasmUrl from '@journeyapps/wa-sqlite/dist/wa-sqlite.wasm?url';
import * as SQLite from '@journeyapps/wa-sqlite';
import { OPFSCoopSyncVFS } from '@journeyapps/wa-sqlite/src/examples/OPFSCoopSyncVFS.js';

type Stmt = { sql: string; params?: unknown[] };
type Request =
  | { id: number; op: 'open'; name: string }
  | { id: number; op: 'exec'; sql: string; params?: unknown[] }
  | { id: number; op: 'batch'; statements: Stmt[] }
  | { id: number; op: 'close' };

type Row = Record<string, unknown>;
type Sqlite3 = ReturnType<typeof SQLite.Factory>;
let sqlite3: Sqlite3 | undefined;
let handle = 0;
let vfs: { close?: () => Promise<void> | void } | undefined;

async function open(name: string) {
  const module = await SQLiteESMFactory({ locateFile: () => wasmUrl });
  sqlite3 = SQLite.Factory(module);
  const coop = await OPFSCoopSyncVFS.create('kd-coop', module);
  sqlite3.vfs_register(coop as never, true);
  vfs = coop as never;
  handle = await sqlite3.open_v2(
    `file:${name}?vfs=kd-coop`,
    SQLite.SQLITE_OPEN_CREATE | SQLite.SQLITE_OPEN_READWRITE | SQLite.SQLITE_OPEN_URI,
    'kd-coop',
  );
}

async function run(sql: string, params?: unknown[]): Promise<Row[]> {
  const s = sqlite3!;
  const rows: Row[] = [];
  for await (const stmt of s.statements(handle, sql)) {
    if (params?.length) s.bind_collection(stmt, params as never);
    const cols = s.column_names(stmt);
    while ((await s.step(stmt)) === SQLite.SQLITE_ROW) {
      const values = s.row(stmt);
      rows.push(Object.fromEntries(cols.map((c, i) => [c, values[i]])));
    }
  }
  return rows;
}

self.onmessage = async (event: MessageEvent<Request>) => {
  const req = event.data;
  try {
    let rows: Row[] = [];
    if (req.op === 'open') await open(req.name);
    else if (req.op === 'exec') rows = await run(req.sql, req.params);
    else if (req.op === 'batch') {
      await run('BEGIN IMMEDIATE');
      try {
        for (const s of req.statements) await run(s.sql, s.params);
        await run('COMMIT');
      } catch (error) {
        await run('ROLLBACK');
        throw error;
      }
    } else {
      await sqlite3?.close(handle);
      await vfs?.close?.();
    }
    self.postMessage({ id: req.id, ok: true, rows });
  } catch (error) {
    const e = error as Error;
    self.postMessage({ id: req.id, ok: false, error: `${e.name}: ${e.message}` });
  }
};
