// Who is using the app on this device: a signed-in account (token from the server, plan A4), or a
// local mode (guest with an own key, or demo on the server's key). Kept in `localStorage`; the
// web build and Capacitor send the token as `Authorization: Bearer` (plan step 0, C2).
//
// The server render cannot see `localStorage`, so the first render on both sides is `unknown`
// (`getServerSnapshot`) and the client switches to what is stored right after hydration.
import type { User } from '@kd-learn/api';
import { useSyncExternalStore } from 'react';

export type LocalMode = 'guest' | 'demo';

export type Who =
  | { readonly status: 'unknown' }
  | {
      readonly status: 'signed-in';
      readonly token: string;
      readonly user: User;
      readonly expiresAt: number;
    }
  | { readonly status: 'local'; readonly mode: LocalMode | undefined };

const AUTH_KEY = 'kd-learn.auth';
const MODE_KEY = 'kd-learn.mode';

const unknown: Who = { status: 'unknown' };
const listeners = new Set<() => void>();
let current: Who | undefined;
/** Called on every sign-in and sign-out: caches of the previous user must go (Query, lessons). */
const resetHooks = new Set<() => void>();

const read = (key: string): string | null => {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
};
const write = (key: string, value: string | undefined) => {
  try {
    if (value === undefined) globalThis.localStorage?.removeItem(key);
    else globalThis.localStorage?.setItem(key, value);
  } catch {
    // Storage blocked: the choice lasts for this page only.
  }
};

const load = (): Who => {
  const raw = read(AUTH_KEY);
  if (raw !== null) {
    try {
      const parsed = JSON.parse(raw) as { token?: unknown; user?: User; expiresAt?: unknown };
      if (
        typeof parsed.token === 'string' &&
        typeof parsed.expiresAt === 'number' &&
        parsed.expiresAt > Date.now() &&
        parsed.user !== undefined
      ) {
        return {
          status: 'signed-in',
          token: parsed.token,
          user: parsed.user,
          expiresAt: parsed.expiresAt,
        };
      }
    } catch {
      // A damaged entry counts as signed out.
    }
    write(AUTH_KEY, undefined);
  }
  const mode = read(MODE_KEY);
  return { status: 'local', mode: mode === 'guest' || mode === 'demo' ? mode : undefined };
};

const set = (next: Who) => {
  current = next;
  listeners.forEach((listener) => listener());
};

export const who = {
  subscribe: (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  get: (): Who => (current ??= load()),
  getServer: (): Who => unknown,
};

export const useWho = (): Who => useSyncExternalStore(who.subscribe, who.get, who.getServer);

/** Registers a cleanup to run whenever the user changes. */
export const onUserChange = (hook: () => void) => {
  resetHooks.add(hook);
  return () => {
    resetHooks.delete(hook);
  };
};

export function signIn(token: string, user: User, expiresAt: number): void {
  write(AUTH_KEY, JSON.stringify({ token, user, expiresAt }));
  resetHooks.forEach((hook) => hook());
  set({ status: 'signed-in', token, user, expiresAt });
}

/** Forgets the token (sign-out, or the server said 401). Back to the local mode chosen before. */
export function signOut(): void {
  write(AUTH_KEY, undefined);
  resetHooks.forEach((hook) => hook());
  const mode = read(MODE_KEY);
  set({ status: 'local', mode: mode === 'guest' || mode === 'demo' ? mode : undefined });
}

/** Chooses guest or demo mode, or clears the choice (`undefined`: show the chooser again). */
export function chooseLocalMode(mode: LocalMode | undefined): void {
  write(MODE_KEY, mode);
  const now = who.get();
  if (now.status !== 'signed-in') set({ status: 'local', mode });
}

/** The local mode now, read when a turn starts (the runner outlives the screen). */
export const localModeNow = (): LocalMode => {
  const now = who.get();
  return now.status === 'local' && now.mode === 'demo' ? 'demo' : 'guest';
};
