// SQL schema shared by every SQLite driver, and the guest migrations (sqlite-wasm).
// Pure data: no driver code here. A migration runs once, inside one transaction, and the database
// version is `PRAGMA user_version` (the number of migrations applied).

/**
 * DDL of the append-only event log. Shared by the guest migrations below and the server migrations
 * (`sqlite-node/schema.ts`), which keep their own list because `user_version` counts migrations.
 */
export const eventsTable: ReadonlyArray<string> = [
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
];

/** Guest migrations (sqlite-wasm) in order. Never edit one that has shipped: add the next one. */
export const migrations: ReadonlyArray<ReadonlyArray<string>> = [
  // v1: append-only event log and the guest settings.
  [
    ...eventsTable,
    `CREATE TABLE settings (
       key TEXT PRIMARY KEY,
       value TEXT NOT NULL
     ) WITHOUT ROWID`,
  ],
];

/** The schema version this build of the code expects. */
export const schemaVersion = migrations.length;

/** Keys of the `settings` table. */
export const settingsKeys = ['provider', 'model', 'endpointId', 'apiKey'] as const;
export type SettingsKey = (typeof settingsKeys)[number];
