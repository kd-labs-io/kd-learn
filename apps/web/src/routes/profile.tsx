import { createFileRoute, Navigate } from '@tanstack/react-router';
import { usePublicConfig } from '../account/api';
import { useWho } from '../account/auth';
import { guestOnly, localModeOf } from '../app/modes';
import { ProfileScreen } from '../profile/ProfileScreen';
import { useAccountProfileSource, useGuestProfileSource } from '../profile/source';

export const Route = createFileRoute('/profile')({ component: Profile });

/** The teaching profile of an account or of this device. Demo runs the server's profile: none. */
function Profile() {
  const current = useWho();
  const config = usePublicConfig();
  if (current.status === 'unknown') return null;
  if (current.status === 'signed-in') return <AccountProfile token={current.token} />;
  if (config.isPending) return null;
  const mode = localModeOf(current, config.data ?? guestOnly);
  return mode === 'guest' ? <GuestProfile /> : <Navigate to="/" />;
}

function AccountProfile({ token }: { token: string }) {
  return <ProfileScreen source={useAccountProfileSource(token)} />;
}

function GuestProfile() {
  return <ProfileScreen source={useGuestProfileSource()} />;
}
