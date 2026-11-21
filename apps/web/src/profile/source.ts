// What the profile screen needs, whoever keeps the profile: the local DB (guest) or the server
// (account). Same pattern as `LessonSource` (learn/source.ts). Demo has no profile screen.
import { defaultProfile, resolveProfile } from '@kd-learn/agent/client';
import type { ResolvedProfile, SavedProfile } from '@kd-learn/core';
import type { ProfileResponse } from '@kd-learn/api';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { errorText, keys, useAccountApi } from '../account/api';
import { runStorage, useStorageQuery } from '../storage';

export type ProfileView =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | {
      readonly status: 'ready';
      /** The profile new sessions use, with every field filled in. */
      readonly profile: ResolvedProfile;
      /** False when nothing is saved and `profile` is the default. */
      readonly saved: boolean;
    };

export interface ProfileSource {
  readonly view: ProfileView;
  /** Rejects when the store refuses the profile (limits, storage failure). */
  save(profile: SavedProfile): Promise<void>;
  /** Back to the default profile. */
  reset(): Promise<void>;
}

/** Guest: the profile in the local DB, re-read on `ProfileChanged` (also from another tab). */
export function useGuestProfileSource(): ProfileSource {
  const stored = useStorageQuery(
    (storage) => storage.getProfile,
    (change) => change._tag === 'ProfileChanged',
    [],
  );
  const view: ProfileView =
    stored.status === 'loading'
      ? stored
      : stored.status === 'error'
        ? { status: 'error', message: stored.error.message }
        : {
            status: 'ready',
            profile: stored.data === undefined ? defaultProfile : resolveProfile(stored.data),
            saved: stored.data !== undefined,
          };
  return {
    view,
    save: (profile) => runStorage((storage) => storage.saveProfile(profile)),
    reset: () => runStorage((storage) => storage.saveProfile(undefined)),
  };
}

/** Account: `GET /api/account/profile` through Query; a save answers with the new state. */
export function useAccountProfileSource(token: string): ProfileSource {
  const { call } = useAccountApi();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: keys.profile(token),
    queryFn: () => call((api) => api.profile()),
  });
  const write = useMutation({
    mutationFn: (profile: SavedProfile | undefined) =>
      call((api) => (profile === undefined ? api.resetProfile() : api.saveProfile(profile))),
    onSuccess: (response: ProfileResponse) =>
      queryClient.setQueryData(keys.profile(token), response),
  });
  const view: ProfileView = query.isPending
    ? { status: 'loading' }
    : query.isError
      ? { status: 'error', message: errorText(query.error) }
      : {
          status: 'ready',
          profile: resolveProfile(query.data.profile),
          saved: query.data.saved,
        };
  return {
    view,
    save: async (profile) => void (await write.mutateAsync(profile)),
    reset: async () => void (await write.mutateAsync(undefined)),
  };
}
