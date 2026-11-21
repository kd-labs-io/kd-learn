// SPIKE (phase 1 step 1): delete with the rest of src/spike at step 5.
// Uniform surface over the candidate drivers so one suite can test them all.
export type Row = Record<string, unknown>;
export interface SpikeDb {
  readonly name: string;
  exec(sql: string, params?: unknown[]): Promise<Row[]>;
  /** Atomic multi-statement transaction, or undefined when the driver has none. */
  batch?(statements: { sql: string; params?: unknown[] }[]): Promise<void>;
  close(): Promise<void>;
}

export type DriverId = 'tanstack-wa' | 'own-wa' | 'official-opfs' | 'official-sahpool';

export async function openTanstackWa(dbName: string): Promise<SpikeDb> {
  const { openBrowserWASQLiteOPFSDatabase } =
    await import('@tanstack/browser-db-sqlite-persistence');
  const database = await openBrowserWASQLiteOPFSDatabase({ databaseName: dbName, timeoutMs: 8000 });
  return {
    name: 'tanstack-wa',
    exec: (sql, params) => database.execute<Row>(sql, params) as Promise<Row[]>,
    close: async () => database.close?.(),
  };
}

export function openOfficial(dbName: string, vfs: 'opfs' | 'sahpool'): Promise<SpikeDb> {
  const worker = new Worker(new URL('./official-worker.ts', import.meta.url), { type: 'module' });
  return connectWorker(worker, `official-${vfs}`, { op: 'open', vfs, name: dbName });
}

/** Our own worker around raw @journeyapps/wa-sqlite (OPFSCoopSyncVFS). */
export function openOwnWa(dbName: string): Promise<SpikeDb> {
  const worker = new Worker(new URL('./wa-worker.ts', import.meta.url), { type: 'module' });
  return connectWorker(worker, 'own-wa', { op: 'open', name: dbName });
}

async function connectWorker(
  worker: Worker,
  name: string,
  openMessage: Record<string, unknown>,
): Promise<SpikeDb> {
  let next = 1;
  const pending = new Map<number, { resolve: (rows: Row[]) => void; reject: (e: Error) => void }>();
  worker.onmessage = (
    event: MessageEvent<{ id: number; ok: boolean; rows?: Row[]; error?: string }>,
  ) => {
    const p = pending.get(event.data.id);
    if (!p) return;
    pending.delete(event.data.id);
    if (event.data.ok) p.resolve(event.data.rows ?? []);
    else p.reject(new Error(event.data.error));
  };
  worker.onerror = (event) => {
    for (const p of pending.values()) p.reject(new Error(`worker error: ${event.message}`));
    pending.clear();
  };
  const send = (message: Record<string, unknown>, timeoutMs = 8000) =>
    new Promise<Row[]>((resolve, reject) => {
      const id = next++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      pending.set(id, {
        resolve: (rows) => (clearTimeout(timer), resolve(rows)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      worker.postMessage({ id, ...message });
    });
  try {
    await send(openMessage);
  } catch (error) {
    worker.terminate();
    throw error;
  }
  return {
    name,
    exec: (sql, params) => send({ op: 'exec', sql, params }),
    batch: async (statements) => void (await send({ op: 'batch', statements })),
    close: async () => {
      await send({ op: 'close' }).catch(() => undefined);
      worker.terminate();
    },
  };
}

export function openDriver(id: DriverId, dbName: string): Promise<SpikeDb> {
  if (id === 'tanstack-wa') return openTanstackWa(dbName);
  if (id === 'own-wa') return openOwnWa(dbName);
  return openOfficial(dbName, id === 'official-opfs' ? 'opfs' : 'sahpool');
}
