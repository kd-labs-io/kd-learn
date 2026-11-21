// Server migrations (plan tai-khoan.md A3). A separate list from the guest one, because
// `PRAGMA user_version` counts the migrations of one list: sharing a list would shift the numbers
// whenever the guest database gains a migration. The event log DDL itself is shared.
//
// Every server table lives in this one list, including those owned by services outside the storage
// port (users, tokens, admin config, demo budget), so one database has one version number.
// Never edit a migration that has shipped: add the next one.
import { eventsTable } from '../sqlite/schema.ts';

export const serverMigrations: ReadonlyArray<ReadonlyArray<string>> = [
  // v1: event log, and the owner of each session.
  [
    ...eventsTable,
    `CREATE TABLE sessions (
       session_id TEXT PRIMARY KEY,
       user_id TEXT NOT NULL,
       created_at INTEGER NOT NULL
     ) WITHOUT ROWID`,
    `CREATE INDEX sessions_by_user ON sessions (user_id)`,
  ],
];
