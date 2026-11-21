// SPIKE (phase 1 step 1): SQLite WASM driver spike page. Delete at step 5, together
// with src/spike. Driven by apps/web/scripts/spike-sqlite.mjs; not linked from the app.
import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';

export const Route = createFileRoute('/spike/sqlite')({ component: SpikeSqlite });

declare global {
  interface Window {
    __spike?: typeof import('../spike/sqlite/suite').api;
    __spikeTanstackDb?: typeof import('../spike/sqlite/tanstack-db').api;
    __spikeHydratedAt?: number;
  }
}

function SpikeSqlite() {
  const [state, setState] = useState('ssr');
  useEffect(() => {
    // Runs after hydration only; the server render never touches Worker or WASM.
    window.__spikeHydratedAt = performance.now();
    void (async () => {
      const [{ api }, { api: tsdb }] = await Promise.all([
        import('../spike/sqlite/suite'),
        import('../spike/sqlite/tanstack-db'),
      ]);
      window.__spike = api;
      window.__spikeTanstackDb = tsdb;
      setState('ready');
    })();
  }, []);
  return (
    <main>
      <h1>SQLite WASM spike</h1>
      <p id="spike-state">{state}</p>
    </main>
  );
}
