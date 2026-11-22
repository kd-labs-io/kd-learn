import type { ColorMode, ColorToken, ColorTokens, Theme } from './schema.ts';

/** WCAG 2.x relative luminance of a `#RGB` / `#RRGGBB` color. */
const luminance = (hex: string) => {
  const digits = hex.slice(1);
  const full = digits.length === 3 ? [...digits].map((d) => d + d).join('') : digits;
  const channel = (i: number) => {
    const v = Number.parseInt(full.slice(i, i + 2), 16) / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
};

export const contrastRatio = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

/** Text pairs that must reach WCAG AA (4.5:1), per DESIGN.md. */
export const textPairs: ReadonlyArray<readonly [ColorToken, ColorToken]> = [
  ...(
    ['text', 'text-muted', 'accent-strong', 'success', 'warning', 'danger', 'info'] as const
  ).flatMap(
    (fg) =>
      [
        [fg, 'bg'],
        [fg, 'surface'],
      ] as const,
  ),
  ['on-accent', 'accent-strong'],
];

export interface ContrastIssue {
  readonly mode: ColorMode;
  readonly foreground: ColorToken;
  readonly background: ColorToken;
  readonly ratio: number;
}

const checkSet = (mode: ColorMode, colors: ColorTokens, minimum: number) =>
  textPairs.flatMap(([foreground, background]) => {
    const ratio = contrastRatio(colors[foreground], colors[background]);
    return ratio < minimum ? [{ mode, foreground, background, ratio }] : [];
  });

/**
 * Returns every text pair below `minimum` (AA by default) in both color sets. An empty list means
 * the theme is safe to apply.
 */
export const checkContrast = (theme: Theme, minimum = 4.5): ReadonlyArray<ContrastIssue> => [
  ...checkSet('light', theme.colors.light, minimum),
  ...checkSet('dark', theme.colors.dark, minimum),
];
