// Client-side access to the storage port (plan step 5). One storage per page, opened on first use.
// The SQLite driver is loaded with a dynamic import behind `import.meta.env.SSR`: Vite replaces the
// flag with a constant, so the server build drops the branch and its Worker and WASM never enter
// `.output/server` (checked in CI by scripts/check-server-bundle.mjs).
import { Cause, Effect } from 'effect';
import { makeMemoryStorage } from '@kd-learn/storage/memory';
import { StorageUnavailable, type StorageError, type StorageService } from '@kd-learn/storage/port';

let current: Promise<StorageService> | undefined;
let listening = false;

async function openStorage(): Promise<StorageService> {
  if (!import.meta.env.SSR) {
    const { openWasmStorage } = await import('@kd-learn/storage/sqlite-wasm');
    const opened = await Effect.runPromiseExit(openWasmStorage());
    if (opened._tag === 'Success') return opened.value;
    const failure = Cause.squash(opened.cause);
    // Only "this context has no OPFS" (private window, some WebKit contexts) falls back to memory;
    // the UI shows `persistent`. A timeout or a migration error is thrown, so the learner sees an
    // error instead of an empty list that loses new work.
    if (!(failure instanceof StorageUnavailable)) throw failure;
    console.warn('Local storage is not persistent in this browser context.', failure.message);
  }
  return makeMemoryStorage();
}

/** The page's storage. Server render never calls this: it runs from effects and event handlers. */
export function getStorage(): Promise<StorageService> {
  if (!listening && typeof window !== 'undefined') {
    listening = true;
    // A page restored from the back/forward cache lost its Worker: open a new connection.
    window.addEventListener('pageshow', (event) => {
      if (event.persisted) current = undefined;
    });
  }
  // A rejected open is not cached: the next call tries again.
  current ??= openStorage().catch((error: unknown) => {
    current = undefined;
    throw error;
  });
  return current;
}

/** Runs one storage call. Rejects with the typed `StorageError`. */
export async function runStorage<A>(
  use: (storage: StorageService) => Effect.Effect<A, StorageError>,
): Promise<A> {
  return Effect.runPromise(use(await getStorage()));
}
