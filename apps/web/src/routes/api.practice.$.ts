// `POST /api/practice/issue` and `POST /api/practice/grade`: stateless practice of guest and demo
// mode (contract in @kd-learn/api). The server package routes by path.
import { createFileRoute } from '@tanstack/react-router';
import { apiHandlers } from '../api-handlers';

const handle = async ({ request }: { request: Request }) => (await apiHandlers()).practice(request);

export const Route = createFileRoute('/api/practice/$')({
  server: { handlers: { GET: handle, POST: handle, OPTIONS: handle } },
});
