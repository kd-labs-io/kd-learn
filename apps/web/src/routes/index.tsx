import { Layout, LayoutContent } from '@astryxdesign/core/Layout';
import { LoadingSkeleton } from '@kd-learn/ui/components/LoadingSkeleton';
import { m } from '@kd-learn/i18n';
import { createFileRoute } from '@tanstack/react-router';
import { AccountHome } from '../account/AccountHome';
import { usePublicConfig } from '../account/api';
import { useWho } from '../account/auth';
import { GuestHome } from '../app/GuestHome';
import { guestOnly, localModeOf } from '../app/modes';
import { Welcome } from '../app/Welcome';
import { pageWidth } from '../app/page';

export const Route = createFileRoute('/')({ component: Home });

function Loading() {
  return (
    <Layout
      contentWidth={pageWidth}
      content={
        <LayoutContent padding={6}>
          <LoadingSkeleton label={m.loading()} />
        </LayoutContent>
      }
    />
  );
}

/** Home: the account's sessions, the local ones (guest or demo), or the mode chooser. */
function Home() {
  const current = useWho();
  const config = usePublicConfig();
  if (current.status === 'unknown') return <Loading />;
  if (current.status === 'signed-in') return <AccountHome token={current.token} />;
  if (config.isPending) return <Loading />;
  const offered = config.data ?? guestOnly;
  const mode = localModeOf(current, offered);
  return mode === undefined ? <Welcome config={offered} /> : <GuestHome mode={mode} />;
}
