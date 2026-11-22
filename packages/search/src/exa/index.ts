// Exa adapter (plan nguon-hoc.md A6, spike C2). SERVER ONLY. The key is the admin's (stored
// encrypted); no error message ever carries it or Exa's own body. `highlights` stand in for page
// text, so no page is fetched.
import { Effect } from 'effect';
import { SearchError, type SearchResult, type SearchService } from '../port/index.ts';

export interface ExaOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly fetch?: typeof fetch;
}

interface ExaResult {
  readonly title?: unknown;
  readonly url?: unknown;
  readonly publishedDate?: unknown;
  readonly highlights?: unknown;
  readonly text?: unknown;
}

const fail = (reason: SearchError['reason'], message: string, retryAfterSeconds?: number) =>
  new SearchError({
    reason,
    message,
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
  });

export const makeExa = (options: ExaOptions): SearchService => {
  const doFetch = options.fetch ?? fetch;
  const base = (options.baseUrl ?? 'https://api.exa.ai').replace(/\/+$/, '');
  return {
    search: (request) =>
      Effect.tryPromise({
        try: async (signal) => {
          const response = await doFetch(`${base}/search`, {
            method: 'POST',
            signal: AbortSignal.any([signal, AbortSignal.timeout(options.timeoutMs ?? 20_000)]),
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${options.apiKey}`,
            },
            body: JSON.stringify({
              query: request.query,
              type: 'auto',
              numResults: Math.min(Math.max(request.limit, 1), 10),
              contents: { highlights: true },
            }),
          });
          if (response.status === 401 || response.status === 403) {
            throw fail('Unauthorized', 'Exa refused the API key.');
          }
          if (response.status === 402) throw fail('PaymentRequired', 'Exa has no credits left.');
          if (response.status === 429) {
            const after = Number(response.headers.get('retry-after'));
            throw fail(
              'RateLimited',
              'Exa is rate limiting. Try again later.',
              Number.isFinite(after) && after > 0 ? after : undefined,
            );
          }
          if (response.status === 400) throw fail('Invalid', 'Exa refused the search request.');
          if (!response.ok) throw fail('Unavailable', 'Exa did not answer.');
          const body = (await response.json()) as { results?: ReadonlyArray<ExaResult> };
          const results: SearchResult[] = [];
          for (const item of body.results ?? []) {
            if (typeof item.url !== 'string' || !/^https?:\/\//.test(item.url)) continue;
            const highlights = Array.isArray(item.highlights)
              ? item.highlights.filter((h): h is string => typeof h === 'string')
              : [];
            const text = typeof item.text === 'string' ? item.text : highlights.join('\n\n');
            results.push({
              title: typeof item.title === 'string' && item.title !== '' ? item.title : item.url,
              url: item.url,
              snippet: highlights[0] ?? text.slice(0, 300),
              ...(text === '' ? {} : { content: text }),
              ...(typeof item.publishedDate === 'string'
                ? { publishedAt: item.publishedDate }
                : {}),
            });
          }
          return results.slice(0, request.limit);
        },
        catch: (error) =>
          error instanceof SearchError ? error : fail('Unavailable', 'Exa did not answer.'),
      }),
  };
};
