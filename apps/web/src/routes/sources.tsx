import { createFileRoute, Navigate } from '@tanstack/react-router';
import { usePublicConfig } from '../account/api';
import { useWho } from '../account/auth';
import { guestOnly, localModeOf } from '../app/modes';
import { useAccountSourceLibrary, useGuestSourceLibrary } from '../sources/library';
import { SourcesScreen } from '../sources/SourcesScreen';

export const Route = createFileRoute('/sources')({ component: Sources });

/** The learning sources of an account, or of this device (guest and demo). */
function Sources() {
  const current = useWho();
  const config = usePublicConfig();
  if (current.status === 'unknown') return null;
  if (current.status === 'signed-in') return <AccountSources token={current.token} />;
  if (config.isPending) return null;
  const mode = localModeOf(current, config.data ?? guestOnly);
  return mode === undefined ? <Navigate to="/" /> : <GuestSources mode={mode} />;
}

function AccountSources({ token }: { token: string }) {
  return <SourcesScreen library={useAccountSourceLibrary(token)} />;
}

function GuestSources({ mode }: { mode: 'guest' | 'demo' }) {
  return <SourcesScreen library={useGuestSourceLibrary(mode)} />;
}
