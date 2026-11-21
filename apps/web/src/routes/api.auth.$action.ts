// `/api/auth/register|login|logout|me` (plan tai-khoan.md A4; contract in @kd-learn/api).
import { createFileRoute } from '@tanstack/react-router';
import { apiHandlers, requestContext } from '../api-handlers';

const actions = ['register', 'login', 'logout', 'me'] as const;
type Action = (typeof actions)[number];

const handle = async ({ request, params }: { request: Request; params: { action: string } }) => {
  if (!actions.includes(params.action as Action)) return new Response(null, { status: 404 });
  const handlers = await apiHandlers();
  return handlers[params.action as Action](request, await requestContext());
};

export const Route = createFileRoute('/api/auth/$action')({
  server: { handlers: { GET: handle, POST: handle, OPTIONS: handle } },
});
