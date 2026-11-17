import { defineTheme } from '@astryxdesign/core/theme';
import { toAstryxVars } from '../astryx-vars.ts';
import { defaultTheme } from '../index.ts';

// Font families come from `tokens` (--font-family-*), so the stacks stay in one place.

// The kd-learn Astryx theme, built from the default theme data (DESIGN.md).
// Light only for now: dark mode comes after the core phases.
export const kdTheme = defineTheme({
  name: 'kd',
  tokens: toAstryxVars(defaultTheme),
});
