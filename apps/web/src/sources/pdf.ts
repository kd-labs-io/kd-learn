// PDF text in the browser (plan nguon-hoc.md A4, spike C1): guests and demo users. pdfjs parses in
// its own Worker (built from `pdf.worker.min.mjs`), so the page stays responsive; the file never
// leaves the device. Loaded lazily: the module is imported only when a PDF is added, never by the
// server build. Same `readPdfPages` and `pdfSourceChunks` as the server, so both give the same chunks.
import { MAX_PDF_PAGES } from '@kd-learn/api';
import { pdfSourceChunks, readPdfPages, type PdfGetDocument } from '@kd-learn/core';

export type PdfChunks = ReturnType<typeof pdfSourceChunks>;

/** Reading longer than this fails with `Timeout`, as on the server. */
const TIMEOUT_MS = 60_000;

let pdfjs: Promise<{ getDocument: PdfGetDocument }> | undefined;
const loadPdfjs = () => {
  pdfjs ??= import('pdfjs-dist').then((module) => {
    // Our own Worker port: importing pdfjs's worker script into another Worker hangs (spike C1).
    module.GlobalWorkerOptions.workerPort ??= new Worker(
      new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url),
      { type: 'module' },
    );
    return { getDocument: module.getDocument as unknown as PdfGetDocument };
  });
  return pdfjs;
};

/** The chunks of a PDF, or why it fails. */
export const extractPdfInBrowser = async (data: Uint8Array): Promise<PdfChunks> => {
  const { getDocument } = await loadPdfjs();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<PdfChunks>((resolve) => {
    timer = setTimeout(() => resolve(pdfSourceChunks({ ok: false, code: 'Timeout' })), TIMEOUT_MS);
  });
  try {
    return await Promise.race([
      readPdfPages(getDocument, data, MAX_PDF_PAGES).then(pdfSourceChunks),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
};
