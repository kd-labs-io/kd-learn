// HTTP helpers shared by every route of this package.
import type { ErrorBody } from '@kd-learn/api';
import type { ServerConfig } from './config.ts';

export const SECURITY_HEADERS = { 'x-content-type-options': 'nosniff' } as const;

export const corsHeaders = (request: Request, config: ServerConfig): Record<string, string> => {
  if (config.corsOrigins.length === 0) return {};
  const origin = request.headers.get('origin');
  return origin !== null && config.corsOrigins.includes(origin)
    ? {
        'access-control-allow-origin': origin,
        'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'access-control-allow-headers': 'content-type, accept, authorization',
        'access-control-max-age': '600',
        vary: 'origin',
      }
    : { vary: 'origin' };
};

export const failureResponse = (
  status: number,
  code: string,
  message: string,
  retryable: boolean,
  headers: Record<string, string>,
): Response => {
  const body: ErrorBody = { error: { code, message, retryable } };
  return Response.json(body, {
    status,
    headers: { ...SECURITY_HEADERS, 'cache-control': 'no-store', ...headers },
  });
};

/** The body as text, or why it was refused. Stops reading as soon as the limit is passed. */
export const readLimited = async (
  request: Request,
  max: number,
): Promise<{ readonly text: string; readonly bytes: number } | 'too-large' | 'unreadable'> => {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) return 'too-large';
  if (request.body === null) return { text: '', bytes: 0 };
  const reader = request.body.getReader();
  const chunks: Array<Uint8Array> = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel().catch(() => undefined);
        return 'too-large';
      }
      chunks.push(value);
    }
  } catch {
    return 'unreadable';
  }
  const all = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(all), bytes: total };
  } catch {
    return 'unreadable';
  }
};
