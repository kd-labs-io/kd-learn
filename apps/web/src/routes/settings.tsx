import { createFileRoute } from '@tanstack/react-router';
import { AccountSettingsScreen } from '../account/AccountSettings';
import { useWho } from '../account/auth';
import { GuestSettings } from '../app/GuestSettings';

export const Route = createFileRoute('/settings')({ component: Settings });

function Settings() {
  const current = useWho();
  if (current.status === 'unknown') return null;
  return current.status === 'signed-in' ? (
    <AccountSettingsScreen token={current.token} />
  ) : (
    <GuestSettings />
  );
}
