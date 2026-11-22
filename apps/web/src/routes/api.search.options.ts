// `GET /api/search/options`: the search sources usable in the caller's mode (phase 4 A6).
import { createFileRoute } from '@tanstack/react-router';
import { apiHandlers } from '../api-handlers';

const handle = async ({ request }: { request: Request }) =>
  (await apiHandlers()).searchOptions(request);

export const Route = createFileRoute('/api/search/options')({
  server: { handlers: { GET: handle, POST: handle, OPTIONS: handle } },
});
