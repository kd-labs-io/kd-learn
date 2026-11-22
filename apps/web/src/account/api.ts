// The account API for React: a client bound to the current token, Promise helpers for Query, and
// the query keys. A 401 from any account call signs the user out (token expired or revoked).
import {
  ApiError,
  accountClient,
  type AccountClient,
  type AccountClientOptions,
  type PublicConfig,
} from '@kd-learn/api';
import { queryOptions, useQuery } from '@tanstack/react-query';
import { Effect } from 'effect';
import { apiBaseUrl } from '../learn/hooks';
import { signOut, useWho, who } from './auth';

export const clientOptions = (token?: string): AccountClientOptions => ({
  ...(apiBaseUrl === '' ? {} : { baseUrl: apiBaseUrl }),
  ...(token === undefined ? {} : { token }),
});

/** Runs a call; rejects with the `ApiError`. A 401 with a token signs out. */
export async function run<A>(effect: Effect.Effect<A, ApiError>, token?: string): Promise<A> {
  const exit = await Effect.runPromiseExit(effect);
  if (exit._tag === 'Success') return exit.value;
  const reason = exit.cause.reasons.find((r) => r._tag === 'Fail');
  const error =
    reason?._tag === 'Fail'
      ? reason.error
      : new ApiError({
          status: 0,
          failure: { code: 'InternalError', message: 'Unexpected failure.', retryable: true },
        });
  const now = who.get();
  if (
    error.status === 401 &&
    token !== undefined &&
    now.status === 'signed-in' &&
    now.token === token
  ) {
    signOut();
  }
  throw error;
}

/** Calls the API as the signed-in user: `call((api) => api.sessions())`. */
export function useAccountApi(): {
  readonly token: string | undefined;
  readonly call: <A>(pick: (api: AccountClient) => Effect.Effect<A, ApiError>) => Promise<A>;
} {
  const current = useWho();
  const token = current.status === 'signed-in' ? current.token : undefined;
  const api = accountClient(clientOptions(token));
  return { token, call: (pick) => run(pick(api), token) };
}

/** The message to show for a failed call. */
export const errorText = (error: unknown): string =>
  error instanceof ApiError
    ? error.failure.message
    : error instanceof Error
      ? error.message
      : String(error);

export const errorCode = (error: unknown): string | undefined =>
  error instanceof ApiError ? error.failure.code : undefined;

export const keys = {
  config: ['config'] as const,
  sessions: (token: string) => ['account', token, 'sessions'] as const,
  settings: (token: string) => ['account', token, 'settings'] as const,
  profile: (token: string) => ['account', token, 'profile'] as const,
  practices: (token: string) => ['account', token, 'practices'] as const,
  knowledge: (token: string) => ['account', token, 'knowledge'] as const,
  extractions: (token: string) => ['account', token, 'extractions'] as const,
  sources: (token: string) => ['account', token, 'sources'] as const,
  source: (token: string, sourceId: string) => ['account', token, 'sources', sourceId] as const,
  searchOptions: (token: string | undefined, mode: string) => ['search', token ?? mode] as const,
  adminSearch: (token: string) => ['account', token, 'admin', 'search'] as const,
  endpoints: ['endpoints'] as const,
  adminConfig: (token: string) => ['account', token, 'admin', 'config'] as const,
  adminUsers: (token: string) => ['account', token, 'admin', 'users'] as const,
};

/** What this server offers (`GET /api/config`). Guest only when the server cannot be asked. */
export const configQuery = queryOptions({
  queryKey: keys.config,
  queryFn: (): Promise<PublicConfig> => run(accountClient(clientOptions()).config()),
  staleTime: 30_000,
  retry: 1,
});

export const usePublicConfig = () => useQuery(configQuery);
