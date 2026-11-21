// Cross-tab mutual exclusion for turns (plan A3, step 5 note): two tabs must not send the same
// turn. A Web Lock lives exactly as long as the tab, so a reload or a crash releases it, which a
// flag in the database would not.

/** Runs `run` only if nobody else holds `name`. `acquired: false` means another holder exists. */
export type WithLock = <A>(
  name: string,
  run: () => Promise<A>,
) => Promise<{ readonly acquired: true; readonly value: A } | { readonly acquired: false }>;

/** Locks held in this tab. Also the whole mechanism where Web Locks do not exist. */
const heldHere = new Set<string>();

export const withLock: WithLock = async (name, run) => {
  if (heldHere.has(name)) return { acquired: false };
  heldHere.add(name);
  try {
    const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
    if (locks === undefined) return { acquired: true, value: await run() };
    return await locks.request(name, { ifAvailable: true }, async (lock) =>
      lock === null
        ? { acquired: false as const }
        : { acquired: true as const, value: await run() },
    );
  } finally {
    heldHere.delete(name);
  }
};

/** True when another tab (or this one) holds `name`. Without Web Locks nothing is known: false. */
export async function isLockHeld(name: string): Promise<boolean> {
  if (heldHere.has(name)) return true;
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
  if (locks === undefined) return false;
  const { held } = await locks.query();
  return (held ?? []).some((lock) => lock.name === name);
}

export const turnLockName = (sessionId: string) => `kd-learn:turn:${sessionId}`;
export const sideLockName = (sessionId: string) => `kd-learn:side:${sessionId}`;
