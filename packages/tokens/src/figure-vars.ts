import type { FigureColorToken } from '@kd-learn/core';
import type { ColorMode, Theme } from './schema.ts';

/** The `--kd-*` colors a figure may use (plan hinh-va-demo.md A3, A8), as CSS custom properties. */
export type FigureVars = Readonly<Record<`--kd-${FigureColorToken}`, string>>;

/**
 * Picks the figure colors of a theme in one resolved mode. Plain colors only (no `var()`, no
 * `light-dark()`, no `color-mix`): the values go into SVG blobs, a sandboxed frame and Mermaid's
 * theme, none of which see the app's variables. The six categorical colors reuse the accent and
 * status colors, so every theme has them.
 */
export const figureVars = (theme: Theme, mode: ColorMode): FigureVars => {
  const c = theme.colors[mode];
  return {
    '--kd-fg': c.text,
    '--kd-bg': c.bg,
    '--kd-muted': c['text-muted'],
    '--kd-accent': c.accent,
    '--kd-border': c.border,
    '--kd-cat-1': c.accent,
    '--kd-cat-2': c.info,
    '--kd-cat-3': c.success,
    '--kd-cat-4': c.warning,
    '--kd-cat-5': c.danger,
    '--kd-cat-6': c['text-subtle'],
  };
};
