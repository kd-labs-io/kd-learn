import { Result } from 'effect';
import { describe, expect, it } from 'vitest';
import defaultThemeJson from '../src/themes/kd.json' with { type: 'json' };
import {
  builtInThemeCss,
  builtInThemes,
  checkContrast,
  contrastRatio,
  decodeTheme,
  defaultTheme,
  textPairs,
  themeById,
  toAstryxVars,
} from '../src/index.ts';

const withColor = (key: string, value: unknown) => ({
  ...defaultThemeJson,
  colors: {
    ...defaultThemeJson.colors,
    light: { ...defaultThemeJson.colors.light, [key]: value },
  },
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

  it('rejects an unknown schema version, v1 included', () => {
    expect(Result.isFailure(decodeTheme({ ...defaultThemeJson, version: 3 }))).toBe(true);
    const v1 = { ...defaultThemeJson, version: 1, colors: defaultThemeJson.colors.light };
    expect(Result.isFailure(decodeTheme(v1))).toBe(true);
  });

  it('rejects a theme without a dark set', () => {
    const theme = { ...defaultThemeJson, colors: { light: defaultThemeJson.colors.light } };
    expect(Result.isFailure(decodeTheme(theme))).toBe(true);
  });
});

describe('contrast', () => {
  it('computes WCAG ratios', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrastRatio('#FFFFFF', '#FFFFFF')).toBeCloseTo(1, 5);
  });

  it.each(builtInThemes.map((theme) => [theme.name, theme] as const))(
    'built-in theme %s passes AA in both modes',
    (_, theme) => {
      expect(checkContrast(theme)).toEqual([]);
    },
  );

  it('kd-contrast reaches 7:1 for body text in both modes', () => {
    const theme = themeById('kd-contrast');
    for (const mode of ['light', 'dark'] as const) {
      const c = theme.colors[mode];
      for (const fg of ['text', 'text-muted'] as const)
        for (const bg of ['bg', 'surface'] as const)
          expect(contrastRatio(c[fg], c[bg])).toBeGreaterThanOrEqual(7);
    }
  });

  it('flags low-contrast text in the dark set', () => {
    const theme = {
      ...defaultTheme,
      colors: { ...defaultTheme.colors, dark: { ...defaultTheme.colors.dark, text: '#333333' } },
    };
    expect(checkContrast(theme)).toContainEqual(
      expect.objectContaining({ mode: 'dark', foreground: 'text' }),
    );
  });

  it('checks every documented pair', () => {
    expect(textPairs).toHaveLength(15);
  });
});

describe('toAstryxVars', () => {
  const vars = toAstryxVars(defaultTheme);

  it('maps DESIGN.md tokens to Astryx variables', () => {
    expect(vars['--color-background-body']).toBe('light-dark(#FAF9F5, #1A1915)');
    expect(vars['--color-accent']).toBe('light-dark(#A8502F, #E8906F)');
    expect(vars['--color-error']).toBe('light-dark(#B53B33, #EC8078)');
    expect(vars['--kd-color-text-subtle']).toBe('light-dark(#87867F, #8A877E)');
    expect(vars['--color-success-muted']).toBe(
      'light-dark(color-mix(in srgb, #46704A 12%, #FAF9F5), color-mix(in srgb, #82B988 12%, #1A1915))',
    );
    expect(vars['--radius-container']).toBe('16px');
    expect(vars['--shadow-med']).toBe(
      '0 4px 12px light-dark(rgba(20, 20, 19, 0.08), rgba(0, 0, 0, 0.16))',
    );
    expect(vars['--font-family-heading']).toBe(
      '"Source Serif 4 Variable", "Source Serif 4", Georgia, serif',
    );
  });

  it('keeps the accent stable when an unknown theme id comes back', () => {
    expect(themeById('removed-theme')).toBe(defaultTheme);
    expect(builtInThemes.map((theme) => theme.name)).toEqual(['kd', 'kd-contrast', 'ocean']);
  });

  it('emits only custom properties with safe values', () => {
    for (const [name, value] of Object.entries(vars)) {
      expect(name).toMatch(/^--[a-z0-9-]+$/);
      expect(value).not.toMatch(/url\(|;|[{}]/);
      expect(value).not.toMatch(/var\(/);
    }
  });
});

describe('builtInThemeCss', () => {
  it('declares each non-default theme on <html> and on Astryx wrappers, nothing else', () => {
    expect(builtInThemeCss).toContain(':root[data-kd-theme="ocean"] [data-astryx-theme] {');
    expect(builtInThemeCss).toContain(':root[data-kd-theme="kd-contrast"],');
    expect(builtInThemeCss).not.toContain('data-kd-theme="kd"]');
    expect(builtInThemeCss).not.toMatch(/url\(|@import|<\/style/i);
  });
});
