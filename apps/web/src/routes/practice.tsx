import { createFileRoute } from '@tanstack/react-router';
import { usePublicConfig } from '../account/api';
import { useWho } from '../account/auth';
import { guestOnly, localModeOf } from '../app/modes';
import { Welcome } from '../app/Welcome';
import { PracticeScreen } from '../practice/PracticeScreen';
import { useAccountPracticeSource, useGuestPracticeSource } from '../practice/source';

export const Route = createFileRoute('/practice')({ component: Practice });

/** Practice on the knowledge graph: the account's on the server, or this device's (guest, demo). */
function Practice() {
  const current = useWho();
  const config = usePublicConfig();
  if (current.status === 'unknown') return null;
  if (current.status === 'signed-in') return <AccountPractice token={current.token} />;
  if (config.isPending) return null;
  const offered = config.data ?? guestOnly;
  const mode = localModeOf(current, offered);
  return mode === undefined ? (
    <Welcome config={offered} />
  ) : (
    <GuestPractice demo={mode === 'demo'} />
  );
}

function AccountPractice({ token }: { token: string }) {
  return <PracticeScreen source={useAccountPracticeSource(token)} />;
}

function GuestPractice({ demo }: { demo: boolean }) {
  return <PracticeScreen source={useGuestPracticeSource(demo)} />;
}
