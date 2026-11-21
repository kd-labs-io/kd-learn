// SPIKE (phase 1 step 1): delete with the rest of src/spike at step 5.
// Page-side API driven by apps/web/scripts/spike-sqlite.mjs through Playwright.
import { openDriver, type DriverId, type Row, type SpikeDb } from './drivers';

const handles = new Map<string, SpikeDb>();
let nextHandle = 1;

const ms = () => performance.now();

async function guard<T>(fn: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await fn();
  } catch (error) {
    const e = error as Error;
    return { error: `${e.name}: ${e.message}` };
  }
}

export const api = {
  env() {
    const g = globalThis as unknown as Record<string, unknown>;
    return {
      crossOriginIsolated: globalThis.crossOriginIsolated,
      sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
      opfs: typeof navigator.storage?.getDirectory === 'function',
      webLocks: typeof navigator.locks !== 'undefined',
      broadcastChannel: typeof g.BroadcastChannel !== 'undefined',
      ua: navigator.userAgent,
    };
  },

  open(driver: DriverId, dbName: string) {
    return guard(async () => {
      const t0 = ms();
      const db = await openDriver(driver, dbName);
      const openMs = ms() - t0;
      const handle = `h${nextHandle++}`;
      handles.set(handle, db);
      return { handle, openMs };
    });
  },

  /** First SQL round-trip (schema create) timed separately from open. */
  init(handle: string) {
    return guard(async () => {
      const db = handles.get(handle)!;
      const t0 = ms();
      await db.exec(
        'CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, session TEXT NOT NULL, seq INTEGER NOT NULL, tab TEXT NOT NULL, payload TEXT NOT NULL)',
      );
      const version = await db.exec('SELECT sqlite_version() AS v');
      return { initMs: ms() - t0, version: version[0]?.v };
    });
  },

  /** Append n events atomically. Uses the driver's batch when present, else BEGIN/COMMIT messages. */
  append(handle: string, n: number, tab: string) {
    return guard(async () => {
      const db = handles.get(handle)!;
      const sql = 'INSERT INTO events (session, seq, tab, payload) VALUES (?, ?, ?, ?)';
      const payload = JSON.stringify({ text: 'x'.repeat(200) });
      const t0 = ms();
      if (db.batch) {
        await db.batch(
          Array.from({ length: n }, (_, i) => ({ sql, params: ['s1', i, tab, payload] })),
        );
      } else {
        await db.exec('BEGIN IMMEDIATE');
        try {
          for (let i = 0; i < n; i++) await db.exec(sql, ['s1', i, tab, payload]);
          await db.exec('COMMIT');
        } catch (error) {
          await db.exec('ROLLBACK').catch(() => undefined);
          throw error;
        }
      }
      return {
        n,
        appendMs: ms() - t0,
        atomic: db.batch ? 'worker-batch' : 'begin/commit messages',
      };
    });
  },

  /** One auto-commit insert (fsync-heavy path). */
  appendOne(handle: string, tab: string) {
    return guard(async () => {
      const db = handles.get(handle)!;
      const t0 = ms();
      await db.exec('INSERT INTO events (session, seq, tab, payload) VALUES (?, ?, ?, ?)', [
        's1',
        0,
        tab,
        '{}',
      ]);
      return { oneMs: ms() - t0 };
    });
  },

  count(handle: string, tab?: string) {
    return guard(async () => {
      const db = handles.get(handle)!;
      const rows: Row[] = tab
        ? await db.exec('SELECT COUNT(*) AS c FROM events WHERE tab = ?', [tab])
        : await db.exec('SELECT COUNT(*) AS c FROM events');
      return Number(rows[0]?.c);
    });
  },

  /** Start a transaction and leave it open, so the test can kill the page mid-transaction. */
  beginUncommitted(handle: string, tab: string) {
    return guard(async () => {
      const db = handles.get(handle)!;
      await db.exec('BEGIN IMMEDIATE');
      for (let i = 0; i < 50; i++) {
        await db.exec('INSERT INTO events (session, seq, tab, payload) VALUES (?, ?, ?, ?)', [
          's1',
          i,
          tab,
          '{}',
        ]);
      }
      return 'uncommitted';
    });
  },

  /** Wipe the table (test isolation). */
  reset(handle: string) {
    return guard(async () => {
      await handles.get(handle)!.exec('DELETE FROM events');
      return true;
    });
  },

  close(handle: string) {
    return guard(async () => {
      await handles.get(handle)?.close();
      handles.delete(handle);
      return true;
    });
  },

  exec(handle: string, sql: string) {
    return guard(() => handles.get(handle)!.exec(sql));
  },

  handle(handle: string) {
    return handles.get(handle);
  },
};

export type SpikeApi = typeof api;
