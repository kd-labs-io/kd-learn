// Reading the text layer of a PDF with pdfjs (plan nguon-hoc.md A4, spike C1). One function for
// both modes: the browser Worker (guest, demo) imports it, the server's `worker_threads` worker
// runs its source text (`readPdfPagesSource`), so both give the same items and so the same chunks.
//
// SELF-CONTAINED: the body uses nothing outside itself (no import, no helper, no named inner
// function), because the server ships it as source text into a worker that has no workspace code.

/** What `readPdfPages` needs of pdfjs: `getDocument`. */
export type PdfGetDocument = (options: {
  data: Uint8Array;
  cMapUrl?: string;
  cMapPacked?: boolean;
  standardFontDataUrl?: string;
  isEvalSupported: boolean;
  disableFontFace: boolean;
  verbosity: number;
}) => {
  promise: Promise<{
    numPages: number;
    getPage: (n: number) => Promise<{
      getTextContent: () => Promise<{ items: ReadonlyArray<unknown> }>;
      cleanup: () => void;
    }>;
  }>;
  onPassword: unknown;
  destroy: () => Promise<void>;
};

/** Raw items of one page: `y` is the baseline (from the transform), `height` the font size. */
export type PdfPageItems = {
  page: number;
  items: Array<{ str: string; hasEOL: boolean; y: number; height: number }>;
};

export type PdfReadResult =
  { ok: true; pages: PdfPageItems[] } | { ok: false; code: 'Encrypted' | 'Invalid' | 'TooLarge' };

/** Where pdfjs finds its CMaps (CJK fonts) and standard font data: folder URLs ending in `/`. */
export type PdfAssets = { cMapUrl: string; standardFontDataUrl: string };

export async function readPdfPages(
  getDocument: PdfGetDocument,
  data: Uint8Array,
  maxPages: number,
  assets?: PdfAssets,
): Promise<PdfReadResult> {
  const task = getDocument({
    data,
    ...(assets === undefined ? {} : { ...assets, cMapPacked: true }),
    isEvalSupported: false,
    disableFontFace: true,
    verbosity: 0,
  });
  let encrypted = false;
  // Without a handler, a PDF with an open password never settles (spike C1).
  task.onPassword = () => {
    encrypted = true;
    void task.destroy();
  };
  let doc;
  try {
    doc = await task.promise;
  } catch {
    await task.destroy().catch(() => undefined);
    return { ok: false, code: encrypted ? 'Encrypted' : 'Invalid' };
  }
  try {
    if (doc.numPages > maxPages) return { ok: false, code: 'TooLarge' };
    const pages: PdfPageItems[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      const items: PdfPageItems['items'] = [];
      for (const raw of content.items) {
        const item = raw as {
          str?: unknown;
          hasEOL?: unknown;
          transform?: unknown;
          height?: unknown;
        };
        if (typeof item.str !== 'string') continue;
        const transform = Array.isArray(item.transform) ? (item.transform as number[]) : [];
        items.push({
          str: item.str,
          hasEOL: item.hasEOL === true,
          y: typeof transform[5] === 'number' ? transform[5] : 0,
          height: typeof item.height === 'number' ? item.height : 0,
        });
      }
      pages.push({ page: n, items });
      page.cleanup();
    }
    return { ok: true, pages };
  } catch {
    return { ok: false, code: 'Invalid' };
  } finally {
    await task.destroy().catch(() => undefined);
  }
}

/** The source text of `readPdfPages`, for a worker without workspace code. */
export const readPdfPagesSource = (): string => readPdfPages.toString();
