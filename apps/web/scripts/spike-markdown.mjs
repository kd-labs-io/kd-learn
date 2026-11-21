// SPIKE (phase 1 step 6): Playwright driver for the Markdown + KaTeX streaming spike (plan loi-day-hoc C2).
// Prereq: `pnpm build` and `pnpm build:spa`, `pnpm exec playwright install chromium firefox webkit`.
// Usage: node scripts/spike-markdown.mjs [chromium|firefox|webkit] [out.json] [screenshotDir]
/* global document, window */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { chromium, firefox, webkit } from '@playwright/test';

const here = fileURLToPath(new URL('.', import.meta.url));
const appDir = join(here, '..');
const browserName = process.argv[2] ?? 'chromium';
const outFile = process.argv[3];
const shotDir = process.argv[4];
const engine = { chromium, firefox, webkit }[browserName];
if (shotDir) mkdirSync(shotDir, { recursive: true });

const procs = [];
const start = (cmd, args, env = {}) =>
  procs.push(
    spawn(cmd, args, {
      cwd: appDir,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'ignore', 'inherit'],
    }),
  );
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
process.on('exit', () => procs.forEach((p) => p.kill()));

const ssrPort = 3100 + Math.floor(Math.random() * 400);
const spaPort = 4300 + Math.floor(Math.random() * 400);
start('node', ['.output/server/index.mjs'], { PORT: String(ssrPort) });
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
};
const spaRoot = join(appDir, 'dist', 'client');
// Static server for the SPA build with index.html fallback (like a Capacitor WebView).
const spaServer = createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.includes('..') || path === '/' ? 'index.html' : path.slice(1);
  const body = await readFile(join(spaRoot, file)).catch(() => null);
  const ext = file.slice(file.lastIndexOf('.'));
  if (body)
    res.writeHead(200, { 'content-type': types[ext] ?? 'application/octet-stream' }).end(body);
  else
    res
      .writeHead(200, { 'content-type': types['.html'] })
      .end(await readFile(join(spaRoot, 'index.html')));
}).listen(spaPort);
for (const port of [ssrPort, spaPort]) {
  for (let i = 0; i < 50; i++) {
    const ok = await fetch(`http://localhost:${port}/`).then(
      (r) => r.ok,
      () => false,
    );
    if (ok) break;
    await sleep(200);
  }
}

const variants = [
  { id: 'spa', base: `http://localhost:${spaPort}` },
  { id: 'ssr', base: `http://localhost:${ssrPort}` },
];
const renderers = ['tanstack', 'astryx'];
const results = { browser: browserName, runs: [], static: [], security: [], clicks: [] };
const browser = await engine.launch();

async function openPage(base, query = '') {
  const context = await browser.newContext({ viewport: { width: 760, height: 900 } });
  const page = await context.newPage();
  const logs = [];
  const dialogs = [];
  page.on('console', (m) => ['error', 'warning'].includes(m.type()) && logs.push(m.text()));
  page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`));
  page.on('dialog', (d) => {
    dialogs.push(d.message());
    void d.dismiss();
  });
  await page.goto(`${base}/spike/markdown${query}`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__mdSpike?.ready === true);
  return { context, page, logs, dialogs };
}

const slim = (res) => Object.fromEntries(Object.entries(res).filter(([k]) => k !== 'finalHtml'));

for (const variant of variants) {
  // 1. Streaming runs.
  for (const renderer of renderers) {
    const plan =
      variant.id === 'spa'
        ? [
            { fixture: 'teacher', stabilize: false, intervalMs: 25 },
            { fixture: 'teacher', stabilize: true, intervalMs: 25 },
            { fixture: 'teacher', stabilize: false, intervalMs: 8, repeat: 5 },
          ]
        : [{ fixture: 'teacher', stabilize: false, intervalMs: 25 }];
    for (const options of plan) {
      const { context, page, logs, dialogs } = await openPage(variant.base);
      const res = await page.evaluate((o) => window.__mdSpike.run(o), { renderer, ...options });
      results.runs.push({ variant: variant.id, logs, dialogs, ...slim(res) });
      await context.close();
    }
  }
  // 1b. Lean runs (chunks only, no sampling): frame pacing in every browser and, in Chromium,
  // whole-run main-thread totals from its own metrics (these cover the work React defers to
  // later frames). A same-length idle run gives the baseline.
  if (variant.id === 'spa') {
    for (const renderer of renderers) {
      for (const { repeat, intervalMs } of [
        { repeat: 1, intervalMs: 25 },
        { repeat: 5, intervalMs: 8 },
      ]) {
        const { context, page } = await openPage(variant.base);
        let cdp;
        const read = async () =>
          Object.fromEntries(
            (await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]),
          );
        if (browserName === 'chromium') {
          cdp = await context.newCDPSession(page);
          await cdp.send('Performance.enable');
        }
        await sleep(500);
        const m0 = cdp ? await read() : null;
        const res = await page.evaluate((o) => window.__mdSpike.run(o), {
          renderer,
          fixture: 'teacher',
          stabilize: false,
          intervalMs,
          repeat,
          lean: true,
        });
        const m1 = cdp ? await read() : null;
        const d = (k) => (m1 ? +((m1[k] - m0[k]) * 1000).toFixed(1) : null);
        results.cpu = results.cpu ?? [];
        results.cpu.push({
          renderer,
          repeat,
          intervalMs,
          chunks: res.chunks,
          chars: res.chars,
          taskMs: d('TaskDuration'),
          scriptMs: d('ScriptDuration'),
          layoutMs: d('LayoutDuration'),
          styleMs: d('RecalcStyleDuration'),
          taskMsPerChunk: m1 ? +(d('TaskDuration') / res.chunks).toFixed(3) : null,
          frameP50: +res.frameMs.p50.toFixed(1),
          frameP95: +res.frameMs.p95.toFixed(1),
          frameMax: +res.frameMs.max.toFixed(1),
          framesOver33: res.framesOver33,
          syncMsPerChunk: +res.syncRenderMs.mean.toFixed(3),
          syncMsMax: +res.syncRenderMs.max.toFixed(1),
        });
        await context.close();
      }
    }
    if (browserName === 'chromium') {
      const { context, page } = await openPage(variant.base);
      const cdp = await context.newCDPSession(page);
      await cdp.send('Performance.enable');
      const read = async () =>
        Object.fromEntries(
          (await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]),
        );
      const m0 = await read();
      await sleep(10000);
      const m1 = await read();
      results.idle10s = { taskMs: +((m1.TaskDuration - m0.TaskDuration) * 1000).toFixed(1) };
      await context.close();
    }
    console.log('CPU', JSON.stringify(results.cpu), JSON.stringify(results.idle10s ?? null));
  }
  // 2. Hostile fixture, streamed, with and without hold-back; then click every link.
  if (variant.id === 'spa') {
    for (const renderer of renderers) {
      for (const stabilize of [false, true]) {
        const { context, page, logs, dialogs } = await openPage(variant.base);
        const res = await page.evaluate((o) => window.__mdSpike.run(o), {
          renderer,
          fixture: 'hostile',
          stabilize,
          intervalMs: 10,
        });
        const links = await page.$$eval('#spike-stream a', (as) =>
          as.map((a) => a.getAttribute('href')),
        );
        for (const a of await page.$$('#spike-stream a')) {
          await a.click({ force: true, timeout: 1500, noWaitAfter: true }).catch(() => {});
        }
        await sleep(300);
        const pwnedAfterClicks = await page.evaluate(() =>
          window.__pwned === undefined ? null : String(window.__pwned),
        );
        const text = await page.$eval('#spike-stream', (el) => el.textContent);
        results.security.push({
          variant: variant.id,
          renderer,
          stabilize,
          logs,
          dialogs,
          links,
          pwnedAfterClicks,
          shownAsText: {
            script: text.includes('<script>'),
            img: text.includes('<img'),
            iframe: text.includes('<iframe'),
          },
          ...slim(res),
          finalHtml: res.finalHtml.slice(0, 6000),
        });
        if (shotDir)
          await page.screenshot({
            path: join(
              shotDir,
              `${browserName}-hostile-${renderer}-${stabilize ? 'hold' : 'raw'}.png`,
            ),
            fullPage: true,
          });
        await context.close();
      }
    }
  }
  // 3. Static render of the whole fixture on first render (SSR: HTML from the server, then hydrate).
  for (const renderer of renderers) {
    const { context, page, logs } = await openPage(
      variant.base,
      `?mode=static&r=${renderer}&f=teacher`,
    );
    const facts = await page.evaluate(() => {
      const el = document.querySelector('#spike-stream');
      return {
        katex: el.querySelectorAll('.katex').length,
        tables: el.querySelectorAll('table').length,
        pre: el.querySelectorAll('pre').length,
        height: el.offsetHeight,
        textLen: el.textContent.length,
      };
    });
    results.static.push({ variant: variant.id, renderer, logs, ...facts });
    if (shotDir && variant.id === 'spa')
      await page.screenshot({
        path: join(shotDir, `${browserName}-static-${renderer}.png`),
        fullPage: true,
      });
    await context.close();
  }
  // 4. Screenshots while streaming: half-received block math and half-received table.
  if (shotDir && variant.id === 'spa') {
    const stops = {
      'half-math': String.raw`\lim_{h \to 0} \frac{f(x+h)`,
      'half-table': '| $x^2$ | $2x$ | lu',
    };
    for (const renderer of renderers) {
      for (const stabilize of [false, true]) {
        for (const [name, stopAtMarker] of Object.entries(stops)) {
          const { context, page } = await openPage(variant.base);
          await page.evaluate((o) => window.__mdSpike.run(o), {
            renderer,
            fixture: 'teacher',
            stabilize,
            intervalMs: 0,
            stopAtMarker,
          });
          await page.screenshot({
            path: join(
              shotDir,
              `${browserName}-${name}-${renderer}-${stabilize ? 'hold' : 'raw'}.png`,
            ),
            fullPage: true,
          });
          await context.close();
        }
      }
    }
  }
}

await browser.close();
spaServer.close();
if (outFile) writeFileSync(outFile, JSON.stringify(results, null, 2));
console.log(
  JSON.stringify(
    results.runs.map((r) => ({
      variant: r.variant,
      renderer: r.options.renderer,
      stab: r.options.stabilize,
      interval: r.options.intervalMs,
      repeat: r.options.repeat ?? 1,
      syncMsMean: +r.syncRenderMs.mean.toFixed(3),
      syncMsMax: +r.syncRenderMs.max.toFixed(1),
      frameP95: +r.frameMs.p95.toFixed(1),
      frameMax: +r.frameMs.max.toFixed(1),
      over33: r.framesOver33,
      frames: r.framesSampled,
      shrink: r.shrinkEvents,
      maxShrink: +r.maxShrinkPx.toFixed(0),
      jumps80: r.growthOver80Px,
      katexRemount: r.katexRemounts,
      blockRemount: r.blockRemounts,
      leaks: r.leakFrames,
      pending: r.pendingFrames,
      errFrames: r.katexErrorFrames,
      maxLag: +r.maxLagFraction.toFixed(3),
      lagAtEnd: +r.lagAtLastChunkFraction.toFixed(3),
      snap: r.snap,
      katex: r.finalKatex,
      tables: r.finalTables,
      pre: r.finalPre,
      convText: r.convergedText,
      convHtml: r.convergedHtml,
      convStruct: r.convergedStructure,
      violations: r.violations.length,
      logs: r.logs.length,
    })),
    null,
    0,
  ),
);
for (const r of results.runs.slice(0, 40))
  if (r.shrinkAt?.length || Object.keys(r.leakSamples ?? {}).length || r.structureDiff)
    console.log(
      'DIAG',
      r.variant,
      r.options.renderer,
      r.options.stabilize ? 'hold' : 'raw',
      r.options.intervalMs,
      JSON.stringify({
        shrinkAt: r.shrinkAt,
        leakSamples: r.leakSamples,
        structureDiff: r.structureDiff,
      }),
    );
console.log('STATIC', JSON.stringify(results.static));
console.log(
  'SECURITY',
  JSON.stringify(
    results.security.map((s) => ({
      renderer: s.renderer,
      stabilize: s.stabilize,
      violations: s.violations,
      pwned: s.pwned,
      pwnedAfterClicks: s.pwnedAfterClicks,
      dialogs: s.dialogs,
      links: s.links,
      shownAsText: s.shownAsText,
      logs: s.logs,
      katex: s.finalKatex,
      katexErrorFrames: s.katexErrorFrames,
    })),
    null,
    1,
  ),
);

process.exit(0);
