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
  // v2: accounts (plan step 2). Owned by the auth service of packages/server, not by the port.
  // `sessions.user_id` has no foreign key to `users`: v1 predates the table and SQLite cannot add
  // one later. Phase 2 never deletes an account, so no session can lose its owner.
  [
    `CREATE TABLE users (
       id TEXT PRIMARY KEY,
       email TEXT NOT NULL UNIQUE,
       password_hash TEXT NOT NULL,
       role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
       disabled INTEGER NOT NULL DEFAULT 0,
       created_at INTEGER NOT NULL
     ) WITHOUT ROWID`,
    `CREATE TABLE auth_tokens (
       token_hash TEXT PRIMARY KEY,
       user_id TEXT NOT NULL REFERENCES users (id),
       created_at INTEGER NOT NULL,
       expires_at INTEGER NOT NULL,
       revoked_at INTEGER
     ) WITHOUT ROWID`,
    `CREATE INDEX auth_tokens_by_user ON auth_tokens (user_id)`,
    `CREATE TABLE invites (
       code_hash TEXT PRIMARY KEY,
       created_by TEXT NOT NULL REFERENCES users (id),
       created_at INTEGER NOT NULL,
       expires_at INTEGER NOT NULL,
       used_at INTEGER,
       used_by TEXT
     ) WITHOUT ROWID`,
    `CREATE TABLE login_throttle (
       email TEXT PRIMARY KEY,
       failures INTEGER NOT NULL,
       window_start INTEGER NOT NULL,
       locked_until INTEGER
     ) WITHOUT ROWID`,
    `CREATE TABLE server_config (
       key TEXT PRIMARY KEY,
       value TEXT NOT NULL
     ) WITHOUT ROWID`,
  ],
];
