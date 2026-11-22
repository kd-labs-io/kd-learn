import { Schema } from 'effect';
import kdJson from './themes/kd.json' with { type: 'json' };
import kdContrastJson from './themes/kd-contrast.json' with { type: 'json' };
import oceanJson from './themes/ocean.json' with { type: 'json' };
import { themeCss } from './astryx-vars.ts';
import { Theme } from './schema.ts';

export * from './schema.ts';
export * from './astryx-vars.ts';
export * from './contrast.ts';
export * from './figure-vars.ts';

const load = (json: unknown): Theme => Schema.decodeUnknownSync(Theme)(json);

/** The default kd-learn theme, from DESIGN.md. */
export const defaultTheme: Theme = load(kdJson);

/** Built-in themes (plan theme-va-dien-thoai.md A2), in the order the picker shows them. */
export const builtInThemes: ReadonlyArray<Theme> = [
  defaultTheme,
  load(kdContrastJson),
  load(oceanJson),
];

export const builtInThemeIds = builtInThemes.map((theme) => theme.name);

/** CSS of every built-in theme but the static default, for `<head>` (see `themeCss`). */
export const builtInThemeCss = themeCss(builtInThemes.filter((theme) => theme !== defaultTheme));

/** A built-in theme by id; an unknown id (a theme removed in a later build) falls back to `kd`. */
export const themeById = (id: string): Theme =>
  builtInThemes.find((theme) => theme.name === id) ?? defaultTheme;
