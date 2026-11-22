// PDF text extraction on the server (plan nguon-hoc.md A4, spike C1). pdfjs runs in a
// `worker_threads` worker, not for latency but for memory: `resourceLimits` does not bound
// ArrayBuffers (a Flate bomb grows the RSS by gigabytes), so the main thread polls the process RSS
// and terminates the worker past baseline + cap. One extraction at a time per process (the RSS is
// shared): the `ingest` job kind has `global: 1`.
//
// The worker gets no workspace code: it runs the source text of core's `readPdfPages` and imports
// pdfjs by an absolute URL resolved here (works from `node_modules` and from the Nitro output,
// where pdfjs-dist is traced next to the server).
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { Effect } from 'effect';
import { readPdfPagesSource, type PdfAssets, type PdfReadResult } from '@kd-learn/core';

export type PdfExtractResult =
  PdfReadResult | { readonly ok: false; readonly code: 'Timeout' | 'TooMuchMemory' | 'Crashed' };

export interface PdfExtractOptions {
  readonly maxPages: number;
  /** Default 60 s. */
  readonly timeoutMs?: number;
  /** RSS growth over the baseline before the worker is stopped. Default 512 MiB. */
  readonly memoryBytes?: number;
}

export type PdfExtractor = (
  data: Uint8Array,
  options: PdfExtractOptions,
) => Effect.Effect<PdfExtractResult>;

interface PdfjsPaths {
  readonly pdf: string;
  readonly worker: string;
  readonly assets: PdfAssets;
}
let paths: PdfjsPaths | undefined;
const pdfjsPaths = (): PdfjsPaths => {
  if (paths === undefined) {
    const require = createRequire(import.meta.url);
    const root = dirname(require.resolve('pdfjs-dist/package.json'));
    paths = {
      pdf: pathToFileURL(join(root, 'legacy/build/pdf.mjs')).href,
      worker: pathToFileURL(join(root, 'legacy/build/pdf.worker.mjs')).href,
      // pdfjs reads these with `fs` in Node: plain paths, not file URLs.
      assets: {
        cMapUrl: `${join(root, 'cmaps')}/`,
        standardFontDataUrl: `${join(root, 'standard_fonts')}/`,
      },
    };
  }
  return paths;
};

// pdfjs warns on stdout at import that the optional `@napi-rs/canvas` is missing (it is only for
// rendering): silence the console while importing.
const workerCode = ({ pdf, worker, assets }: PdfjsPaths) => `
const { parentPort, workerData } = require('node:worker_threads');
const readPdfPages = (${readPdfPagesSource()});
(async () => {
  const log = console.log;
  console.log = () => {};
  globalThis.pdfjsWorker = await import(${JSON.stringify(worker)});
  const pdfjs = await import(${JSON.stringify(pdf)});
  console.log = log;
  const result = await readPdfPages(
    pdfjs.getDocument,
    workerData.data,
    workerData.maxPages,
    ${JSON.stringify(assets)},
  );
  parentPort.postMessage(result);
})().catch(() => parentPort.postMessage({ ok: false, code: 'Crashed' }));
`;

/** Extracts the page items of a PDF in a worker. Interrupting the effect terminates the worker. */
export const extractPdf: PdfExtractor = (data, options) =>
  Effect.callback<PdfExtractResult>((resume) => {
    const copy = new Uint8Array(data);
    const worker = new Worker(workerCode(pdfjsPaths()), {
      eval: true,
      workerData: { data: copy, maxPages: options.maxPages },
      transferList: [copy.buffer as ArrayBuffer],
    });
    let done = false;
    const finish = (result: PdfExtractResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearInterval(watch);
      void worker.terminate();
      resume(Effect.succeed(result));
    };
    const baseline = process.memoryUsage.rss();
    const cap = options.memoryBytes ?? 512 * 1024 * 1024;
    const watch = setInterval(() => {
      if (process.memoryUsage.rss() - baseline > cap) finish({ ok: false, code: 'TooMuchMemory' });
    }, 20);
    const timer = setTimeout(
      () => finish({ ok: false, code: 'Timeout' }),
      options.timeoutMs ?? 60_000,
    );
    worker.on('message', (message: PdfReadResult) => finish(message));
    worker.on('error', () => finish({ ok: false, code: 'Crashed' }));
    worker.on('exit', () => finish({ ok: false, code: 'Crashed' }));
    return Effect.sync(() => {
      done = true;
      clearTimeout(timer);
      clearInterval(watch);
      void worker.terminate();
    });
  });
