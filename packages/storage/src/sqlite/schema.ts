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

/**
 * DDL of the append-only knowledge log (plan luyen-tap-graph.md A1): one log per owner. Guests have
 * one owner (`guestOwner`); the server uses the user id. Ids are unique per owner, so one user's
 * ids can never make another user's batch fail.
 */
export const knowledgeEventsTable: ReadonlyArray<string> = [
  `CREATE TABLE knowledge_events (
     owner TEXT NOT NULL,
     seq INTEGER NOT NULL,
     id TEXT NOT NULL,
     tag TEXT NOT NULL,
     at INTEGER NOT NULL,
     payload TEXT NOT NULL,
     PRIMARY KEY (owner, seq),
     UNIQUE (owner, id)
   ) WITHOUT ROWID`,
  `CREATE TRIGGER knowledge_events_no_update BEFORE UPDATE ON knowledge_events
     BEGIN SELECT RAISE(ABORT, 'knowledge events are append-only'); END`,
  `CREATE TRIGGER knowledge_events_no_delete BEFORE DELETE ON knowledge_events
     BEGIN SELECT RAISE(ABORT, 'knowledge events are append-only'); END`,
];

/**
 * DDL of learning sources (plan nguon-hoc.md A2): not events, so rows change (state) and are
 * deleted with their source. `owner` as for the knowledge log. The original file is kept only until
 * ingest ends, to run it again after an interruption.
 */
/**
 * DDL of figure bodies (plan hinh-va-demo.md A1). The log holds `FigureAdded` (metadata); the body
 * is written in the same transaction as the turn's events. Text kinds fill `text`, images `blob`.
 * `owner` as for the knowledge log.
 */
export const figuresTable: ReadonlyArray<string> = [
  `CREATE TABLE figures (
     owner TEXT NOT NULL,
     figure_id TEXT NOT NULL,
     session_id TEXT NOT NULL,
     text TEXT,
     blob BLOB,
     PRIMARY KEY (owner, figure_id),
     CHECK ((text IS NULL) <> (blob IS NULL))
   ) WITHOUT ROWID`,
  `CREATE INDEX figures_by_session ON figures (owner, session_id)`,
];

export const sourcesTables: ReadonlyArray<string> = [
  `CREATE TABLE sources (
     owner TEXT NOT NULL,
     source_id TEXT NOT NULL,
     kind TEXT NOT NULL,
     title TEXT NOT NULL,
     origin TEXT NOT NULL,
     state TEXT NOT NULL CHECK (state IN ('pending', 'ready', 'failed')),
     failure TEXT,
     bytes INTEGER NOT NULL,
     chunk_count INTEGER NOT NULL,
     created_at INTEGER NOT NULL,
     PRIMARY KEY (owner, source_id)
   ) WITHOUT ROWID`,
  `CREATE TABLE source_chunks (
     owner TEXT NOT NULL,
     source_id TEXT NOT NULL,
     ordinal INTEGER NOT NULL,
     text TEXT NOT NULL,
     locator TEXT NOT NULL,
     PRIMARY KEY (owner, source_id, ordinal)
   ) WITHOUT ROWID`,
  `CREATE TABLE source_files (
     owner TEXT NOT NULL,
     source_id TEXT NOT NULL,
     bytes BLOB NOT NULL,
     PRIMARY KEY (owner, source_id)
   ) WITHOUT ROWID`,
];

/** The only owner of a guest database (one person per local DB). */
export const guestOwner = 'guest';

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
  // v2: the saved teaching profile (phase 3 A2). One person per local DB, so at most one row.
  [
    `CREATE TABLE teaching_profile (
       slot INTEGER PRIMARY KEY CHECK (slot = 1),
       payload TEXT NOT NULL,
       updated_at INTEGER NOT NULL
     )`,
  ],
  // v3: knowledge log (phase 3 step 2).
  [...knowledgeEventsTable],
  // v4: learning sources (phase 4 step 4).
  [...sourcesTables],
  // v5: figure bodies (phase 5 A1).
  [...figuresTable],
];

/** The schema version this build of the code expects. */
export const schemaVersion = migrations.length;

/** Keys of the `settings` table. */
export const settingsKeys = [
  'provider',
  'model',
  'endpointId',
  'apiKey',
  'imageProvider',
  'imageModel',
  'imageEndpointId',
  'imageApiKey',
] as const;
export type SettingsKey = (typeof settingsKeys)[number];
