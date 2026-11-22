import { describe, expect, it } from 'vitest';
import { figureColorTokens } from '@kd-learn/core';
import { defaultTheme, figureVars } from './index.ts';

describe('figureVars', () => {
  it('gives every figure token a plain color', () => {
    const vars = figureVars(defaultTheme);
    expect(Object.keys(vars).sort()).toEqual(figureColorTokens.map((t) => `--kd-${t}`).sort());
    for (const value of Object.values(vars)) expect(value).toMatch(/^#[0-9a-f]{3,8}$/i);
  });
});
