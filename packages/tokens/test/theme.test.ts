import { Result } from 'effect';
import { describe, expect, it } from 'vitest';
import defaultThemeJson from '../src/default-theme.json' with { type: 'json' };
import {
  checkContrast,
  contrastRatio,
  decodeTheme,
  defaultTheme,
  toAstryxVars,
} from '../src/index.ts';

const withColor = (key: string, value: unknown) => ({
  ...defaultThemeJson,
  colors: { ...defaultThemeJson.colors, [key]: value },
});

describe('theme schema', () => {
  it('accepts the default theme', () => {
    expect(Result.isSuccess(decodeTheme(defaultThemeJson))).toBe(true);
  });

  it.each([
    ['url', 'url(https://tracker.example/x.png)'],
    ['var', 'var(--other)'],
    ['css injection', '#fff; background: red'],
    ['keyword', 'red'],
    ['function', 'rgb(0 0 0)'],
  ])('rejects a non-hex color (%s)', (_, value) => {
    expect(Result.isFailure(decodeTheme(withColor('bg', value)))).toBe(true);
  });

  it('rejects unknown tokens', () => {
    expect(Result.isFailure(decodeTheme(withColor('brand', '#000000')))).toBe(true);
    expect(Result.isFailure(decodeTheme({ ...defaultThemeJson, css: 'body{}' }))).toBe(true);
  });

  it('rejects fonts outside the allow list', () => {
    const theme = { ...defaultThemeJson, fonts: { ...defaultThemeJson.fonts, body: 'Comic Sans' } };
    expect(Result.isFailure(decodeTheme(theme))).toBe(true);
  });

  it('rejects an unknown schema version', () => {
    expect(Result.isFailure(decodeTheme({ ...defaultThemeJson, version: 2 }))).toBe(true);
  });
});

describe('contrast', () => {
  it('computes WCAG ratios', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrastRatio('#FFFFFF', '#FFFFFF')).toBeCloseTo(1, 5);
  });

  it('the default theme passes AA', () => {
    expect(checkContrast(defaultTheme)).toEqual([]);
  });

  it('flags low-contrast text', () => {
    const theme = { ...defaultTheme, colors: { ...defaultTheme.colors, text: '#EEEEEE' } };
    expect(checkContrast(theme).map((issue) => issue.foreground)).toContain('text');
  });
});

describe('toAstryxVars', () => {
  const vars = toAstryxVars(defaultTheme);

  it('maps DESIGN.md tokens to Astryx variables', () => {
    expect(vars['--color-background-body']).toBe('#FAF9F5');
    expect(vars['--color-accent']).toBe('#A8502F');
    expect(vars['--color-error']).toBe('#B53B33');
    expect(vars['--kd-color-text-subtle']).toBe('#87867F');
    expect(vars['--radius-container']).toBe('16px');
    expect(vars['--shadow-med']).toBe('0 4px 12px rgba(20, 20, 19, 0.08)');
    expect(vars['--font-family-heading']).toBe(
      '"Source Serif 4 Variable", "Source Serif 4", Georgia, serif',
    );
  });

  it('emits only custom properties with safe values', () => {
    for (const [name, value] of Object.entries(vars)) {
      expect(name).toMatch(/^--[a-z0-9-]+$/);
      expect(value).not.toMatch(/url\(|;|[{}]/);
    }
  });
});
