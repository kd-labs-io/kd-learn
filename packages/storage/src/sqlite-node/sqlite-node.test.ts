import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect, Fiber, Stream } from 'effect';
import { afterAll, describe, expect, it } from 'vitest';
import type { StorageChange } from '../port/index.ts';
import {
  portContract,
  savedProfile,
  sessionCreated,
  turnStarted,
} from '../testing/port-contract.ts';
import { makeServerStorage, openServerDatabase, serverMigrations } from './index.ts';

const open = (path = ':memory:', migrations = serverMigrations) =>
  Effect.runSync(openServerDatabase({ path, migrations }));

portContract('sqlite-node', () => makeServerStorage(open()).forUser('u1'));

const dir = mkdtempSync(join(tmpdir(), 'kd-sqlite-node-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('sqlite-node database', () => {
  it('migrates a new file once, in WAL mode, and keeps data across reopen', async () => {
    const path = join(dir, 'reopen.db');
    const first = open(path);
    expect(first.db.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
    expect(first.db.prepare('PRAGMA user_version').get()).toEqual({
      user_version: serverMigrations.length,
    });
    await Effect.runPromise(
      makeServerStorage(first)
        .forUser('u1')
        .appendEvents('s1', [turnStarted('a', 1)]),
    );
    first.close();

    const second = open(path);
    const log = await Effect.runPromise(makeServerStorage(second).forUser('u1').readSession('s1'));
    expect(log.map((event) => event.id)).toEqual(['a']);
    second.close();
  });

  it('applies only the new migrations of a longer list', () => {
    const path = join(dir, 'upgrade.db');
    open(path).close();
    const next = [...serverMigrations, ['CREATE TABLE extra (id TEXT PRIMARY KEY)']];
    const upgraded = open(path, next);
    expect(upgraded.db.prepare('PRAGMA user_version').get()).toEqual({ user_version: next.length });
    upgraded.close();
  });

  it('refuses a database newer than the server', () => {
    const path = join(dir, 'newer.db');
    open(path, [...serverMigrations, ['CREATE TABLE extra (id TEXT PRIMARY KEY)']]).close();
    const exit = Effect.runSyncExit(openServerDatabase({ path }));
    expect(exit._tag).toBe('Failure');
  });

  it('keeps events append-only', () => {
    const database = open();
    Effect.runSync(
      makeServerStorage(database)
        .forUser('u1')
        .appendEvents('s1', [turnStarted('a', 1)]),
    );
    expect(() => database.db.exec("UPDATE events SET tag = 'x'")).toThrow(/append-only/);
    expect(() => database.db.exec('DELETE FROM events')).toThrow(/append-only/);
  });

  it('rolls back a transaction body that throws, and rejects an async one', () => {
    const database = open();
    database.db.exec('CREATE TABLE t (v INTEGER)');
    expect(() =>
      database.transaction(() => {
        database.db.exec('INSERT INTO t VALUES (1)');
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(() =>
      database.transaction(() => {
        database.db.exec('INSERT INTO t VALUES (2)');
        return Promise.resolve();
      }),
    ).toThrow(/synchronous/);
    expect(database.db.prepare('SELECT COUNT(*) AS n FROM t').get()).toEqual({ n: 0 });
    expect(database.db.isTransaction).toBe(false);
  });
});

describe('sqlite-node: two users', () => {
  const setup = async () => {
    const storage = makeServerStorage(open());
    const alice = storage.forUser('alice');
    const bob = storage.forUser('bob');
    await Effect.runPromise(alice.appendEvents('a1', [sessionCreated('a1', 'Fractions', 1)]));
    await Effect.runPromise(bob.appendEvents('b1', [sessionCreated('b1', 'Graphs', 2)]));
    return { alice, bob };
  };

  it('lists only the sessions of the user', async () => {
    const { alice, bob } = await setup();
    expect((await Effect.runPromise(alice.listSessions)).map((row) => row.sessionId)).toEqual([
      'a1',
    ]);
    expect((await Effect.runPromise(bob.listSessions)).map((row) => row.sessionId)).toEqual(['b1']);
  });

  it("reads another user's session as unknown", async () => {
    const { bob } = await setup();
    expect(await Effect.runPromise(bob.readSession('a1'))).toEqual([]);
    expect((await Effect.runPromise(bob.appendEvents('a1', []))).lastSeq).toBe(-1);
  });

  it("cannot write to another user's session", async () => {
    const { alice, bob } = await setup();
    const exit = await Effect.runPromiseExit(bob.appendEvents('a1', [turnStarted('x', 3)]));
    expect(exit._tag).toBe('Failure');
    expect(JSON.stringify(exit)).toContain('Unknown session a1');
    const log = await Effect.runPromise(alice.readSession('a1'));
    expect(log.map((event) => event.id)).toEqual(['created-a1']);
  });

  it('notifies only the owner of a commit', async () => {
    const { alice, bob } = await setup();
    const seenByBob: StorageChange[] = [];
    const fiber = Effect.runFork(
      bob.changes.pipe(Stream.runForEach((change) => Effect.sync(() => seenByBob.push(change)))),
    );
    const seenByAlice = Effect.runPromise(alice.changes.pipe(Stream.take(1), Stream.runCollect));
    await new Promise((resolve) => setTimeout(resolve, 10));
    await Effect.runPromise(alice.appendEvents('a1', [turnStarted('y', 4)]));
    expect(await seenByAlice).toEqual([{ _tag: 'SessionChanged', sessionId: 'a1' }]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(seenByBob).toEqual([]);
    await Effect.runPromise(Fiber.interrupt(fiber));
  });

  it("neither reads nor replaces another user's profile", async () => {
    const { alice, bob } = await setup();
    await Effect.runPromise(alice.saveProfile({ ...savedProfile, name: 'Alice' }));
    expect(await Effect.runPromise(bob.getProfile)).toBeUndefined();
    await Effect.runPromise(bob.saveProfile({ ...savedProfile, name: 'Bob' }));
    await Effect.runPromise(bob.saveProfile(undefined));
    expect((await Effect.runPromise(alice.getProfile))?.name).toBe('Alice');
  });

  it('does not store guest settings', async () => {
    const { alice } = await setup();
    expect(await Effect.runPromise(alice.getSettings)).toBeUndefined();
    const exit = await Effect.runPromiseExit(
      alice.saveSettings({ provider: 'anthropic', model: 'haiku', apiKey: 'secret' }),
    );
    expect(exit._tag).toBe('Failure');
  });
});
