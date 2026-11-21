// The teaching profile of an account (phase 3 A2). Read and written through `forUser`, so one user
// can never see or replace another user's profile.
import { Effect } from 'effect';
import { defaultProfile, resolveProfile } from '@kd-learn/agent';
import type { ResolvedProfile } from '@kd-learn/core';
import type { StorageError, StorageService } from '@kd-learn/storage/port';

export interface ActiveProfile {
  /** The profile new sessions, extraction and practice use, with defaults filled in. */
  readonly profile: ResolvedProfile;
  /** False when the user saved nothing and `profile` is the default. */
  readonly saved: boolean;
}

/** The profile in use for the user `storage` is bound to. */
export const activeProfile = (
  storage: StorageService,
): Effect.Effect<ActiveProfile, StorageError> =>
  storage.getProfile.pipe(
    Effect.map((saved) =>
      saved === undefined
        ? { profile: defaultProfile, saved: false }
        : { profile: resolveProfile(saved), saved: true },
    ),
  );
