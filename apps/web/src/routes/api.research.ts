// `POST /api/research`: web research for guest and demo (phase 4 A5).
import { createFileRoute } from '@tanstack/react-router';
import { apiHandlers, requestContext } from '../api-handlers';

const handle = async ({ request }: { request: Request }) =>
  (await apiHandlers()).research(request, await requestContext());

export const Route = createFileRoute('/api/research')({
  server: { handlers: { GET: handle, POST: handle, OPTIONS: handle } },
});
