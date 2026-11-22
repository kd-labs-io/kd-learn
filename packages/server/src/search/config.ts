// The server's search sources (plan nguon-hoc.md A6). SearXNG comes only from `KD_SEARXNG_URL`; the
// Exa key is the admin's, sealed with the secret box like account keys (risk 22). Switches live in
// `server_config`. `providers(mode)` is what a research of that mode may use: accounts any enabled
// source; guests only SearXNG, when the admin allows it; demo the one source the admin picked.
import type { AdminSearchConfig, SearchProvider, UpdateAdminSearchRequest } from '@kd-learn/api';
import type { SearchService } from '@kd-learn/search/port';
import { makeExa } from '@kd-learn/search/exa';
import { makeSearxng } from '@kd-learn/search/searxng';
import type { ServerDatabase } from '@kd-learn/storage/sqlite-node';
import type { SecretBox } from '../settings/secret-box.ts';

export type SearchMode = 'account' | 'guest' | 'demo';

export interface SearchAdapters {
  readonly searxng: (baseUrl: string) => SearchService;
  readonly exa: (apiKey: string) => SearchService;
}

export const defaultAdapters: SearchAdapters = {
  searxng: (baseUrl) => makeSearxng({ baseUrl }),
  exa: (apiKey) => makeExa({ apiKey }),
};

export interface SearchConfigService {
  readonly config: () => AdminSearchConfig;
  readonly update: (change: UpdateAdminSearchRequest) => AdminSearchConfig;
  /** Usable sources of a mode, the default first. */
  readonly providers: (mode: SearchMode) => ReadonlyArray<SearchProvider>;
  /** The adapter, or undefined when the source is not usable in that mode. */
  readonly service: (mode: SearchMode, provider: SearchProvider) => SearchService | undefined;
}

const EXA_CONTEXT = 'server:search:exa';

interface SealedKey {
  readonly sealed: string;
  readonly version: number;
  readonly last4?: string;
}

/** Without accounts (no database): guests may use SearXNG when it is configured. */
export const envOnlySearch = (
  searxngUrl: string | undefined,
  adapters: SearchAdapters = defaultAdapters,
): Pick<SearchConfigService, 'providers' | 'service'> => {
  const searxng = searxngUrl === undefined ? undefined : adapters.searxng(searxngUrl);
  return {
    providers: (mode) => (mode === 'guest' && searxng !== undefined ? ['searxng'] : []),
    service: (mode, provider) => (mode === 'guest' && provider === 'searxng' ? searxng : undefined),
  };
};

export const makeSearchConfig = (deps: {
  readonly database: ServerDatabase;
  readonly box: SecretBox;
  readonly searxngUrl: string | undefined;
  readonly adapters?: SearchAdapters;
}): SearchConfigService => {
  const { db } = deps.database;
  const adapters = deps.adapters ?? defaultAdapters;
  const q = {
    get: db.prepare('SELECT value FROM server_config WHERE key = ?'),
    put: db.prepare('INSERT OR REPLACE INTO server_config (key, value) VALUES (?, ?)'),
    del: db.prepare('DELETE FROM server_config WHERE key = ?'),
  };
  const read = (key: string) => (q.get.get(key) as { value: string } | undefined)?.value;
  const flag = (key: string, fallback: boolean) => {
    const value = read(key);
    return value === undefined ? fallback : value === 'true';
  };
  const searxng = deps.searxngUrl === undefined ? undefined : adapters.searxng(deps.searxngUrl);

  const exaKey = (): SealedKey | undefined => {
    const stored = read('search.exaKey');
    return stored === undefined ? undefined : (JSON.parse(stored) as SealedKey);
  };
  // The opened key and its adapter, rebuilt only when the stored key changes.
  let exaCache:
    { readonly sealed: string; readonly service: SearchService | undefined } | undefined;
  const exaService = (): SearchService | undefined => {
    const key = exaKey();
    if (key === undefined) return undefined;
    if (exaCache?.sealed !== key.sealed) {
      const apiKey = deps.box.open(key.sealed, key.version, EXA_CONTEXT);
      exaCache = {
        sealed: key.sealed,
        service: apiKey === undefined ? undefined : adapters.exa(apiKey),
      };
    }
    return exaCache.service;
  };

  const config = (): AdminSearchConfig => {
    const key = exaKey();
    const guest = read('search.guest');
    const demo = read('search.demo');
    return {
      searxng: { configured: searxng !== undefined, enabled: flag('search.searxng', true) },
      exa: {
        hasKey: key !== undefined,
        ...(key?.last4 === undefined ? {} : { keyLast4: key.last4 }),
        enabled: flag('search.exa', true),
      },
      guest: guest === 'off' ? 'off' : 'searxng',
      demo: demo === 'searxng' || demo === 'exa' ? demo : 'off',
    };
  };

  /** Server sources that can run now: configured (or keyed) and enabled. */
  const usable = (provider: SearchProvider): SearchService | undefined => {
    const current = config();
    if (provider === 'searxng') return current.searxng.enabled ? searxng : undefined;
    return current.exa.enabled ? exaService() : undefined;
  };

  const allowed = (mode: SearchMode): ReadonlyArray<SearchProvider> => {
    const current = config();
    if (mode === 'guest') return current.guest === 'searxng' ? ['searxng'] : [];
    if (mode === 'demo') return current.demo === 'off' ? [] : [current.demo];
    return ['searxng', 'exa'];
  };

  return {
    config,
    update: (change) => {
      deps.database.transaction(() => {
        if (change.searxngEnabled !== undefined) {
          q.put.run('search.searxng', String(change.searxngEnabled));
        }
        if (change.exaEnabled !== undefined) q.put.run('search.exa', String(change.exaEnabled));
        if (change.exaKey === null) q.del.run('search.exaKey');
        if (typeof change.exaKey === 'string') {
          const sealed: SealedKey = {
            sealed: deps.box.seal(change.exaKey, EXA_CONTEXT),
            version: deps.box.version,
            ...(change.exaKey.length >= 12 ? { last4: change.exaKey.slice(-4) } : {}),
          };
          q.put.run('search.exaKey', JSON.stringify(sealed));
        }
        if (change.guest !== undefined) q.put.run('search.guest', change.guest);
        if (change.demo !== undefined) q.put.run('search.demo', change.demo);
      });
      return config();
    },
    providers: (mode) => allowed(mode).filter((provider) => usable(provider) !== undefined),
    service: (mode, provider) => (allowed(mode).includes(provider) ? usable(provider) : undefined),
  };
};
