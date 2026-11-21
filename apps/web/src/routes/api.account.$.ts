// `/api/account/*`: settings of the signed-in account (plan tai-khoan.md A5, A6). The server
// package routes by path.
import { createFileRoute } from '@tanstack/react-router';
import { apiHandlers, requestContext } from '../api-handlers';

const handle = async ({ request }: { request: Request }) =>
  (await apiHandlers()).account(request, await requestContext());

export const Route = createFileRoute('/api/account/$')({
  server: { handlers: { GET: handle, POST: handle, PUT: handle, DELETE: handle, OPTIONS: handle } },
});
