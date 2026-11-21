// SQL schema and migrations, shared by every SQLite driver (sqlite-wasm now, sqlite-node in phase 2).
// Pure data: no driver code here. A migration runs once, inside one transaction, and the database
// version is `PRAGMA user_version` (the number of migrations applied).

/** Migrations in order. Never edit one that has shipped: add the next one. */
export const migrations: ReadonlyArray<ReadonlyArray<string>> = [
  // v1: append-only event log and the guest settings.
  [
    `CREATE TABLE events (
       session_id TEXT NOT NULL,
       seq INTEGER NOT NULL,
       id TEXT NOT NULL UNIQUE,
       tag TEXT NOT NULL,
       at INTEGER NOT NULL,
       payload TEXT NOT NULL,
       PRIMARY KEY (session_id, seq)
     ) WITHOUT ROWID`,
    `CREATE TRIGGER events_no_update BEFORE UPDATE ON events
       BEGIN SELECT RAISE(ABORT, 'events are append-only'); END`,
    `CREATE TRIGGER events_no_delete BEFORE DELETE ON events
       BEGIN SELECT RAISE(ABORT, 'events are append-only'); END`,
    `CREATE TABLE settings (
       key TEXT PRIMARY KEY,
       value TEXT NOT NULL
     ) WITHOUT ROWID`,
  ],
];

/** The schema version this build of the code expects. */
export const schemaVersion = migrations.length;

/** Keys of the `settings` table. */
export const settingsKeys = ['provider', 'model', 'baseURL', 'apiKey'] as const;
export type SettingsKey = (typeof settingsKeys)[number];
