import { Layout, LayoutContent } from '@astryxdesign/core/Layout';
import { Spinner } from '@astryxdesign/core/Spinner';
import { m } from '@kd-learn/i18n';
import { Navigate, createFileRoute } from '@tanstack/react-router';
import { useWho } from '../account/auth';
import { AccountLessonScreen } from '../learn/AccountLessonScreen';

export const Route = createFileRoute('/a/$sessionId')({ component: AccountLessonRoute });

/** A lesson of the signed-in account (`/a/...`); guest lessons stay at `/s/...`. */
function AccountLessonRoute() {
  const { sessionId } = Route.useParams();
  const current = useWho();
  if (current.status === 'unknown') {
    return (
      <Layout
        content={
          <LayoutContent padding={6}>
            <Spinner label={m.learn_loading()} />
          </LayoutContent>
        }
      />
    );
  }
  if (current.status !== 'signed-in') return <Navigate to="/login" />;
  return (
    <AccountLessonScreen
      key={`${current.token}:${sessionId}`}
      token={current.token}
      sessionId={sessionId}
    />
  );
}
