// `POST /api/knowledge/extract`: guest and demo extraction as an SSE stream (contract in @kd-learn/api).
import { createFileRoute } from '@tanstack/react-router';
import { apiHandlers } from '../api-handlers';

const handle = async ({ request }: { request: Request }) => (await apiHandlers()).extract(request);

export const Route = createFileRoute('/api/knowledge/extract')({
  server: { handlers: { GET: handle, POST: handle, OPTIONS: handle } },
});
