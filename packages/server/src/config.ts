// Server configuration from the environment (plan A6, A8). Phase 1 has no admin UI, so the
// allowed OpenAI-compatible endpoints come from `KD_OPENAI_COMPATIBLE_ENDPOINTS`.
import { Data, Result, Schema } from 'effect';
import { EndpointId } from '@kd-learn/api';

export const DEFAULT_MAX_REQUEST_BYTES = 1_048_576;

/** Bad configuration. The message names the variable, never its value. */
export class ConfigError extends Data.TaggedError('ConfigError')<{ readonly message: string }> {}

export interface Endpoint {
  readonly id: string;
  readonly label: string;
  readonly baseURL: string;
}

export interface ServerConfig {
  /** Request bodies above this many bytes are refused with `HistoryTooLarge` (plan A8). */
  readonly maxRequestBytes: number;
  /** The only OpenAI-compatible endpoints a request may name (plan A6, risk 6). */
  readonly endpoints: ReadonlyArray<Endpoint>;
  /** Origins allowed to call the API from another origin (Capacitor, a separate SPA host). */
  readonly corsOrigins: ReadonlyArray<string>;
}

const EndpointEntry = Schema.Struct({
  id: EndpointId,
  label: Schema.optionalKey(Schema.NonEmptyString),
  baseURL: Schema.NonEmptyString,
});
const EndpointList = Schema.Array(EndpointEntry);

const endpointsFrom = (raw: string): ReadonlyArray<Endpoint> => {
  const name = 'KD_OPENAI_COMPATIBLE_ENDPOINTS';
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new ConfigError({ message: `${name} is not valid JSON.` });
  }
  const decoded = Schema.decodeUnknownResult(EndpointList)(json);
  if (Result.isFailure(decoded)) {
    throw new ConfigError({
      message: `${name} must be a JSON array of {"id", "baseURL", "label"?}.`,
    });
  }
  const seen = new Set<string>();
  return decoded.success.map((entry) => {
    if (seen.has(entry.id)) throw new ConfigError({ message: `${name} repeats an id.` });
    seen.add(entry.id);
    let url: URL;
    try {
      url = new URL(entry.baseURL);
    } catch {
      throw new ConfigError({ message: `${name}: baseURL of "${entry.id}" is not a URL.` });
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new ConfigError({
        message: `${name}: baseURL of "${entry.id}" must be http or https.`,
      });
    }
    if (url.username !== '' || url.password !== '') {
      throw new ConfigError({
        message: `${name}: baseURL of "${entry.id}" must not embed credentials.`,
      });
    }
    return { id: entry.id, label: entry.label ?? entry.id, baseURL: entry.baseURL };
  });
};

const originsFrom = (raw: string): ReadonlyArray<string> =>
  raw
    .split(',')
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter((origin) => origin !== '');

/**
 * Reads the configuration:
 * - `KD_OPENAI_COMPATIBLE_ENDPOINTS`: JSON array of `{"id", "baseURL", "label"?}`. Default none.
 * - `KD_MAX_REQUEST_BYTES`: request size limit. Default 1 MiB.
 * - `KD_CORS_ORIGINS`: comma-separated origins allowed cross-origin. Default none (same origin only).
 * Throws `ConfigError` when a variable is set but invalid.
 */
export const loadConfig = (env: Readonly<Record<string, string | undefined>>): ServerConfig => {
  const limitRaw = env.KD_MAX_REQUEST_BYTES?.trim();
  let maxRequestBytes = DEFAULT_MAX_REQUEST_BYTES;
  if (limitRaw) {
    const parsed = Number(limitRaw);
    if (!Number.isSafeInteger(parsed) || parsed < 1024) {
      throw new ConfigError({
        message: 'KD_MAX_REQUEST_BYTES must be an integer of at least 1024.',
      });
    }
    maxRequestBytes = parsed;
  }
  const endpointsRaw = env.KD_OPENAI_COMPATIBLE_ENDPOINTS?.trim();
  return {
    maxRequestBytes,
    endpoints: endpointsRaw ? endpointsFrom(endpointsRaw) : [],
    corsOrigins: originsFrom(env.KD_CORS_ORIGINS ?? ''),
  };
};
