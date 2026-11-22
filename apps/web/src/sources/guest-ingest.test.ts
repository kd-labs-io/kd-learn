// Guest sources against the memory storage, with pdfjs and the Web Locks replaced.
import { describe, expect, it } from 'vitest';
import type { SourceChunk } from '@kd-learn/core';
import { makeMemoryStorage } from '@kd-learn/storage/memory';
import type { WithLock } from '../learn/locks';
import { makeGuestSources, ingestLockName } from './guest-ingest';
import { noteChunks } from './notes';
import type { PdfChunks } from './pdf';

const chunk: SourceChunk = { ordinal: 0, text: 'Tìm kiếm nhị phân.', locator: { page: 1 } };

const setup = (extract: (data: Uint8Array) => Promise<PdfChunks>) => {
  const storage = makeMemoryStorage();
  const held = new Set<string>();
  const lock: WithLock = async (name, run) => {
    if (held.has(name)) return { acquired: false };
    held.add(name);
    try {
      return { acquired: true, value: await run() };
    } finally {
      held.delete(name);
    }
  };
  let id = 0;
  const sources = makeGuestSources({
    storage: () => Promise.resolve(storage),
    extract,
    lock,
    isHeld: async (name) => held.has(name),
    newId: () => `src-${++id}`,
    now: () => 1000,
  });
  return { sources, storage, held };
};

const pdfFile = (name = 'Bài giảng.pdf') => new File([new Uint8Array([37, 80, 68, 70, 45])], name);

describe('guest sources', () => {
  it('reads a PDF on the device: pending, then ready', async () => {
    const { sources } = setup(async () => ({ ok: true, chunks: [chunk] }));
    const added = await sources.addPdf(pdfFile());
    expect(added).toMatchObject({
      _tag: 'Added',
      source: { kind: 'pdf', title: 'Bài giảng', state: 'ready', chunkCount: 1 },
    });
  });

  it('a scan fails with its code; a PDF over 20 MiB is refused before reading', async () => {
    const { sources } = setup(async () => ({
      ok: false,
      failure: { code: 'NoText', message: 'No text layer.' },
    }));
    const added = await sources.addPdf(pdfFile());
    expect(added._tag === 'Added' && added.source).toMatchObject({
      state: 'failed',
      failure: { code: 'NoText' },
    });
    const big = { name: 'big.pdf', size: 21 * 1024 * 1024 } as File;
    expect(await sources.addPdf(big)).toMatchObject({ _tag: 'Refused' });
  });

  it('a pending PDF whose tab is gone shows interrupted, and retry reads the kept file', async () => {
    let calls = 0;
    let release: () => void = () => undefined;
    const { sources, held } = setup(async (data) => {
      calls += 1;
      expect(data[0]).toBe(37);
      if (calls === 1) await new Promise<void>((resolve) => (release = resolve));
      return { ok: true, chunks: [chunk] };
    });
    const first = sources.addPdf(pdfFile());
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect((await sources.list())[0]).toMatchObject({ state: 'pending', interrupted: false });
    // The tab closes: its lock goes with it, the source stays pending.
    held.clear();
    expect((await sources.list())[0]).toMatchObject({ state: 'pending', interrupted: true });
    expect(await sources.retry('src-1')).toBe('started');
    expect((await sources.list())[0]).toMatchObject({ state: 'ready', interrupted: false });
    release();
    await first;
    expect(calls).toBe(2);
  });

  it('adds one source per note file and refuses the others', async () => {
    const { sources } = setup(async () => ({ ok: true, chunks: [] }));
    const results = await sources.addNotes(
      [new File(['# Mở đầu\n\nMột đoạn.'], 'ghi-chu.md'), new File([''], 'empty.txt')],
      async (file) => noteChunks(file.name, await file.text()),
    );
    expect(results[0]).toMatchObject({
      _tag: 'Added',
      source: { kind: 'note', title: 'ghi-chu', state: 'ready', chunkCount: 1 },
    });
    expect(results[1]).toMatchObject({ _tag: 'Refused', origin: 'empty.txt' });
    expect(ingestLockName('x')).toBe('kd-learn:ingest:x');
  });
});

describe('noteChunks', () => {
  it('drops front matter, keeps headings as locators', () => {
    const read = noteChunks('a.md', '---\ntags: x\n---\n# Phần 1\n\nNội dung [[liên kết]].');
    expect(read).toMatchObject({
      ok: true,
      title: 'a',
      chunks: [{ text: 'Nội dung liên kết.', locator: { heading: 'Phần 1' } }],
    });
  });
});
