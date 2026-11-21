import { Effect } from 'effect';
import { listEndpoints, type EndpointInfo } from '@kd-learn/api';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { getStorage } from '../storage';
import { getRunner, isTurnRunningElsewhere, type RunnerState, type SessionRunner } from './runner';

/**
 * Origin of the API server. Empty for the web build (same origin). A Capacitor build has no server
 * of its own and sets `VITE_KD_API_BASE_URL` to a deployed one (plan step 4, "SPA build").
 */
export const apiBaseUrl: string = import.meta.env['VITE_KD_API_BASE_URL'] ?? '';

/** The runner of a session and its state. The runner outlives the screen, so a turn keeps running. */
export function useRunner(sessionId: string): { runner: SessionRunner; state: RunnerState } {
  const runner = getRunner(sessionId, {
    storage: getStorage,
    ...(apiBaseUrl === '' ? {} : { baseUrl: apiBaseUrl }),
  });
  const state = useSyncExternalStore(runner.subscribe, runner.getSnapshot, runner.getSnapshot);
  return { runner, state };
}

/**
 * Whether another tab is running a turn of this session. Only polled while the log has an open
 * turn that this tab is not running: that is when "interrupted" and "running elsewhere" differ.
 */
export function useTurnRunningElsewhere(sessionId: string, hasOpenTurn: boolean): boolean {
  const [elsewhere, setElsewhere] = useState(false);
  useEffect(() => {
    if (!hasOpenTurn) {
      setElsewhere(false);
      return;
    }
    let active = true;
    const check = () =>
      void isTurnRunningElsewhere(sessionId)
        .then((held) => active && setElsewhere(held))
        .catch(() => undefined);
    check();
    const timer = setInterval(check, 1000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [sessionId, hasOpenTurn]);
  return elsewhere;
}

export type EndpointsState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly endpoints: ReadonlyArray<EndpointInfo> }
  | { readonly status: 'error' };

/** The OpenAI-compatible endpoints the server offers (`GET /api/endpoints`). */
export function useEndpoints(): EndpointsState {
  const [state, setState] = useState<EndpointsState>({ status: 'loading' });
  useEffect(() => {
    const controller = new AbortController();
    void Effect.runPromise(
      listEndpoints(apiBaseUrl === '' ? {} : { baseUrl: apiBaseUrl }).pipe(
        Effect.match({
          onSuccess: (endpoints): EndpointsState => ({ status: 'ready', endpoints }),
          onFailure: (): EndpointsState => ({ status: 'error' }),
        }),
      ),
      { signal: controller.signal },
    )
      .then((next) => !controller.signal.aborted && setState(next))
      .catch(() => undefined);
    return () => controller.abort();
  }, []);
  return state;
}

/** False for the in-memory fallback: sessions and key are lost on close. Undefined while opening. */
export function useStoragePersistent(): boolean | undefined {
  const [persistent, setPersistent] = useState<boolean | undefined>(undefined);
  useEffect(() => {
    let active = true;
    void getStorage()
      .then((storage) => active && setPersistent(storage.persistent))
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);
  return persistent;
}
