// `GET /api/endpoints`: the OpenAI-compatible endpoints a guest may choose by id.
import { createFileRoute } from '@tanstack/react-router';
import { apiHandlers } from '../api-handlers';

const handle = async ({ request }: { request: Request }) =>
  (await apiHandlers()).endpoints(request);

export const Route = createFileRoute('/api/endpoints')({
  server: { handlers: { GET: handle, POST: handle, OPTIONS: handle } },
});
