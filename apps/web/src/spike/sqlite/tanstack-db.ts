// SPIKE (phase 1 step 1): delete with the rest of src/spike at step 5.
// TanStack DB (1.0 RC) experiments, two shapes:
//  A. persisted collection on TanStack's own wa-sqlite OPFS adapter;
//  B. a collection whose sync/onInsert sit on OUR driver (reactive store above a storage port).
import {
  createCollection,
  createLiveQueryCollection,
  type SyncConfig,
  type Collection,
} from '@tanstack/db';
import {
  BrowserCollectionCoordinator,
  createBrowserWASQLitePersistence,
  openBrowserWASQLiteOPFSDatabase,
  persistedCollectionOptions,
} from '@tanstack/browser-db-sqlite-persistence';
import { openDriver, type DriverId, type SpikeDb } from './drivers';

type Ev = { id: string; session: string; seq: number; text: string };

const stores = new Map<
  string,
  {
    collection: Collection<Ev, string>;
    live: Collection<{ id: string }, string>;
    cleanup: () => Promise<void>;
    dump?: () => Promise<unknown>;
  }
>();
let nextStore = 1;

async function guard<T>(fn: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await fn();
  } catch (error) {
    const e = error as Error;
    return { error: `${e.name}: ${e.message}` };
  }
}

const liveFor = (collection: Collection<Ev, string>) =>
  createLiveQueryCollection({
    startSync: true,
    query: (q) => q.from({ e: collection }).select(({ e }) => ({ id: e.id })),
  }) as unknown as Collection<{ id: string }, string>;

export const api = {
  /** A: persisted collection on TanStack's adapter. */
  persisted(dbName: string, multiTab: boolean) {
    return guard(async () => {
      const t0 = performance.now();
      const database = await openBrowserWASQLiteOPFSDatabase({
        databaseName: dbName,
        timeoutMs: 8000,
      });
      const coordinator = multiTab ? new BrowserCollectionCoordinator({ dbName }) : undefined;
      const persistence = createBrowserWASQLitePersistence(
        coordinator ? { database, coordinator } : { database },
      );
      const collection = createCollection(
        persistedCollectionOptions<Ev, string>({
          id: 'events',
          getKey: (e) => e.id,
          persistence,
          schemaVersion: 1,
        }),
      ) as unknown as Collection<Ev, string>;
      await collection.stateWhenReady();
      const live = liveFor(collection);
      await live.preload();
      const handle = `s${nextStore++}`;
      stores.set(handle, {
        collection,
        live,
        cleanup: async () => {
          coordinator?.dispose();
          await database.close?.();
        },
        dump: () =>
          database.execute<{ name: string; sql: string }>(
            "SELECT name, sql FROM sqlite_master WHERE type = 'table'",
          ),
      });
      return { handle, readyMs: performance.now() - t0, initialSize: collection.size };
    });
  },

  /** B: collection above OUR driver (the storage port would own SQL; the store only mirrors it). */
  overDriver(driver: DriverId, dbName: string) {
    return guard(async () => {
      const t0 = performance.now();
      const db: SpikeDb = await openDriver(driver, dbName);
      await db.exec(
        'CREATE TABLE IF NOT EXISTS ev (id TEXT PRIMARY KEY, session TEXT NOT NULL, seq INTEGER NOT NULL, text TEXT NOT NULL)',
      );
      let confirm: ((rows: Ev[]) => void) | undefined;
      const sync: SyncConfig<Ev, string> = {
        sync: ({ begin, write, commit, markReady }) => {
          void (async () => {
            const rows = (await db.exec('SELECT * FROM ev ORDER BY seq')) as unknown as Ev[];
            begin();
            for (const value of rows) write({ type: 'insert', value });
            commit();
            markReady();
          })();
          confirm = (rows) => {
            begin();
            for (const value of rows) write({ type: 'insert', value });
            commit();
          };
        },
      };
      const collection = createCollection<Ev, string>({
        id: 'ev',
        getKey: (e) => e.id,
        sync,
        // The collection never talks SQL itself: the port append is the only writer.
        onInsert: async ({ transaction }) => {
          const rows = transaction.mutations.map((m) => m.modified as Ev);
          const statements = rows.map((r) => ({
            sql: 'INSERT INTO ev (id, session, seq, text) VALUES (?, ?, ?, ?)',
            params: [r.id, r.session, r.seq, r.text],
          }));
          if (db.batch) await db.batch(statements);
          else for (const s of statements) await db.exec(s.sql, s.params);
          confirm?.(rows);
        },
      });
      await collection.stateWhenReady();
      const live = liveFor(collection);
      await live.preload();
      const handle = `s${nextStore++}`;
      stores.set(handle, {
        collection,
        live,
        cleanup: () => db.close(),
        dump: () => db.exec('SELECT COUNT(*) AS c FROM ev'),
      });
      return { handle, readyMs: performance.now() - t0, initialSize: collection.size };
    });
  },

  insert(handle: string, id: string) {
    return guard(async () => {
      const s = stores.get(handle)!;
      const t0 = performance.now();
      const tx = s.collection.insert({ id, session: 's1', seq: Date.now() % 1e9, text: 'hello' });
      await tx.when('settled');
      return { persistMs: performance.now() - t0 };
    });
  },

  size(handle: string) {
    const s = stores.get(handle)!;
    return { collection: s.collection.size, live: s.live.size };
  },

  dump(handle: string) {
    return guard(async () => stores.get(handle)!.dump?.());
  },

  close(handle: string) {
    return guard(async () => {
      await stores.get(handle)?.cleanup();
      stores.delete(handle);
      return true;
    });
  },
};
