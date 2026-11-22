import type { PublicConfig } from '@kd-learn/api';
import type { LocalMode, Who } from '../account/auth';

/** What the server offers when it cannot be asked (offline, old server): guest mode only. */
export const guestOnly: PublicConfig = {
  accounts: false,
  registration: 'closed',
  guestMode: true,
  demoMode: false,
  figureCdn: true,
};

/**
 * The local mode to use, or undefined to show the chooser. A chosen mode the server no longer
 * offers counts as not chosen; a server that offers guest mode only needs no choice.
 */
export function localModeOf(current: Who, config: PublicConfig): LocalMode | undefined {
  const mode = current.status === 'local' ? current.mode : undefined;
  if (mode === 'guest' && config.guestMode) return 'guest';
  if (mode === 'demo' && config.demoMode) return 'demo';
  if (config.guestMode && !config.demoMode && !config.accounts) return 'guest';
  return undefined;
}
