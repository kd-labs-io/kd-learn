// Figure bodies for the learning screen (phase 5 A7, A8): from the local DB for guests and demo,
// from the account API otherwise. The API is Bearer-only, so bodies come through fetch and the UI
// shows them from blob URLs; nothing here builds markup.
import { figureVars, type ColorMode, type FigureVars, type Theme } from '@kd-learn/tokens';
import type { FigureBodyLoader } from '@kd-learn/ui/components/LessonFigure';
import { runStorage } from '../storage/client';
import { apiBaseUrl } from './hooks';

export const guestFigureLoader: FigureBodyLoader = async (figureId) =>
  (await runStorage((storage) => storage.readFigure(figureId)))?.body;

const accountLoaders = new Map<string, FigureBodyLoader>();

/** One loader per token, so the screen keeps a stable function. Bodies never change: cached. */
export const accountFigureLoader = (token: string): FigureBodyLoader => {
  let loader = accountLoaders.get(token);
  if (loader === undefined) {
    const cache = new Map<string, Promise<string | Uint8Array | undefined>>();
    loader = (figureId) => {
      let body = cache.get(figureId);
      if (body === undefined) {
        body = fetch(`${apiBaseUrl}/api/account/figures/${encodeURIComponent(figureId)}`, {
          headers: { authorization: `Bearer ${token}` },
        }).then(async (response) => {
          if (!response.ok) return undefined;
          return (response.headers.get('content-type') ?? '').startsWith('text/')
            ? response.text()
            : new Uint8Array(await response.arrayBuffer());
        });
        body.then(
          (value) => value === undefined && cache.delete(figureId),
          () => cache.delete(figureId),
        );
        cache.set(figureId, body);
      }
      return body;
    };
    accountLoaders.set(token, loader);
  }
  return loader;
};

const varsCache = new WeakMap<Theme, Map<ColorMode, FigureVars>>();

/** Figure colors of the theme in use, in the resolved mode; the same object while both stay. */
export const figureVarsOf = (theme: Theme, mode: ColorMode): FigureVars => {
  let byMode = varsCache.get(theme);
  if (byMode === undefined) {
    byMode = new Map();
    varsCache.set(theme, byMode);
  }
  let vars = byMode.get(mode);
  if (vars === undefined) {
    vars = figureVars(theme, mode);
    byMode.set(mode, vars);
  }
  return vars;
};
