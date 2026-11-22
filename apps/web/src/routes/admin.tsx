import { Banner } from '@astryxdesign/core/Banner';
import { Layout, LayoutContent } from '@astryxdesign/core/Layout';
import { m } from '@kd-learn/i18n';
import { Navigate, createFileRoute } from '@tanstack/react-router';
import { AdminScreen } from '../account/AdminScreen';
import { useWho } from '../account/auth';
import { AppHeader } from '../app/AppHeader';
import { pageWidth } from '../app/page';

export const Route = createFileRoute('/admin')({ component: Admin });

function Admin() {
  const current = useWho();
  if (current.status === 'unknown') return null;
  if (current.status !== 'signed-in') return <Navigate to="/login" />;
  if (current.user.role !== 'admin') {
    return (
      <Layout
        contentWidth={pageWidth}
        header={<AppHeader />}
        content={
          <LayoutContent padding={6}>
            <Banner status="warning" title={m.admin_only()} />
          </LayoutContent>
        }
      />
    );
  }
  return <AdminScreen token={current.token} selfId={current.user.id} />;
}
