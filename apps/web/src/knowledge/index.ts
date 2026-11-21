// Knowledge graph in the browser (phase 3): guest and demo extraction.
import { localModeNow } from '../account/auth';
import { getStorage } from '../storage';
import { makeGuestExtractor } from './guest-extractor';

export { KNOWLEDGE_LOCK, makeGuestExtractor } from './guest-extractor';
export type { ExtractResult, GuestExtractor } from './guest-extractor';

/** The extractor of this tab, at module level so an extraction outlives the screen that started it. */
export const guestExtractor = makeGuestExtractor({
  storage: getStorage,
  demo: () => localModeNow() === 'demo',
  // Same origin as `apiBaseUrl` in learn/hooks (not imported: that module imports this one).
  ...(import.meta.env['VITE_KD_API_BASE_URL']
    ? { baseUrl: import.meta.env['VITE_KD_API_BASE_URL'] as string }
    : {}),
});
