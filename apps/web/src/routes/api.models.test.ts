// `POST /api/models/test`: checks a guest's model and key with one tiny call.
import { createFileRoute } from '@tanstack/react-router';
import { apiHandlers, requestContext } from '../api-handlers';

const handle = async ({ request }: { request: Request }) =>
  (await apiHandlers()).modelTest(request, await requestContext());

export const Route = createFileRoute('/api/models/test')({
  server: { handlers: { GET: handle, POST: handle, OPTIONS: handle } },
});
