// SPIKE (phase 1 step 1): delete with the rest of src/spike at step 5.
// Worker that owns an official @sqlite.org/sqlite-wasm database on OPFS.
// VFS "sahpool" needs no COOP/COEP; VFS "opfs" needs SharedArrayBuffer (COOP/COEP).
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';

type Request =
  | { id: number; op: 'open'; vfs: 'opfs' | 'sahpool'; name: string }
  | { id: number; op: 'exec'; sql: string; params?: unknown[] }
  | { id: number; op: 'batch'; statements: { sql: string; params?: unknown[] }[] }
  | { id: number; op: 'close' };

type Row = Record<string, unknown>;
// The oo1 Database type is not exported by name; keep the surface we use.
type Db = {
  exec: (opts: {
    sql: string;
    bind?: unknown[];
    rowMode?: 'object';
    returnValue?: 'resultRows';
  }) => Row[];
  close: () => void;
};

let db: Db | undefined;
let closeVfs: (() => Promise<unknown>) | undefined;

async function open(vfs: 'opfs' | 'sahpool', name: string) {
  const sqlite3 = await sqlite3InitModule();
  if (vfs === 'sahpool') {
    const pool = await sqlite3.installOpfsSAHPoolVfs({
      name: 'kd-sahpool',
      directory: '/kd-spike',
    });
    db = new pool.OpfsSAHPoolDb(`/${name}`) as unknown as Db;
    closeVfs = async () => pool.pauseVfs();
  } else {
    if (!sqlite3.oo1.OpfsDb) {
      throw new Error(
        `opfs VFS unavailable (crossOriginIsolated=${String(self.crossOriginIsolated)})`,
      );
    }
    db = new sqlite3.oo1.OpfsDb(`/kd-spike/${name}`, 'c') as unknown as Db;
  }
}

const run = (sql: string, params?: unknown[]) =>
  db!.exec({
    sql,
    ...(params ? { bind: params } : {}),
    rowMode: 'object',
    returnValue: 'resultRows',
  });

self.onmessage = async (event: MessageEvent<Request>) => {
  const req = event.data;
  try {
    let rows: Row[] = [];
    if (req.op === 'open') await open(req.vfs, req.name);
    else if (req.op === 'exec') rows = run(req.sql, req.params);
    else if (req.op === 'batch') {
      // One message = one atomic transaction; nothing can interleave inside the worker.
      run('BEGIN IMMEDIATE');
      try {
        for (const s of req.statements) run(s.sql, s.params);
        run('COMMIT');
      } catch (error) {
        run('ROLLBACK');
        throw error;
      }
    } else {
      db?.close();
      await closeVfs?.();
      db = undefined;
    }
    self.postMessage({ id: req.id, ok: true, rows });
  } catch (error) {
    const e = error as Error;
    self.postMessage({ id: req.id, ok: false, error: `${e.name}: ${e.message}` });
  }
};
