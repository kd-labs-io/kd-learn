// Sources in the browser (phase 4): the guest and demo store of this tab, at module level so a PDF
// being read or a research running outlives the screen that started it.
import { Effect } from 'effect';
import { researchWeb, type ResearchOutcome, type WebOrigin } from '@kd-learn/api';
import { localModeNow } from '../account/auth';
import { modelChoiceOf } from '../learn/model';
import { getStorage } from '../storage';
import { makeGuestSources } from './guest-ingest';

export { ingestLockName, makeGuestSources } from './guest-ingest';
export type { AddResult, GuestSources, GuestSourceView } from './guest-ingest';

// Same origin as `apiBaseUrl` in learn/hooks (not imported: that module imports the runner).
const baseUrl = import.meta.env['VITE_KD_API_BASE_URL'] as string | undefined;

/** A research on the server with the guest's model, or the demo's. */
const research = async (origin: WebOrigin): Promise<ResearchOutcome> => {
  const storage = await getStorage();
  const demo = localModeNow() === 'demo';
  const model = demo
    ? ({ provider: 'demo' } as const)
    : modelChoiceOf(await Effect.runPromise(storage.getSettings));
  if (model === undefined) {
    return {
      _tag: 'Failed',
      error: {
        code: 'NoKey',
        message: 'Set a model and key in the settings first.',
        retryable: true,
      },
    };
  }
  const profile = demo ? undefined : await Effect.runPromise(storage.getProfile);
  return Effect.runPromise(
    researchWeb(
      { model, ...origin, ...(profile === undefined ? {} : { profile }) },
      baseUrl ? { baseUrl } : {},
    ),
  );
};

export const guestSources = makeGuestSources({ storage: getStorage, research });
