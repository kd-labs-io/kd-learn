// Server entry: Paraglide reads the locale from each request (cookie, then
// Accept-Language) and keeps it request-scoped while Start renders.
import { paraglideMiddleware } from '@kd-learn/i18n/server';
import handler from '@tanstack/react-start/server-entry';

export default {
  fetch(request: Request): Promise<Response> {
    return paraglideMiddleware(request, () => handler.fetch(request));
  },
};
