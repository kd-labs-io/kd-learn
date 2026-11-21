// `POST /api/admin/invites`: one-time invite code, admins only (plan tai-khoan.md A4).
import { createFileRoute } from '@tanstack/react-router';
import { apiHandlers, requestContext } from '../api-handlers';

const handle = async ({ request }: { request: Request }) =>
  (await apiHandlers()).invites(request, await requestContext());

export const Route = createFileRoute('/api/admin/invites')({
  server: { handlers: { GET: handle, POST: handle, OPTIONS: handle } },
});
