import { describe, expect, it } from 'vitest';
import { figureColorTokens } from '@kd-learn/core';
import { defaultTheme, figureVars } from './index.ts';

describe('figureVars', () => {
  it('gives every figure token a plain color', () => {
    for (const mode of ['light', 'dark'] as const) {
      const vars = figureVars(defaultTheme, mode);
      expect(Object.keys(vars).sort()).toEqual(figureColorTokens.map((t) => `--kd-${t}`).sort());
      for (const value of Object.values(vars)) expect(value).toMatch(/^#[0-9a-f]{3,8}$/i);
    }
  });

  it('follows the mode', () => {
    expect(figureVars(defaultTheme, 'light')['--kd-bg']).toBe('#FAF9F5');
    expect(figureVars(defaultTheme, 'dark')['--kd-bg']).toBe('#1A1915');
  });
});
