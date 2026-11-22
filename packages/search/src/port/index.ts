// Search port (plan nguon-hoc.md A6): "search the web for this query". Pure: only `effect` is
// imported here, so `packages/agent` may depend on it. Adapters live next to it (SearXNG, Exa).
import { Context, Data, Schema } from 'effect';
import type { Effect } from 'effect';

export interface SearchRequest {
  readonly query: string;
  /** Results wanted (an adapter may return fewer). */
  readonly limit: number;
  /** BCP 47 language of the results, e.g. `vi`, `en`. */
  readonly language?: string;
}

export const SearchResult = Schema.Struct({
  title: Schema.String,
  url: Schema.String,
  /** Short text the source returned with the result. */
  snippet: Schema.String,
  /** Longer readable text, when the adapter has it (Exa highlights, a fetched page). */
  content: Schema.optionalKey(Schema.String),
  publishedAt: Schema.optionalKey(Schema.String),
});
export type SearchResult = typeof SearchResult.Type;

/**
 * `Unavailable`: the source is down or answered nothing usable. `Unauthorized`: the key was
 * refused. `PaymentRequired`: out of credits. `RateLimited`: try later. `Invalid`: the request was
 * refused. `message` is fixed text from the adapter: never a key, never the source's own body.
 */
export class SearchError extends Data.TaggedError('SearchError')<{
  readonly reason: 'Unavailable' | 'Unauthorized' | 'PaymentRequired' | 'RateLimited' | 'Invalid';
  readonly message: string;
  readonly retryAfterSeconds?: number;
}> {}

export interface SearchService {
  readonly search: (
    request: SearchRequest,
  ) => Effect.Effect<ReadonlyArray<SearchResult>, SearchError>;
}

export class SearchPort extends Context.Service<SearchPort, SearchService>()(
  '@kd-learn/search/SearchPort',
) {}
