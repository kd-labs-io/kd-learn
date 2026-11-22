import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect, Fiber, Stream } from 'effect';
import { afterAll, describe, expect, it } from 'vitest';
import type { StorageChange } from '../port/index.ts';
import {
  portContract,
  propositionAdded,
  figureAdded,
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

  it('keeps knowledge events append-only', () => {
    const database = open();
    Effect.runSync(
      makeServerStorage(database)
        .forUser('u1')
        .appendKnowledge([propositionAdded('a', 1)], { expectedLastSeq: -1 }),
    );
    expect(() => database.db.exec("UPDATE knowledge_events SET tag = 'x'")).toThrow(/append-only/);
    expect(() => database.db.exec('DELETE FROM knowledge_events')).toThrow(/append-only/);
  });

  it('upgrades a v6 database to the knowledge log and keeps its sessions', async () => {
    const path = join(dir, 'v6.db');
    // A v6 server: write the rows by hand, since this build's driver expects v7.
    const old = open(path, serverMigrations.slice(0, 6));
    old.db.prepare("INSERT INTO sessions VALUES ('s1', 'u1', 1)").run();
    old.db
      .prepare("INSERT INTO events VALUES ('s1', 0, 'a', 'TurnStarted', 1, ?)")
      .run(JSON.stringify(turnStarted('a', 1)));
    old.close();
    const upgraded = open(path);
    const user = makeServerStorage(upgraded).forUser('u1');
    expect((await Effect.runPromise(user.readSession('s1'))).map((e) => e.id)).toEqual(['a']);
    await Effect.runPromise(
      user.appendKnowledge([propositionAdded('k1', 2)], { expectedLastSeq: -1 }),
    );
    expect((await Effect.runPromise(user.readKnowledge)).map((e) => e.id)).toEqual(['k1']);
    upgraded.close();
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

  it('keeps one knowledge log per user: no reads, writes, seq or notifications across', async () => {
    const { alice, bob } = await setup();
    await Effect.runPromise(
      alice.appendKnowledge([propositionAdded('a1', 1), propositionAdded('a2', 2)], {
        expectedLastSeq: -1,
      }),
    );
    // Bob's log is empty and starts at seq 0, whatever Alice wrote.
    expect(await Effect.runPromise(bob.readKnowledge)).toEqual([]);
    const seenByBob: StorageChange[] = [];
    const fiber = Effect.runFork(
      bob.changes.pipe(Stream.runForEach((change) => Effect.sync(() => seenByBob.push(change)))),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(
      (
        await Effect.runPromise(
          bob.appendKnowledge([propositionAdded('b1', 3)], { expectedLastSeq: -1 }),
        )
      ).lastSeq,
    ).toBe(0);
    // Ids are unique per owner: Bob may use an id Alice used, and it changes nothing of hers.
    await Effect.runPromise(
      bob.appendKnowledge([propositionAdded('a1', 4)], { expectedLastSeq: 0 }),
    );
    // Alice's log still ends at her own seq 1: Bob's writes did not move it.
    await Effect.runPromise(
      alice.appendKnowledge([propositionAdded('a3', 5)], { expectedLastSeq: 1 }),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(seenByBob).toEqual([{ _tag: 'KnowledgeChanged' }, { _tag: 'KnowledgeChanged' }]);
    await Effect.runPromise(Fiber.interrupt(fiber));
    expect((await Effect.runPromise(alice.readKnowledge)).map((e) => e.id)).toEqual([
      'a1',
      'a2',
      'a3',
    ]);
    expect((await Effect.runPromise(bob.readKnowledge)).map((e) => e.id)).toEqual(['b1', 'a1']);
  });

  it("neither reads, writes nor deletes another user's sources", async () => {
    const { alice, bob } = await setup();
    const info = {
      sourceId: 'doc',
      kind: 'note' as const,
      title: 'Doc',
      origin: 'a.md',
      createdAt: 1,
    };
    await Effect.runPromise(
      alice.createSource({ state: 'pending', info, file: new Uint8Array([1]) }),
    );
    expect(await Effect.runPromise(bob.listSources)).toEqual([]);
    expect(await Effect.runPromise(bob.getSource('doc'))).toBeUndefined();
    expect(await Effect.runPromise(bob.readSourceFile('doc'))).toBeUndefined();
    const chunks = [{ ordinal: 0, text: 'Bob text', locator: {} }];
    expect((await Effect.runPromiseExit(bob.completeSource('doc', chunks)))._tag).toBe('Failure');
    expect(
      (await Effect.runPromiseExit(bob.failSource('doc', { code: 'x', message: '' })))._tag,
    ).toBe('Failure');
    await Effect.runPromise(bob.deleteSource('doc'));
    // The same id is free for Bob: ids are per owner.
    await Effect.runPromise(bob.createSource({ state: 'ready', info, chunks }));
    expect(await Effect.runPromise(alice.readChunks(['doc']))).toEqual([]);
    expect((await Effect.runPromise(alice.getSource('doc')))?.state).toBe('pending');
  });

  it("neither reads nor shadows another user's figures", async () => {
    const { alice, bob } = await setup();
    const body = '<svg xmlns="http://www.w3.org/2000/svg"></svg>';
    await Effect.runPromise(
      alice.appendEvents(
        'a1',
        [turnStarted('t', 3), figureAdded('f1', 'turn-t', 'svg', body.length)],
        [{ figureId: 'f1', body }],
      ),
    );
    expect(await Effect.runPromise(bob.readFigure('f1'))).toBeUndefined();
    // The same figure id in Bob's own session is his own row.
    await Effect.runPromise(
      bob.appendEvents(
        'b1',
        [turnStarted('t2', 4), figureAdded('f1', 'turn-t2', 'svg', body.length)],
        [{ figureId: 'f1', body }],
      ),
    );
    expect((await Effect.runPromise(alice.readFigure('f1')))?.body).toBe(body);
    // A figure written to Alice's session by Bob fails like any write to it.
    const exit = await Effect.runPromiseExit(
      bob.appendEvents(
        'a1',
        [turnStarted('t3', 5), figureAdded('f9', 'turn-t3', 'svg', body.length)],
        [{ figureId: 'f9', body }],
      ),
    );
    expect(exit._tag).toBe('Failure');
    expect(await Effect.runPromise(alice.readFigure('f9'))).toBeUndefined();
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
