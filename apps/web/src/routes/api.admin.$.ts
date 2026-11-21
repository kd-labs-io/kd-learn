// `/api/admin/config`, `/api/admin/users[/:id]`: admin switches and users (plan tai-khoan.md A7).
// `/api/admin/invites` has its own route.
import { createFileRoute } from '@tanstack/react-router';
import { apiHandlers, requestContext } from '../api-handlers';

const handle = async ({ request }: { request: Request }) =>
  (await apiHandlers()).admin(request, await requestContext());

export const Route = createFileRoute('/api/admin/$')({
  server: {
    handlers: {
      GET: handle,
      POST: handle,
      PUT: handle,
      PATCH: handle,
      DELETE: handle,
      OPTIONS: handle,
    },
  },
});
