import type { Theme } from './schema.ts';

/**
 * The one mapping from kd-learn tokens (DESIGN.md) to Astryx CSS variables.
 * Used both to build the static Astryx theme and to apply a theme at runtime.
 *
 * Tokens Astryx has no slot for get a `--kd-*` variable.
 */
export type CssVars = Readonly<Record<`--${string}`, string>>;

const fallbacks = {
  'Source Serif 4': 'Georgia, serif',
  Georgia: 'serif',
  Inter: 'system-ui, sans-serif',
  'system-ui': 'sans-serif',
  'JetBrains Mono': 'ui-monospace, monospace',
  'ui-monospace': 'monospace',
} as const;

/** Self-hosted fonts are variable builds, registered as "<family> Variable" (Fontsource). */
const selfHosted = new Set(['Source Serif 4', 'Inter', 'JetBrains Mono']);

const fontStack = (family: keyof typeof fallbacks) =>
  [selfHosted.has(family) ? `"${family} Variable"` : null, `"${family}"`, fallbacks[family]]
    .filter(Boolean)
    .join(', ');

const hexToRgb = (hex: string): [number, number, number] => {
  const digits = hex.slice(1);
  const full = digits.length === 3 ? [...digits].map((d) => d + d).join('') : digits;
  const value = Number.parseInt(full, 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
};

/** Status tint: ~12% of the color over the page background (DESIGN.md). */
const tint = (color: string, bg: string) => `color-mix(in srgb, ${color} 12%, ${bg})`;

const shadow = (s: Theme['shadow']['sm'], text: string) => {
  const [r, g, b] = hexToRgb(text);
  return `0 ${s.offsetY}px ${s.blur}px rgba(${r}, ${g}, ${b}, ${s.opacity})`;
};

const px = (n: number) => `${n / 16}rem`;

export const toAstryxVars = (theme: Theme): CssVars => {
  const c = theme.colors;
  const t = theme.typeScale;
  const status = (name: 'success' | 'warning' | 'error' | 'info', color: string) => ({
    [`--color-${name}`]: color,
    [`--color-on-${name}`]: c['on-accent'],
    [`--color-${name}-muted`]: tint(color, c.bg),
    [`--color-on-${name}-muted`]: color,
    [`--color-text-${name}`]: color,
    [`--color-icon-${name}`]: color,
    [`--color-border-${name}`]: color,
  });

  return {
    // Surfaces
    '--color-background-body': c.bg,
    '--color-background-surface': c.surface,
    '--color-background-card': c.surface,
    '--color-background-muted': c.surface,
    '--color-background-popover': c.bg,
    '--color-border': c.border,
    '--color-border-emphasized': c['text-subtle'],

    // Text and icons
    '--color-text-primary': c.text,
    '--color-text-secondary': c['text-muted'],
    '--color-icon-primary': c.text,
    '--color-icon-secondary': c['text-muted'],
    '--kd-color-text-subtle': c['text-subtle'],

    // Accent: Astryx's accent is the strong one (primary button, links).
    '--color-accent': c['accent-strong'],
    '--color-on-accent': c['on-accent'],
    '--color-text-accent': c['accent-strong'],
    '--color-accent-muted': tint(c.accent, c.bg),
    '--color-icon-accent': c.accent,
    '--kd-color-accent': c.accent,

    // Status
    ...status('success', c.success),
    ...status('warning', c.warning),
    ...status('error', c.danger),
    ...status('info', c.info),

    // Focus: 2px ring, 2px offset
    '--focus-outline-color': c['focus-ring'],
    '--focus-outline-width': '2px',
    '--focus-outline-offset': '2px',

    // Typography
    '--font-family-heading': fontStack(theme.fonts.heading),
    '--font-family-body': fontStack(theme.fonts.body),
    '--font-family-code': fontStack(theme.fonts.code),
    '--font-size-xs': px(t.xs.size),
    '--font-size-sm': px(t.sm.size),
    '--font-size-base': px(t.base.size),
    '--font-size-lg': px(t.lg.size),
    '--font-size-xl': px(t.xl.size),
    '--font-size-2xl': px(t['2xl'].size),
    '--font-size-3xl': px(t['3xl'].size),
    '--text-body-size': px(t.base.size),
    '--text-body-leading': px(t.base.lineHeight),
    '--text-large-size': px(t.lg.size),
    '--text-large-leading': px(t.lg.lineHeight),
    '--text-supporting-size': px(t.sm.size),
    '--text-supporting-leading': px(t.sm.lineHeight),
    '--text-label-size': px(t.xs.size),
    '--text-label-leading': px(t.xs.lineHeight),
    '--text-heading-1-size': px(t['3xl'].size),
    '--text-heading-1-leading': px(t['3xl'].lineHeight),
    '--text-heading-2-size': px(t['2xl'].size),
    '--text-heading-2-leading': px(t['2xl'].lineHeight),
    '--text-heading-3-size': px(t.xl.size),
    '--text-heading-3-leading': px(t.xl.lineHeight),

    // Shape and elevation
    '--radius-inner': `${theme.radius.sm}px`,
    '--radius-element': `${theme.radius.md}px`,
    '--radius-container': `${theme.radius.lg}px`,
    '--shadow-low': shadow(theme.shadow.sm, c.text),
    '--shadow-med': shadow(theme.shadow.md, c.text),
    '--shadow-high': shadow(theme.shadow.lg, c.text),
  };
};
