// The server database: one `node:sqlite` connection for the whole process (plan step 0, C1).
// SERVER ONLY.
//
// `node:sqlite` is synchronous. A batch runs between BEGIN IMMEDIATE and COMMIT inside one
// synchronous call, with no `await` in between, so no other request can interleave with it and no
// transaction stays open across requests. That is what makes a batch atomic here; keep it that way.
// `DatabaseSync` is a documentation-only deprecated alias of `Database` (DEP0210), but
// @types/node 26.6 types only `DatabaseSync`. Switch the name when the types catch up.
import { DatabaseSync as Database } from 'node:sqlite';
import { Effect } from 'effect';
import { StorageBusy, StorageFailure, type StorageError } from '../port/index.ts';
import { serverMigrations } from './schema.ts';

export interface ServerDatabaseOptions {
  /** File path, or `:memory:` for tests. */
  readonly path: string;
  /** Defaults to the server migrations. Tests may pass a longer list to check upgrades. */
  readonly migrations?: ReadonlyArray<ReadonlyArray<string>>;
  /** How long a write waits for a lock held by another connection (a backup, the sqlite3 CLI). */
  readonly busyTimeoutMs?: number;
}

export interface ServerDatabase {
  /** The raw connection, for services outside the storage port. Write through `transaction`. */
  readonly db: Database;
  /**
   * Runs `work` between BEGIN IMMEDIATE and COMMIT, and rolls back when it throws. `work` must be
   * synchronous: returning a Promise is a bug, because the transaction would commit before it ran.
   */
  readonly transaction: <T>(work: () => T) => T;
  readonly close: () => void;
}

/** Maps anything a `node:sqlite` call throws to a typed storage error. */
export const toStorageError = (error: unknown): StorageError => {
  if (error instanceof StorageBusy || error instanceof StorageFailure) return error;
  const message = error instanceof Error ? error.message : String(error);
  // SQLITE_BUSY (5) and SQLITE_LOCKED (6): another connection holds the lock past the timeout.
  const code = (error as { errcode?: unknown } | null)?.errcode;
  return code === 5 || code === 6 ? new StorageBusy({ message }) : new StorageFailure({ message });
};

const makeTransaction =
  (db: Database) =>
  <T>(work: () => T): T => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      if (result instanceof Promise) throw new Error('A transaction body must be synchronous');
      db.exec('COMMIT');
      return result;
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    }
  };

/** Opens (or creates) the database and applies the migrations it has not seen. */
export const openServerDatabase = (
  options: ServerDatabaseOptions,
): Effect.Effect<ServerDatabase, StorageError> =>
  Effect.try({
    try: () => {
      const { path, migrations = serverMigrations, busyTimeoutMs = 5000 } = options;
      const db = new Database(path);
      try {
        db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(busyTimeoutMs))}`);
        db.exec('PRAGMA journal_mode = WAL');
        db.exec('PRAGMA synchronous = NORMAL');
        db.exec('PRAGMA foreign_keys = ON');
        const transaction = makeTransaction(db);
        migrate(db, transaction, migrations);
        return { db, transaction, close: () => db.close() };
      } catch (error) {
        db.close();
        throw error;
      }
    },
    catch: toStorageError,
  });

function migrate(
  db: Database,
  transaction: ServerDatabase['transaction'],
  migrations: ReadonlyArray<ReadonlyArray<string>>,
): void {
  transaction(() => {
    const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
    const version = Number(row?.user_version ?? 0);
    if (version > migrations.length) {
      throw new StorageFailure({
        message: `Database schema v${version} is newer than this server (v${migrations.length})`,
      });
    }
    for (let next = version; next < migrations.length; next++) {
      for (const statement of migrations[next] ?? []) db.exec(statement);
      // PRAGMA takes no bound parameters; `next` is a number from our own loop.
      db.exec(`PRAGMA user_version = ${next + 1}`);
    }
  });
}
