import { Schema } from 'effect';

/**
 * Theme data (plan 2.3, risk 11). A theme is plain data: token values only,
 * no CSS, no JS, no URLs. Token names follow DESIGN.md and are the contract
 * for every theme: a theme may change values, not add or rename tokens.
 */

export const THEME_SCHEMA_VERSION = 1;

/** `#RGB` or `#RRGGBB` only. Rejects `url(...)`, `var(...)`, keywords and functions. */
export const HexColor = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, { expected: 'a hex color' }),
  ),
);

const pixels = (min: number, max: number) =>
  Schema.Finite.pipe(
    Schema.check(Schema.isInt(), Schema.isBetween({ minimum: min, maximum: max })),
  );

/** Fonts that ship with the app (self-hosted, Vietnamese support). */
export const HeadingFont = Schema.Literals(['Source Serif 4', 'Inter', 'Georgia']);
export const BodyFont = Schema.Literals(['Inter', 'Source Serif 4', 'system-ui']);
export const CodeFont = Schema.Literals(['JetBrains Mono', 'ui-monospace']);

export const ColorTokens = Schema.Struct({
  bg: HexColor,
  surface: HexColor,
  border: HexColor,
  text: HexColor,
  'text-muted': HexColor,
  'text-subtle': HexColor,
  accent: HexColor,
  'accent-strong': HexColor,
  'on-accent': HexColor,
  success: HexColor,
  warning: HexColor,
  danger: HexColor,
  info: HexColor,
  'focus-ring': HexColor,
});

const TypeStep = Schema.Struct({ size: pixels(8, 96), lineHeight: pixels(8, 128) });

export const TypeScale = Schema.Struct({
  xs: TypeStep,
  sm: TypeStep,
  base: TypeStep,
  lg: TypeStep,
  xl: TypeStep,
  '2xl': TypeStep,
  '3xl': TypeStep,
});

/** A shadow is structured so no free-form CSS gets in. Color is always the theme's `text`. */
const Shadow = Schema.Struct({
  offsetY: pixels(0, 64),
  blur: pixels(0, 128),
  opacity: Schema.Finite.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 1 }))),
});

export const Theme = Schema.Struct({
  version: Schema.Literal(THEME_SCHEMA_VERSION),
  name: Schema.String.pipe(
    Schema.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,47}$/, { expected: 'a lowercase slug' })),
  ),
  colors: ColorTokens,
  fonts: Schema.Struct({ heading: HeadingFont, body: BodyFont, code: CodeFont }),
  typeScale: TypeScale,
  radius: Schema.Struct({ sm: pixels(0, 32), md: pixels(0, 32), lg: pixels(0, 48) }),
  shadow: Schema.Struct({ sm: Shadow, md: Shadow, lg: Shadow }),
});

export type Theme = typeof Theme.Type;
export type ColorToken = keyof Theme['colors'];

/** Decodes untrusted theme data (import, marketplace). Unknown keys are an error. */
export const decodeTheme = Schema.decodeUnknownResult(Theme, { onExcessProperty: 'error' });
