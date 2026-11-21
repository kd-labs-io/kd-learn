// `GET /api/config`: which modes this server offers (plan tai-khoan.md A7). No sign-in.
import { createFileRoute } from '@tanstack/react-router';
import { apiHandlers, requestContext } from '../api-handlers';

const handle = async ({ request }: { request: Request }) =>
  (await apiHandlers()).config(request, await requestContext());

export const Route = createFileRoute('/api/config')({
  server: { handlers: { GET: handle, OPTIONS: handle } },
});
