import { Theme as AstryxTheme } from '@astryxdesign/core/theme';
import { accountClient, type Appearance } from '@kd-learn/api';
import { themeById, type ColorMode, type Theme } from '@kd-learn/tokens';
import { kdTheme } from '@kd-learn/tokens/astryx';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { clientOptions, run } from '../account/api';
import { useWho } from '../account/auth';
import {
  formatAppearance,
  htmlThemeAttribute,
  parseAppearance,
  readAppearance,
  writeAppearanceCookie,
} from './appearance';

interface ThemeControl {
  /** What the user chose: mode (`system` included) and built-in theme id. */
  readonly appearance: Appearance;
  readonly setAppearance: (appearance: Appearance) => void;
  /** The chosen built-in theme (the default one for an unknown id). */
  readonly theme: Theme;
  /** `system` turned into `light` or `dark` on this device: for figures, which need plain colors. */
  readonly resolvedMode: ColorMode;
}

const ThemeControlContext = createContext<ThemeControl | null>(null);

export const useThemeControl = () => {
  const value = useContext(ThemeControlContext);
  if (!value) throw new Error('useThemeControl must be used inside <ThemeRoot>');
  return value;
};

/** The same attributes Astryx's root Theme writes for the mode, plus the theme id (plan A2). */
const setHtmlAttributes = (appearance: Appearance) => {
  const root = document.documentElement;
  const mode = htmlThemeAttribute(appearance);
  if (mode === undefined) root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', mode);
  root.setAttribute('data-kd-theme', appearance.theme);
};

const DARK_QUERY = '(prefers-color-scheme: dark)';

const subscribeScheme = (listener: () => void) => {
  const query = globalThis.matchMedia?.(DARK_QUERY);
  query?.addEventListener('change', listener);
  return () => query?.removeEventListener('change', listener);
};
const systemDark = () => globalThis.matchMedia?.(DARK_QUERY).matches ?? false;

/** The OS preference, followed live; the server render (and hydration) assume light. */
const useSystemMode = (): ColorMode =>
  useSyncExternalStore(
    subscribeScheme,
    () => (systemDark() ? 'dark' : 'light'),
    () => 'light',
  );

/**
 * Keeps an account's appearance on the server (plan A3): the saved value wins when the app opens
 * signed in; an account that has saved nothing gets this device's value. Failures are ignored, the
 * device keeps its own choice.
 */
function useAccountSync(
  appearance: Appearance,
  apply: (appearance: Appearance) => void,
): (appearance: Appearance) => void {
  const current = useWho();
  const token = current.status === 'signed-in' ? current.token : undefined;
  const latest = useRef(appearance);
  latest.current = appearance;

  useEffect(() => {
    if (token === undefined) return;
    let cancelled = false;
    const api = accountClient(clientOptions(token));
    run(api.appearance(), token)
      .then(({ appearance: saved }) => {
        if (cancelled) return;
        if (saved === null) return run(api.saveAppearance(latest.current), token);
        apply(parseAppearance(formatAppearance(saved)));
        return undefined;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [token, apply]);

  return useCallback(
    (next: Appearance) => {
      if (token === undefined) return;
      run(accountClient(clientOptions(token)).saveAppearance(next), token).catch(() => undefined);
    },
    [token],
  );
}

/**
 * The static Astryx theme (built from the default theme, every color `light-dark()`) in the chosen
 * mode, plus the chosen built-in theme: its CSS is in `<head>` keyed on `data-kd-theme` on `<html>`
 * (plan A2, spike C1), so this only keeps that attribute current.
 */
export function ThemeRoot({ children }: { children: ReactNode }) {
  const [appearance, setLocal] = useState<Appearance>(readAppearance);
  const apply = useCallback((next: Appearance) => {
    writeAppearanceCookie(next);
    // Before React re-renders: effects of figures and the graph read computed colors.
    setHtmlAttributes(next);
    setLocal(next);
  }, []);
  const save = useAccountSync(appearance, apply);
  const setAppearance = useCallback(
    (next: Appearance) => {
      apply(next);
      save(next);
    },
    [apply, save],
  );

  useEffect(() => setHtmlAttributes(appearance), [appearance]);

  const system = useSystemMode();
  const resolvedMode: ColorMode = appearance.mode === 'system' ? system : appearance.mode;
  const theme = themeById(appearance.theme);
  const control = useMemo(
    () => ({ appearance, setAppearance, theme, resolvedMode }),
    [appearance, setAppearance, theme, resolvedMode],
  );

  return (
    <AstryxTheme theme={kdTheme} mode={appearance.mode}>
      <ThemeControlContext.Provider value={control}>
        <div style={rootStyle}>{children}</div>
      </ThemeControlContext.Provider>
    </AstryxTheme>
  );
}

const rootStyle: CSSProperties = {
  minHeight: '100dvh',
  background: 'var(--color-background-body)',
  color: 'var(--color-text-primary)',
  fontFamily: 'var(--font-family-body)',
};
