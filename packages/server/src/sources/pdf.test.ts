import { readFileSync } from 'node:fs';
import { Effect, Exit, Fiber } from 'effect';
import { describe, expect, it } from 'vitest';
import {
  chunkPages,
  pdfHasText,
  pdfPagesText,
  pdfSourceChunks,
  readPdfPages,
  type PdfGetDocument,
} from '@kd-learn/core';
import { extractPdf } from './pdf.ts';

const fixture = (name: string) =>
  new Uint8Array(readFileSync(new URL(`../../test/fixtures/pdf/${name}`, import.meta.url)));

/** A PDF whose pages have these content streams (no font: no text layer). */
export const minimalPdf = (contents: ReadonlyArray<string>): Uint8Array => {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${contents.map((_, i) => `${3 + 2 * i} 0 R`).join(' ')}] /Count ${contents.length} >>`,
  ];
  contents.forEach((content, i) => {
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${4 + 2 * i} 0 R >>`,
    );
    objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  });
  let out = '%PDF-1.7\n';
  const offsets: number[] = [];
  objects.forEach((object, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
};

const run = (data: Uint8Array, maxPages = 500) =>
  Effect.runPromise(extractPdf(data, { maxPages, timeoutMs: 20_000 }));

describe('extractPdf (worker_threads)', () => {
  it('gives the same chunks as readPdfPages called directly (the browser path)', async () => {
    // The worker module has no types: import it through a variable.
    const workerModule = 'pdfjs-dist/legacy/build/pdf.worker.mjs';
    (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = await import(workerModule);
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const direct = await readPdfPages(
      pdfjs.getDocument as unknown as PdfGetDocument,
      fixture('vi-5pages.pdf'),
      500,
    );
    const inWorker = await run(fixture('vi-5pages.pdf'));
    const chunks = pdfSourceChunks(inWorker);
    expect(chunks.ok).toBe(true);
    expect(chunks).toEqual(pdfSourceChunks(direct));
  });

  it('reads Vietnamese text with page numbers and drops running heads', async () => {
    const result = await run(fixture('vi-5pages.pdf'));
    if (!result.ok) throw new Error(result.code);
    expect(result.pages).toHaveLength(5);
    const pages = pdfPagesText(result.pages);
    expect(pdfHasText(pages)).toBe(true);
    expect(pages[0]!.text).toContain('Tìm kiếm nhị phân áp dụng cho mảng đã được sắp xếp.');
    expect(pages.map((p) => p.text).join('\n')).not.toContain('Giáo trình Thuật toán');
    expect(pages[2]!.text).not.toMatch(/Trang 3/);
    const chunks = chunkPages(pages);
    expect(chunks[0]!.locator).toEqual({ page: 1 });
    expect(chunks.at(-1)!.locator.page).toBe(5);
  });

  it('gives NFC for decomposed text', async () => {
    const result = await run(fixture('nfd.pdf'));
    if (!result.ok) throw new Error(result.code);
    const text = pdfPagesText(result.pages)
      .map((p) => p.text)
      .join('');
    expect(text).toBe(text.normalize('NFC'));
    expect(text.length).toBeGreaterThan(10);
  });

  it('reports a scan, an encrypted file, a broken file, too many pages', async () => {
    const scan = await run(minimalPdf(['0 0 m 100 100 l S', 'q Q', '']));
    expect(scan.ok && pdfHasText(pdfPagesText(scan.pages))).toBe(false);
    expect(await run(fixture('encrypted.pdf'))).toEqual({ ok: false, code: 'Encrypted' });
    expect(await run(new TextEncoder().encode('not a pdf'))).toEqual({
      ok: false,
      code: 'Invalid',
    });
    expect(await run(minimalPdf(['', '', '']), 2)).toEqual({ ok: false, code: 'TooLarge' });
  });

  it('stops a decompression bomb on memory', async () => {
    const result = await Effect.runPromise(
      extractPdf(fixture('bomb-400m.pdf'), { maxPages: 500, memoryBytes: 128 * 1024 * 1024 }),
    );
    expect(result).toEqual({ ok: false, code: 'TooMuchMemory' });
  });

  it('stops on time, and when interrupted', async () => {
    expect(
      await Effect.runPromise(
        extractPdf(fixture('vi-5pages.pdf'), { maxPages: 500, timeoutMs: 1 }),
      ),
    ).toEqual({ ok: false, code: 'Timeout' });
    const fiber = Effect.runFork(extractPdf(fixture('vi-5pages.pdf'), { maxPages: 500 }));
    await Effect.runPromise(Effect.sleep(5));
    const exit = await Effect.runPromise(
      Fiber.await(fiber).pipe(
        Effect.andThen(() => Effect.void),
        Effect.timeout(1),
        Effect.exit,
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(Exit.hasInterrupts(await Effect.runPromise(Fiber.await(fiber)))).toBe(true);
  });
});
