import { createFileRoute, Navigate } from '@tanstack/react-router';
import { usePublicConfig } from '../account/api';
import { useWho } from '../account/auth';
import { guestOnly, localModeOf } from '../app/modes';
import { GraphScreen } from '../graph/GraphScreen';
import { useAccountKnowledgeSource, useGuestKnowledgeSource } from '../graph/source';

export const Route = createFileRoute('/graph')({ component: Graph });

/** The knowledge graph of an account, or of this device (guest and demo). */
function Graph() {
  const current = useWho();
  const config = usePublicConfig();
  if (current.status === 'unknown') return null;
  if (current.status === 'signed-in') return <AccountGraph token={current.token} />;
  if (config.isPending) return null;
  // Guest and demo both keep their knowledge log on this device; no mode chosen yet: home.
  const mode = localModeOf(current, config.data ?? guestOnly);
  return mode === undefined ? <Navigate to="/" /> : <GuestGraph />;
}

function AccountGraph({ token }: { token: string }) {
  return <GraphScreen source={useAccountKnowledgeSource(token)} />;
}

function GuestGraph() {
  return <GraphScreen source={useGuestKnowledgeSource()} />;
}
