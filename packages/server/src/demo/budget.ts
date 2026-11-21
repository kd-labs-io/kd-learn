// The shared demo budget (plan tai-khoan.md A8): one count of model calls for every demo user.
// A turn reserves before the provider is called and gives back what it did not use when it ends.
// Reservations are synchronous SQLite transactions in one process, so two requests at the edge
// of the budget cannot both pass. A crash keeps the reservation: the count may run high, never low.
import type { DemoBudget, DemoBudgetPeriod } from '@kd-learn/api';
import type { ServerDatabase } from '@kd-learn/storage/sqlite-node';

export interface Reservation {
  readonly periodKey: string;
  readonly calls: number;
}

export type ReserveResult =
  | { readonly _tag: 'Ok'; readonly reservation: Reservation }
  /** The limit is 0. */
  | { readonly _tag: 'Closed' }
  | { readonly _tag: 'Exceeded' };

export interface DemoBudgetService {
  readonly status: () => DemoBudget;
  readonly setLimit: (limit: number) => void;
  readonly setPeriod: (period: DemoBudgetPeriod) => void;
  /** Reserves up to `max` calls, fewer when the budget has less left; at least one. */
  readonly reserve: (max: number) => ReserveResult;
  /** Gives back the calls of the reservation that were not used. Call once per reservation. */
  readonly settle: (reservation: Reservation, used: number) => void;
}

/** The UTC day or month of `at`, or one period for all time. */
export const periodKey = (period: DemoBudgetPeriod, at: number): string => {
  const iso = new Date(at).toISOString();
  switch (period) {
    case 'day':
      return `day:${iso.slice(0, 10)}`;
    case 'month':
      return `month:${iso.slice(0, 7)}`;
    case 'none':
      return 'none';
  }
};

export const makeDemoBudget = (
  database: ServerDatabase,
  defaults: { readonly limit: number; readonly period: DemoBudgetPeriod },
  now: () => number = Date.now,
): DemoBudgetService => {
  const { db } = database;
  const q = {
    get: db.prepare('SELECT value FROM server_config WHERE key = ?'),
    put: db.prepare('INSERT OR REPLACE INTO server_config (key, value) VALUES (?, ?)'),
    used: db.prepare('SELECT used FROM demo_usage WHERE period_key = ?'),
    add: db.prepare(
      `INSERT INTO demo_usage (period_key, used) VALUES (?, ?)
       ON CONFLICT (period_key) DO UPDATE SET used = used + excluded.used`,
    ),
    refund: db.prepare('UPDATE demo_usage SET used = MAX(0, used - ?) WHERE period_key = ?'),
  };
  const read = (key: string) => (q.get.get(key) as { value: string } | undefined)?.value;
  const limit = () => {
    const stored = read('demoBudgetLimit');
    return stored === undefined ? defaults.limit : Number(stored);
  };
  const period = () =>
    (read('demoBudgetPeriod') as DemoBudgetPeriod | undefined) ?? defaults.period;
  const usedIn = (key: string) =>
    Number((q.used.get(key) as { used: number } | undefined)?.used ?? 0);

  return {
    status: () => {
      const p = period();
      return { limit: limit(), period: p, used: usedIn(periodKey(p, now())) };
    },
    setLimit: (value) => void q.put.run('demoBudgetLimit', String(value)),
    setPeriod: (value) => void q.put.run('demoBudgetPeriod', value),
    reserve: (max) =>
      database.transaction((): ReserveResult => {
        const cap = limit();
        if (cap <= 0) return { _tag: 'Closed' };
        const key = periodKey(period(), now());
        const left = cap - usedIn(key);
        if (left <= 0) return { _tag: 'Exceeded' };
        const calls = Math.max(1, Math.min(max, left));
        q.add.run(key, calls);
        return { _tag: 'Ok', reservation: { periodKey: key, calls } };
      }),
    settle: (reservation, used) => {
      const unused = reservation.calls - Math.min(Math.max(used, 0), reservation.calls);
      if (unused > 0) q.refund.run(unused, reservation.periodKey);
    },
  };
};
