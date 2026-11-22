// SearXNG adapter (plan nguon-hoc.md A6, spike C2). SERVER ONLY. The base URL comes from the server
// env (`KD_SEARXNG_URL`), never from a client (risk 6). SearXNG snippets are short (about 160
// characters), so the adapter fetches the first pages itself (guarded fetcher, risk 38) and puts
// their text in `content`; a page that fails keeps its snippet.
import { Effect } from 'effect';
import { SearchError, type SearchResult, type SearchService } from '../port/index.ts';
import { fetchPage, type FetchOptions } from '../fetch/index.ts';

export interface SearxngOptions {
  readonly baseUrl: string;
  /** Pages fetched for `content`. Default 4; 0 turns fetching off. */
  readonly fetchPages?: number;
  /** Characters kept from a fetched page. Default 12 000. */
  readonly pageChars?: number;
  readonly timeoutMs?: number;
  readonly fetch?: typeof fetch;
  readonly fetchOptions?: FetchOptions;
}

interface SearxngResult {
  readonly title?: unknown;
  readonly url?: unknown;
  readonly content?: unknown;
  readonly publishedDate?: unknown;
}

const fail = (reason: SearchError['reason'], message: string, retryAfterSeconds?: number) =>
  new SearchError({
    reason,
    message,
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
  });

export const makeSearxng = (options: SearxngOptions): SearchService => {
  const doFetch = options.fetch ?? fetch;
  const pages = options.fetchPages ?? 4;
  const pageChars = options.pageChars ?? 12_000;
  const base = options.baseUrl.replace(/\/+$/, '');

  const query = (request: { query: string; language?: string }) =>
    Effect.tryPromise({
      try: async (signal) => {
        const url = new URL(`${base}/search`);
        url.searchParams.set('q', request.query);
        url.searchParams.set('format', 'json');
        if (request.language !== undefined) url.searchParams.set('language', request.language);
        const timeout = AbortSignal.timeout(options.timeoutMs ?? 15_000);
        const response = await doFetch(url, {
          signal: AbortSignal.any([signal, timeout]),
          headers: { accept: 'application/json' },
        });
        if (response.status === 429) {
          throw fail('RateLimited', 'The search engine is busy. Try again later.');
        }
        if (response.status === 403) {
          throw fail('Unavailable', 'SearXNG refused JSON output (enable the json format).');
        }
        if (!response.ok) throw fail('Unavailable', 'The search engine did not answer.');
        return (await response.json()) as {
          results?: ReadonlyArray<SearxngResult>;
          unresponsive_engines?: ReadonlyArray<unknown>;
        };
      },
      catch: (error) =>
        error instanceof SearchError
          ? error
          : fail('Unavailable', 'The search engine did not answer.'),
    });

  return {
    search: (request) =>
      Effect.gen(function* () {
        const body = yield* query(request);
        const seen = new Set<string>();
        const results: SearchResult[] = [];
        for (const item of body.results ?? []) {
          if (typeof item.url !== 'string' || !/^https?:\/\//.test(item.url)) continue;
          if (seen.has(item.url)) continue;
          seen.add(item.url);
          results.push({
            title: typeof item.title === 'string' ? item.title : item.url,
            url: item.url,
            snippet: typeof item.content === 'string' ? item.content : '',
            ...(typeof item.publishedDate === 'string' ? { publishedAt: item.publishedDate } : {}),
          });
          if (results.length >= request.limit) break;
        }
        if (results.length === 0 && (body.unresponsive_engines?.length ?? 0) > 0) {
          return yield* Effect.fail(fail('Unavailable', 'No search engine answered.'));
        }
        if (pages <= 0) return results;
        return yield* Effect.forEach(
          results,
          (result, index) =>
            index >= pages
              ? Effect.succeed(result)
              : Effect.promise(() =>
                  fetchPage(result.url, options.fetchOptions).then(
                    (page): SearchResult =>
                      page.text.length > result.snippet.length
                        ? { ...result, content: page.text.slice(0, pageChars) }
                        : result,
                    () => result,
                  ),
                ),
          { concurrency: 4 },
        );
      }),
  };
};
