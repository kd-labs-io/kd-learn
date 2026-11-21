// `POST /api/turns`: one agent turn as an SSE stream (contract in @kd-learn/api).
import { createFileRoute } from '@tanstack/react-router';
import { apiHandlers } from '../api-handlers';

const handle = async ({ request }: { request: Request }) => (await apiHandlers()).turns(request);

export const Route = createFileRoute('/api/turns')({
  server: { handlers: { GET: handle, POST: handle, OPTIONS: handle } },
});
