// SPIKE (phase 1 step 1): Playwright driver for the SQLite WASM spike (plan loi-day-hoc C1).
// Prereq: `pnpm build` and `pnpm build:spa` (the SPA build overwrites nothing of .output),
// `pnpm exec playwright install chromium firefox webkit`.
// Usage: node scripts/spike-sqlite.mjs [chromium|firefox|webkit] [out.json]
/* global document, window */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { chromium, firefox, webkit } from 'playwright';

const here = fileURLToPath(new URL('.', import.meta.url));
const appDir = join(here, '..');
const browserName = process.argv[2] ?? 'chromium';
const outFile = process.argv[3];
const engine = { chromium, firefox, webkit }[browserName];

const procs = [];
const start = (cmd, args, env = {}) => {
  const p = spawn(cmd, args, { cwd: appDir, env: { ...process.env, ...env }, stdio: 'ignore' });
  procs.push(p);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ssr: Nitro on 3100, proxies 4101 (plain) / 4102 (COOP+COEP). spa: static 4201 / 4202.
start('node', ['.output/server/index.mjs'], { PORT: '3100' });
start('node', ['scripts/spike-serve.mjs', 'ssr', '4101', 'http://127.0.0.1:3100']);
start('node', ['scripts/spike-serve.mjs', 'ssr', '4102', 'http://127.0.0.1:3100', '--isolate']);
start('node', ['scripts/spike-serve.mjs', 'spa', '4201']);
start('node', ['scripts/spike-serve.mjs', 'spa', '4202', '--isolate']);
start('pnpm', ['exec', 'vite', 'dev', '--port', '3200', '--strictPort']);
await sleep(6000);
process.on('exit', () => procs.forEach((p) => p.kill()));

const variants = [
  { id: 'ssr', isolate: false, base: 'http://localhost:4101' },
  { id: 'ssr+coep', isolate: true, base: 'http://localhost:4102' },
  { id: 'spa', isolate: false, base: 'http://localhost:4201' },
  { id: 'spa+coep', isolate: true, base: 'http://localhost:4202' },
  { id: 'dev', isolate: false, base: 'http://localhost:3200' },
];
const drivers = ['tanstack-wa', 'own-wa', 'official-sahpool', 'official-opfs'];

const results = { browser: browserName, runs: [], twoTabs: [], atomic: [], iframe: [], tsdb: [] };
const browser = await engine.launch();
// WebKit's ephemeral contexts have no OPFS (getDirectory() throws UnknownError, like a
// private window), so WebKit runs use a persistent context in a temp profile instead.
let profileCount = 0;
const newContext = async () => {
  if (browserName !== 'webkit') return browser.newContext();
  const dir = mkdtempSync(join(tmpdir(), `kd-spike-${profileCount++}-`));
  return engine.launchPersistentContext(dir);
};

async function openPage(ctx, base) {
  const page = await ctx.newPage();
  const logs = [];
  page.on('console', (m) => ['error', 'warning'].includes(m.type()) && logs.push(m.text()));
  page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`));
  const t0 = Date.now();
  const resp = await page.goto(`${base}/spike/sqlite`);
  const html = await resp.text();
  await page.waitForFunction(() => document.querySelector('#spike-state')?.textContent === 'ready');
  return { page, logs, ssrHtml: html, readyMs: Date.now() - t0 };
}
const call = (page, fn, ...args) => page.evaluate(([f, a]) => window.__spike[f](...a), [fn, args]);

// 1. Basic matrix: every variant x driver, cold open, init, 1000 appends, reload, warm open.
for (const v of variants) {
  for (const driver of drivers) {
    if (v.id === 'dev' && driver === 'official-opfs') continue;
    const ctx = await newContext();
    const { page, logs, ssrHtml, readyMs } = await openPage(ctx, v.base);
    const run = { variant: v.id, driver, readyMs };
    run.ssrRendered = ssrHtml.includes('SQLite WASM spike');
    run.env = await call(page, 'env');
    const db = `m-${v.id}-${driver}.db`.replace(/\+/g, '_');
    const opened = await call(page, 'open', driver, db);
    run.cold = opened;
    if (!opened.error) {
      run.init = await call(page, 'init', opened.handle);
      run.append1000 = await call(page, 'append', opened.handle, 1000, 'A');
      run.appendOne = await call(page, 'appendOne', opened.handle, 'A');
      run.count = await call(page, 'count', opened.handle);
      await call(page, 'close', opened.handle);
      // Reload the page: data must survive; time the warm open.
      await page.reload();
      await page.waitForFunction(
        () => document.querySelector('#spike-state')?.textContent === 'ready',
      );
      const warm = await call(page, 'open', driver, db);
      run.warm = warm;
      if (!warm.error) {
        run.countAfterReload = await call(page, 'count', warm.handle);
        await call(page, 'close', warm.handle);
      }
    }
    run.consoleProblems = logs.slice(0, 5);
    results.runs.push(run);
    console.error(`basic ${v.id} ${driver}`, run.cold?.error ?? `${Math.round(run.cold.openMs)}ms`);
    await ctx.close();
  }
}

// 2. Atomicity: kill the page mid-transaction, reopen, expect only committed rows.
for (const driver of drivers) {
  const v = variants[2]; // spa, plain; official-opfs is retried under COEP below
  const base = driver === 'official-opfs' ? variants[3].base : v.base;
  const ctx = await newContext();
  const a = await openPage(ctx, base);
  const db = `atomic-${driver}.db`;
  const o = await call(a.page, 'open', driver, db);
  const row = { driver, open: o.error ?? 'ok' };
  if (!o.error) {
    await call(a.page, 'init', o.handle);
    await call(a.page, 'append', o.handle, 10, 'committed');
    row.beforeKill = await call(a.page, 'count', o.handle);
    await call(a.page, 'beginUncommitted', o.handle, 'ghost');
    await a.page.close({ runBeforeUnload: false });
    await sleep(500);
    const b = await openPage(ctx, base);
    const o2 = await call(b.page, 'open', driver, db);
    row.reopen = o2.error ?? 'ok';
    if (!o2.error) row.afterKill = await call(b.page, 'count', o2.handle);
    if (!o2.error) row.ghostRows = await call(b.page, 'count', o2.handle, 'ghost');
  }
  results.atomic.push(row);
  console.error('atomic', JSON.stringify(row));
  await ctx.close();
}

// 3. Two tabs in one browser context (shared OPFS). A holds the DB open, B opens it too.
for (const driver of drivers) {
  const base = driver === 'official-opfs' ? variants[3].base : variants[2].base;
  const ctx = await newContext();
  const a = await openPage(ctx, base);
  const b = await openPage(ctx, base);
  const db = `tabs-${driver}.db`;
  const row = { driver };
  const oa = await call(a.page, 'open', driver, db);
  row.a = oa.error ?? 'ok';
  if (!oa.error) await call(a.page, 'init', oa.handle);
  const t0 = Date.now();
  const ob = await call(b.page, 'open', driver, db);
  row.b = ob.error ?? 'ok';
  row.bOpenMs = Date.now() - t0;
  if (!oa.error && !ob.error) {
    await call(b.page, 'init', ob.handle);
    // Concurrent writers: both append 200 rows at the same time.
    const [wa, wb] = await Promise.all([
      call(a.page, 'append', oa.handle, 200, 'A'),
      call(b.page, 'append', ob.handle, 200, 'B'),
    ]);
    row.writeA = wa.error ?? 'ok';
    row.writeB = wb.error ?? 'ok';
    row.countA = await call(a.page, 'count', oa.handle);
    row.countB = await call(b.page, 'count', ob.handle);
  }
  if (!oa.error && !ob.error) {
    // A holds a write transaction open; B tries to write meanwhile.
    await call(a.page, 'beginUncommitted', oa.handle, 'A-hold');
    const t1 = Date.now();
    let settled;
    const bWrite = call(b.page, 'append', ob.handle, 5, 'B-blocked').then((r) => {
      settled = r.error ? `error: ${r.error}` : `ok after ${Date.now() - t1}ms`;
    });
    await sleep(4000);
    row.bWriteWhileAHoldsTxn = settled ?? 'still blocked after 4s (no error)';
    await call(a.page, 'exec', oa.handle, 'ROLLBACK');
    await Promise.race([bWrite, sleep(6000)]);
    row.bAfterARollback = settled ?? 'never completed';
  }
  if (!oa.error) await call(a.page, 'close', oa.handle);
  if (oa.error === undefined && ob.error) {
    // After A releases, can B open?
    const retry = await call(b.page, 'open', driver, db);
    row.bAfterAClosed = retry.error ?? 'ok';
  }
  results.twoTabs.push(row);
  console.error('tabs', JSON.stringify(row));
  await ctx.close();
}

// 4. Sandboxed iframe under COOP+COEP (phase 5 question).
{
  const ctx = await newContext();
  const { page } = await openPage(ctx, variants[3].base);
  const base = variants[3].base;
  const probe = (html, attrs, src) =>
    page.evaluate(
      ([h, s, a]) =>
        new Promise((resolve) => {
          const f = document.createElement('iframe');
          f.setAttribute('sandbox', a);
          let done = false;
          const finish = (v) => {
            if (!done) {
              done = true;
              resolve(v);
            }
          };
          window.addEventListener('message', (e) => e.data === 'frame-ran' && finish('ran'));
          f.onload = () => setTimeout(() => finish('loaded-but-script-silent'), 800);
          setTimeout(() => finish('timeout'), 2500);
          if (s) f.src = s;
          else f.srcdoc = h;
          document.body.append(f);
        }),
      [html, src, attrs],
    );
  const doc = '<script>parent.postMessage("frame-ran","*")</script>';
  results.iframe.push({
    case: 'srcdoc, sandbox=allow-scripts',
    result: await probe(doc, 'allow-scripts', null),
  });
  results.iframe.push({
    case: 'src same-origin, no COEP header on frame, sandbox=allow-scripts',
    result: await probe('', 'allow-scripts', `${base}/__frame/plain`),
  });
  results.iframe.push({
    case: 'src same-origin, COEP on frame, sandbox=allow-scripts',
    result: await probe('', 'allow-scripts', `${base}/__frame/coep`),
  });
  results.iframe.push({
    case: 'src cross-origin (other port), COEP on frame, sandbox=allow-scripts',
    result: await probe('', 'allow-scripts', `http://127.0.0.1:4202/__frame/coep`),
  });
  // Subresource from another origin inside a srcdoc iframe (what generated HTML would do).
  for (const v of [variants[2], variants[3]]) {
    const c2 = await newContext();
    const { page: p2 } = await openPage(c2, v.base);
    const img = await p2.evaluate(
      () =>
        new Promise((resolve) => {
          const f = document.createElement('iframe');
          f.setAttribute('sandbox', 'allow-scripts');
          f.srcdoc =
            "<img id=i src=\"http://127.0.0.1:4201/__img.gif\" onload=\"parent.postMessage('img-ok','*')\" onerror=\"parent.postMessage('img-blocked','*')\">";
          window.addEventListener(
            'message',
            (e) => String(e.data).startsWith('img-') && resolve(e.data),
          );
          setTimeout(() => resolve('timeout'), 3000);
          document.body.append(f);
        }),
    );
    results.iframe.push({
      case: `srcdoc iframe loads cross-origin <img> (parent ${v.id})`,
      result: img,
    });
    await c2.close();
  }
  await ctx.close();
}

// 5. TanStack DB: persisted collection (own adapter), multi-tab coordinator, collection over our driver.
{
  const ctx = await newContext();
  const a = await openPage(ctx, variants[2].base);
  const tsdb = (page, fn, ...args) =>
    page.evaluate(([f, x]) => window.__spikeTanstackDb[f](...x), [fn, args]);
  const row = {};
  const pa = await tsdb(a.page, 'persisted', 'tsdb-single.db', false);
  row.persistedOpen = pa.error ?? `ready ${Math.round(pa.readyMs)}ms`;
  if (!pa.error) {
    row.insert = await tsdb(a.page, 'insert', pa.handle, 'e1');
    await tsdb(a.page, 'insert', pa.handle, 'e2');
    row.sizeBeforeReload = await tsdb(a.page, 'size', pa.handle);
    row.sqliteMaster = await tsdb(a.page, 'dump', pa.handle);
    await tsdb(a.page, 'close', pa.handle);
    await a.page.reload();
    await a.page.waitForFunction(
      () => document.querySelector('#spike-state')?.textContent === 'ready',
    );
    const again = await tsdb(a.page, 'persisted', 'tsdb-single.db', false);
    row.afterReloadSize = again.error ?? again.initialSize;
    if (!again.error) await tsdb(a.page, 'close', again.handle);
  }
  results.tsdb.push({ case: 'persisted, single tab', ...row });
  await ctx.close();
}
{
  // Multi-tab with the coordinator: B inserts, A should see it in collection + live query.
  const ctx = await newContext();
  const a = await openPage(ctx, variants[2].base);
  const b = await openPage(ctx, variants[2].base);
  const tsdb = (page, fn, ...args) =>
    page.evaluate(([f, x]) => window.__spikeTanstackDb[f](...x), [fn, args]);
  const row = {};
  const pa = await tsdb(a.page, 'persisted', 'tsdb-multi.db', true);
  const pb = await tsdb(b.page, 'persisted', 'tsdb-multi.db', true);
  row.openA = pa.error ?? 'ok';
  row.openB = pb.error ?? 'ok';
  if (!pa.error && !pb.error) {
    row.insertFromB = await tsdb(b.page, 'insert', pb.handle, 'from-b');
    row.insertFromA = await tsdb(a.page, 'insert', pa.handle, 'from-a');
    await sleep(800);
    row.sizeA = await tsdb(a.page, 'size', pa.handle);
    row.sizeB = await tsdb(b.page, 'size', pb.handle);
  }
  results.tsdb.push({ case: 'persisted, two tabs + BrowserCollectionCoordinator', ...row });
  await ctx.close();
}
for (const driver of ['official-sahpool', 'tanstack-wa']) {
  const ctx = await newContext();
  const a = await openPage(ctx, variants[2].base);
  const tsdb = (page, fn, ...args) =>
    page.evaluate(([f, x]) => window.__spikeTanstackDb[f](...x), [fn, args]);
  const row = {};
  const s = await tsdb(a.page, 'overDriver', driver, `tsdb-over-${driver}.db`);
  row.open = s.error ?? `ready ${Math.round(s.readyMs)}ms`;
  if (!s.error) {
    row.insert = await tsdb(a.page, 'insert', s.handle, 'x1');
    row.size = await tsdb(a.page, 'size', s.handle);
    row.sql = await tsdb(a.page, 'dump', s.handle);
  }
  results.tsdb.push({ case: `collection over our driver (${driver})`, ...row });
  await ctx.close();
}

await browser.close();
const json = JSON.stringify(results, null, 2);
if (outFile) writeFileSync(outFile, json);
else console.log(json);
procs.forEach((p) => p.kill());
process.exit(0);
