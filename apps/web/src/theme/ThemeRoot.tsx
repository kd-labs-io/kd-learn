import { Theme as AstryxTheme } from '@astryxdesign/core/theme';
import { toAstryxVars, type Theme } from '@kd-learn/tokens';
import { kdTheme } from '@kd-learn/tokens/astryx';
import {
  createContext,
  useContext,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';

interface ThemeControl {
  readonly override: Theme | null;
  readonly setOverride: (theme: Theme | null) => void;
}

const ThemeControlContext = createContext<ThemeControl | null>(null);

export const useThemeControl = () => {
  const value = useContext(ThemeControlContext);
  if (!value) throw new Error('useThemeControl must be used inside <ThemeRoot>');
  return value;
};

/**
 * Static Astryx theme (built from DESIGN.md) plus an optional runtime theme.
 * Runtime values go on an element inside the `[data-astryx-theme]` wrapper as
 * inline custom properties: the built theme re-declares every token on that
 * wrapper, so values set on :root would never reach components.
 */
export function ThemeRoot({ children }: { children: ReactNode }) {
  const [override, setOverride] = useState<Theme | null>(null);
  const style = useMemo(
    () =>
      ({
        ...(override ? toAstryxVars(override) : {}),
        minHeight: '100dvh',
        background: 'var(--color-background-body)',
        color: 'var(--color-text-primary)',
        fontFamily: 'var(--font-family-body)',
      }) as CSSProperties,
    [override],
  );
  const control = useMemo(() => ({ override, setOverride }), [override]);

  return (
    <AstryxTheme theme={kdTheme} mode="light">
      <ThemeControlContext.Provider value={control}>
        <div data-kd-theme={override?.name ?? 'kd'} style={style}>
          {children}
        </div>
      </ThemeControlContext.Provider>
    </AstryxTheme>
  );
}
