import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Deferred, Effect, Schema } from 'effect';
import { afterAll, describe, expect, it } from 'vitest';
import { openServerDatabase } from '@kd-learn/storage/sqlite-node';
import type { LogEntry } from '../handler.ts';
import { makeJobRunner, type JobKind } from './runner.ts';

const dir = mkdtempSync(join(tmpdir(), 'kd-jobs-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const Payload = Schema.Struct({ n: Schema.Finite });

/** A process over `path`: a runner with one kind whose jobs wait for `release(n)`. */
const process = (path: string, options: { global?: number; fail?: boolean } = {}) => {
  const database = Effect.runSync(openServerDatabase({ path }));
  const logs: LogEntry[] = [];
  const runner = makeJobRunner({ database, log: (entry) => logs.push(entry) });
  const gates = new Map<number, Deferred.Deferred<void>>();
  const gate = (n: number) => {
    let g = gates.get(n);
    if (g === undefined) {
      g = Effect.runSync(Deferred.make<void>());
      gates.set(n, g);
    }
    return g;
  };
  const started: Array<{ userId: string; n: number }> = [];
  const finished: Array<{ userId: string; n: number }> = [];
  const abandoned: Array<{ userId: string; n: number }> = [];
  const kind: JobKind<{ readonly n: number }> = {
    kind: 'test',
    payload: Payload,
    ...(options.global === undefined ? {} : { global: options.global }),
    run: (userId, { n }) =>
      Effect.gen(function* () {
        started.push({ userId, n });
        yield* Deferred.await(gate(n));
        if (options.fail) return yield* Effect.die(new Error('boom'));
        finished.push({ userId, n });
      }),
    abandon: (userId, { n }) => {
      abandoned.push({ userId, n });
    },
  };
  runner.register(kind);
  const release = (n: number) => Effect.runSync(Deferred.succeed(gate(n), undefined));
  const rows = () =>
    database.db.prepare('SELECT user_id, key, state, attempts FROM jobs ORDER BY rowid').all();
  return { runner, kind, release, started, finished, abandoned, rows, logs, database };
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe('job runner', () => {
  it('runs one job of a kind at a time per user, users in parallel, and deletes finished rows', async () => {
    const p = process(':memory:');
    p.runner.resume();
    expect(p.runner.enqueue('a', p.kind, 'k1', { n: 1 })).toBe(true);
    expect(p.runner.enqueue('a', p.kind, 'k1', { n: 1 })).toBe(false);
    expect(p.runner.enqueue('a', p.kind, 'k2', { n: 2 })).toBe(true);
    expect(p.runner.enqueue('b', p.kind, 'k1', { n: 3 })).toBe(true);
    await tick();
    expect(p.started).toEqual([
      { userId: 'a', n: 1 },
      { userId: 'b', n: 3 },
    ]);
    expect(p.runner.state('a', 'test', 'k2')).toBe('queued');
    expect(p.runner.state('a', 'test', 'k1')).toBe('running');
    p.release(1);
    p.release(2);
    p.release(3);
    await p.runner.idle();
    expect(p.finished.map((f) => f.n).sort()).toEqual([1, 2, 3]);
    expect(p.rows()).toEqual([]);
    expect(p.runner.state('a', 'test', 'k1')).toBeUndefined();
  });

  it('bounds a kind across users', async () => {
    const p = process(':memory:', { global: 1 });
    p.runner.resume();
    p.runner.enqueue('a', p.kind, 'k', { n: 1 });
    p.runner.enqueue('b', p.kind, 'k', { n: 2 });
    await tick();
    expect(p.started.map((s) => s.n)).toEqual([1]);
    p.release(1);
    await tick();
    expect(p.started.map((s) => s.n)).toEqual([1, 2]);
    p.release(2);
    await p.runner.idle();
  });

  it('does not retry a job that failed: the row is gone', async () => {
    const p = process(':memory:', { fail: true });
    p.runner.resume();
    p.runner.enqueue('a', p.kind, 'k', { n: 1 });
    p.release(1);
    await p.runner.idle();
    expect(p.rows()).toEqual([]);
    expect(p.logs.map((l) => l.event)).toContain('jobs.crashed');
  });

  it('takes over queued and running rows after a restart, then abandons after three starts', async () => {
    const path = join(dir, `${crypto.randomUUID()}.db`);
    const first = process(path, { global: 1 });
    first.runner.resume();
    first.runner.enqueue('a', first.kind, 'k1', { n: 1 });
    first.runner.enqueue('b', first.kind, 'k2', { n: 2 });
    await tick();
    expect(first.rows()).toEqual([
      { user_id: 'a', key: 'k1', state: 'running', attempts: 1 },
      { user_id: 'b', key: 'k2', state: 'queued', attempts: 0 },
    ]);
    await first.runner.stopAll();
    first.database.close();

    const second = process(path, { global: 1 });
    second.runner.resume();
    await tick();
    // Same order as before: the job cut by the restart first.
    expect(second.started).toEqual([{ userId: 'a', n: 1 }]);
    expect(second.logs.map((l) => l.event)).toContain('jobs.resumed');
    await second.runner.stopAll();
    second.database.close();

    const third = process(path, { global: 1 });
    third.runner.resume();
    await tick();
    expect(third.started).toEqual([{ userId: 'a', n: 1 }]);
    await third.runner.stopAll();
    third.database.close();

    const fourth = process(path, { global: 1 });
    fourth.runner.resume();
    await tick();
    expect(fourth.abandoned).toEqual([{ userId: 'a', n: 1 }]);
    expect(fourth.started).toEqual([{ userId: 'b', n: 2 }]);
    fourth.release(2);
    await fourth.runner.idle();
    expect(fourth.finished).toEqual([{ userId: 'b', n: 2 }]);
    expect(fourth.rows()).toEqual([]);
  });

  it('drops rows of an unknown kind or with an unreadable payload', async () => {
    const p = process(':memory:');
    const insert = p.database.db.prepare(
      `INSERT INTO jobs (id, user_id, kind, key, payload, state, attempts, created_at, updated_at)
       VALUES (?, 'a', ?, ?, ?, 'queued', 0, 1, 1)`,
    );
    insert.run('j1', 'gone', 'k', '{}');
    insert.run('j2', 'test', 'k', '{"n":"not a number"}');
    p.runner.resume();
    expect(p.rows()).toEqual([]);
    expect(p.logs.filter((l) => l.event === 'jobs.dropped')).toHaveLength(2);
  });
});
