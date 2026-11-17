import { Schema } from 'effect';
import defaultThemeJson from './default-theme.json' with { type: 'json' };
import { Theme } from './schema.ts';

export * from './schema.ts';
export * from './astryx-vars.ts';
export * from './contrast.ts';

/** The default kd-learn theme, from DESIGN.md. */
export const defaultTheme: Theme = Schema.decodeUnknownSync(Theme)(defaultThemeJson);
