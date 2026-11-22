// Learning sources (plan nguon-hoc.md A2, A3): a document of the learner (PDF, note, web research)
// cut into chunks. Sources are not events: they are large and can be deleted, so drivers keep them
// in their own tables. A session refers to them through `SourceAttached`; a turn gets a slice of
// their chunks, picked lexically like the graph slice (luyen-tap-graph.md A4). Pure.
import { Schema } from 'effect';
import {
  ChunkLocator,
  SourceId,
  SourceTitle,
  maxChunkChars,
  defaultChunkChars,
  type SourceChunk,
  type SourceChunkRef,
  type SourceFailure,
} from './source-schema.ts';
import { lexicalSimilarity, tokenize, utf8Length } from './slice.ts';
import { currentStep, type Session } from './session.ts';
import type { EventLog } from './event.ts';

/** Most text one source may hold (UTF-8 of its chunks). */
export const maxSourceTextBytes = 4 * 1024 * 1024;

// ---------------------------------------------------------------------------------------------
// Chunking

export const byteLength = utf8Length;

interface Block {
  readonly text: string;
  readonly locator: ChunkLocator;
}

/** Splits a block longer than `max` at sentence ends, then hard. */
const splitLong = (text: string, max: number): string[] => {
  if (text.length <= max) return [text];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    const cut = Math.max(
      window.lastIndexOf('. '),
      window.lastIndexOf('\n'),
      window.lastIndexOf(' '),
    );
    const at = cut > max / 2 ? cut + 1 : max;
    parts.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest.length > 0) parts.push(rest);
  return parts.filter((part) => part.length > 0);
};

const sameLocator = (a: ChunkLocator, b: ChunkLocator) =>
  a.page === b.page && a.heading === b.heading && a.url === b.url;

/**
 * Packs blocks into chunks of at most `chars` characters. A chunk never mixes two locators (a page,
 * a heading), so a citation points at one place.
 */
const pack = (blocks: ReadonlyArray<Block>, chars: number): SourceChunk[] => {
  const max = Math.min(Math.max(chars, 200), maxChunkChars);
  const chunks: SourceChunk[] = [];
  let text = '';
  let locator: ChunkLocator | undefined;
  const flush = () => {
    if (locator !== undefined && text.trim().length > 0) {
      chunks.push({ ordinal: chunks.length, text: text.trim(), locator });
    }
    text = '';
  };
  for (const block of blocks) {
    for (const part of splitLong(block.text, max)) {
      if (locator === undefined || !sameLocator(locator, block.locator)) {
        flush();
        locator = block.locator;
      }
      if (text.length > 0 && text.length + 2 + part.length > max) flush();
      text = text.length === 0 ? part : `${text}\n\n${part}`;
    }
  }
  flush();
  return chunks;
};

const paragraphs = (text: string) =>
  text
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n/)
    .map((p) => p.replace(/[ \t]+/g, ' ').trim())
    .filter((p) => p.length > 0);

/** Chunks of a PDF: the text of each page (1-based), chunks never cross a page. */
export const chunkPages = (
  pages: ReadonlyArray<{ readonly page: number; readonly text: string }>,
  chars = defaultChunkChars,
): SourceChunk[] =>
  pack(
    pages.flatMap(({ page, text }) =>
      paragraphs(text).map((p) => ({ text: p, locator: { page } })),
    ),
    chars,
  );

/**
 * Note text to plain text (A4): front matter dropped, images and HTML dropped (risk 21), wiki links
 * and Markdown links kept as their text only (no URL reaches a prompt or the page).
 */
export const cleanNote = (markdown: string): string =>
  markdown
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(/^---\n[\s\S]*?\n---\n/, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/!\[\[[^\]]*\]\]/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, '$2')
    .replace(/\[\[([^\]]*)\]\]/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<\/?[A-Za-z][^>]*>/g, '');

/** Chunks of a note (Markdown or plain text): the heading above each part is its locator. */
export const chunkNote = (markdown: string, chars = defaultChunkChars): SourceChunk[] => {
  const blocks: Block[] = [];
  let heading: string | undefined;
  for (const block of paragraphs(cleanNote(markdown))) {
    const lines = block.split('\n');
    const rest: string[] = [];
    for (const line of lines) {
      const match = /^#{1,6}\s+(.+)$/.exec(line);
      if (match !== null) {
        if (rest.length > 0) {
          blocks.push({ text: rest.join('\n'), locator: heading === undefined ? {} : { heading } });
          rest.length = 0;
        }
        heading = match[1]!.trim().slice(0, 300);
      } else rest.push(line);
    }
    if (rest.length > 0) {
      blocks.push({ text: rest.join('\n'), locator: heading === undefined ? {} : { heading } });
    }
  }
  return pack(blocks, chars);
};

/** Chunks of a web research: the summary first, then one part per result (its URL as locator). */
export const chunkWeb = (
  summary: string,
  results: ReadonlyArray<{ readonly title: string; readonly url: string; readonly text: string }>,
  chars = defaultChunkChars,
): SourceChunk[] =>
  pack(
    [
      ...paragraphs(summary).map((p) => ({ text: p, locator: {} })),
      ...results.flatMap((result) =>
        paragraphs(`${result.title}\n\n${result.text}`).map((p) => ({
          text: p,
          locator: { url: result.url.slice(0, 2048) },
        })),
      ),
    ],
    chars,
  );

/** UTF-8 bytes of the chunk text of a source. */
export const chunksBytes = (chunks: ReadonlyArray<SourceChunk>) =>
  chunks.reduce((sum, chunk) => sum + byteLength(chunk.text), 0);

// ---------------------------------------------------------------------------------------------
// Slice of a turn (A3)

/** One chunk as a turn request carries it. */
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const SliceChunk = Schema.Struct({
  sourceId: SourceId,
  ordinal: NonNegativeInt,
  title: SourceTitle,
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(maxChunkChars)),
  locator: ChunkLocator,
});
export type SliceChunk = typeof SliceChunk.Type;

export const SourceSlice = Schema.Array(SliceChunk);
export type SourceSlice = typeof SourceSlice.Type;

/** Default count and byte budget of the slice of one turn (spike C3 may tune them). */
export const defaultSourceSliceCount = 8;
export const defaultSourceSliceBytes = 24 * 1024;

/** What a turn is about: topic, current step, and the learner's latest input. */
export const sourceQueryText = (session: Session, input = ''): string => {
  const step = currentStep(session);
  return [session.topic, step?.title ?? '', step?.goal ?? '', input].join('\n');
};

/**
 * The chunks closest to `query`, at most `count` and `maxBytes` (UTF-8 of their JSON). Ties keep
 * source order, then chunk order, so with no shared word the start of the documents comes first.
 * Deterministic: guest and server pick the same slice.
 */
export const selectSourceSlice = (
  chunks: ReadonlyArray<SliceChunk>,
  query: string,
  options: { readonly count?: number; readonly maxBytes?: number } = {},
): SourceSlice => {
  const count = options.count ?? defaultSourceSliceCount;
  const maxBytes = options.maxBytes ?? defaultSourceSliceBytes;
  const words = tokenize(query);
  const ranked = chunks
    .map((chunk, index) => ({
      chunk,
      index,
      score: lexicalSimilarity(words, tokenize(chunk.text)),
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const picked: SliceChunk[] = [];
  let bytes = 2;
  for (const { chunk } of ranked) {
    if (picked.length >= count) break;
    const size = byteLength(JSON.stringify(chunk)) + 1;
    if (bytes + size > maxBytes) continue;
    picked.push(chunk);
    bytes += size;
  }
  // Reading order inside the prompt: by source, then by position.
  const order = new Map(chunks.map((chunk, index) => [chunk, index]));
  return picked.sort((a, b) => order.get(a)! - order.get(b)!);
};

// ---------------------------------------------------------------------------------------------
// PDF text (plan nguon-hoc.md A4, spike C1)

/** One text item of a PDF page, as pdfjs gives it: `y` is the baseline, `height` the font size. */
export interface PdfTextItem {
  readonly str: string;
  readonly hasEOL: boolean;
  readonly y: number;
  readonly height: number;
}

/** A page "has text" when it averages at least this many non-space characters (spike C1). */
export const minPdfCharsPerPage = 10;

const lineKey = (line: string) => line.trim().replace(/\d+/g, '#').toLowerCase();

/**
 * Page text of a PDF: lines from `hasEOL`, a paragraph break where the gap to the next line is
 * more than 1.5 line heights, and running heads and footers dropped: a short line among the first
 * or last two of a page that repeats there on at least half the pages (digits ignored). NFC.
 */
export const pdfPagesText = (
  pages: ReadonlyArray<{ readonly page: number; readonly items: ReadonlyArray<PdfTextItem> }>,
): Array<{ page: number; text: string }> => {
  const linesOf = pages.map(({ page, items }) => {
    const lines: Array<{ text: string; y: number; height: number }> = [];
    let text = '';
    let y = Number.NaN;
    let height = 0;
    const end = () => {
      if (text.trim().length > 0) lines.push({ text: text.trim(), y, height });
      text = '';
      y = Number.NaN;
      height = 0;
    };
    for (const item of items) {
      if (Number.isNaN(y)) y = item.y;
      height = Math.max(height, item.height);
      text += item.str;
      if (item.hasEOL) end();
    }
    end();
    return { page, lines };
  });
  const edge = (index: number, count: number) => index < 2 || index >= count - 2;
  const counts = new Map<string, number>();
  if (pages.length >= 3) {
    for (const { lines } of linesOf) {
      const keys = lines
        .filter((line, index) => line.text.length <= 80 && edge(index, lines.length))
        .map((line) => lineKey(line.text));
      for (const key of new Set(keys)) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const repeated = (line: string) =>
    line.length <= 80 && (counts.get(lineKey(line)) ?? 0) >= Math.max(3, pages.length / 2);
  return linesOf.map(({ page, lines }) => {
    const kept = lines.filter((line, index) => !(edge(index, lines.length) && repeated(line.text)));
    let text = '';
    kept.forEach((line, index) => {
      const previous = kept[index - 1];
      if (previous !== undefined) {
        const gap = Math.abs(previous.y - line.y);
        const size = Math.max(previous.height, line.height, 1);
        text += gap > 1.5 * size * 1.2 ? '\n\n' : '\n';
      }
      text += line.text;
    });
    return { page, text: text.normalize('NFC') };
  });
};

/** True when the PDF has a text layer worth reading (not a scan). */
export const pdfHasText = (pages: ReadonlyArray<{ readonly text: string }>) =>
  pages.length > 0 &&
  pages.reduce((sum, p) => sum + p.text.replace(/\s/g, '').length, 0) / pages.length >=
    minPdfCharsPerPage;

/** Codes of a failed source (A4, A5). The UI has a message for each. */
export const SourceFailureCode = {
  NoText: 'NoText',
  Encrypted: 'Encrypted',
  Invalid: 'Invalid',
  TooLarge: 'TooLarge',
  Timeout: 'Timeout',
  Interrupted: 'Interrupted',
  Failed: 'Failed',
  /** Research: the search found nothing (A5). */
  NoResults: 'NoResults',
} as const;

const pdfFailureMessages: Record<string, string> = {
  NoText: 'This PDF has no text layer (a scan?). Text recognition is not supported.',
  Encrypted: 'This PDF is protected by a password.',
  Invalid: 'This file is not a readable PDF.',
  TooLarge: 'This PDF is too large (pages or text).',
  Timeout: 'Reading this PDF took too long.',
  TooMuchMemory: 'Reading this PDF needed too much memory.',
  Crashed: 'Reading this PDF failed.',
};

/**
 * The chunks of an extracted PDF, or why it fails: same function for the browser and the server,
 * so both modes give the same chunks (A4).
 */
export const pdfSourceChunks = (
  result:
    | {
        readonly ok: true;
        readonly pages: ReadonlyArray<{
          readonly page: number;
          readonly items: ReadonlyArray<PdfTextItem>;
        }>;
      }
    | { readonly ok: false; readonly code: string },
):
  | { readonly ok: true; readonly chunks: SourceChunk[] }
  | { readonly ok: false; readonly failure: SourceFailure } => {
  const fail = (code: string) => ({
    ok: false as const,
    failure: {
      code: code === 'TooMuchMemory' ? 'TooLarge' : code === 'Crashed' ? 'Invalid' : code,
      message: pdfFailureMessages[code] ?? 'Reading this PDF failed.',
    },
  });
  if (!result.ok) return fail(result.code);
  const pages = pdfPagesText(result.pages);
  if (!pdfHasText(pages)) return fail('NoText');
  const chunks = chunkPages(pages);
  if (chunks.length === 0) return fail('NoText');
  if (chunksBytes(chunks) > maxSourceTextBytes) return fail('TooLarge');
  return { ok: true, chunks };
};

/**
 * The slice of one turn (A3): chunks of the sources attached to the session (`chunks` as storage
 * reads them; a source not ready has none), closest to the turn's query. Guest and server call
 * this with the same data and get the same slice.
 */
export const turnSourceSlice = (
  session: Session,
  chunks: ReadonlyArray<{
    readonly sourceId: string;
    readonly title: string;
    readonly chunk: SourceChunk;
  }>,
  input = '',
  options: { readonly count?: number; readonly maxBytes?: number } = {},
): SourceSlice => {
  const attached = new Set(session.sources.map((s) => s.sourceId));
  const candidates = chunks
    .filter((stored) => attached.has(stored.sourceId))
    .map((stored): SliceChunk => ({
      sourceId: stored.sourceId,
      ordinal: stored.chunk.ordinal,
      title: stored.title,
      text: stored.chunk.text,
      locator: stored.chunk.locator,
    }));
  return candidates.length === 0
    ? []
    : selectSourceSlice(candidates, sourceQueryText(session, input), options);
};

/** The chunks a session was taught from (`TurnCompleted.sourceRefs`), each once, in first-use order. */
export const usedSourceRefs = (log: EventLog): SourceChunkRef[] => {
  const refs: SourceChunkRef[] = [];
  const seen = new Set<string>();
  for (const event of log) {
    if (event._tag !== 'TurnCompleted' || event.sourceRefs === undefined) continue;
    for (const ref of event.sourceRefs) {
      const key = `${ref.sourceId}\u0000${ref.ordinal}`;
      if (seen.has(key)) continue;
      seen.add(key);
      refs.push(ref);
    }
  }
  return refs;
};

/** Default byte budget of the documents of an extraction (A3). */
export const defaultDocumentSliceBytes = 48 * 1024;

/**
 * The documents of an extraction (A3): the chunks the session used that still exist (a deleted
 * source is skipped), in first-use order, cut to `maxBytes` (UTF-8 of their JSON).
 */
export const sessionDocumentSlice = (
  log: EventLog,
  chunks: ReadonlyArray<{
    readonly sourceId: string;
    readonly title: string;
    readonly chunk: SourceChunk;
  }>,
  maxBytes = defaultDocumentSliceBytes,
): SourceSlice => {
  const byRef = new Map(chunks.map((c) => [`${c.sourceId}\u0000${c.chunk.ordinal}`, c]));
  const slice: SliceChunk[] = [];
  let bytes = 2;
  for (const ref of usedSourceRefs(log)) {
    const stored = byRef.get(`${ref.sourceId}\u0000${ref.ordinal}`);
    if (stored === undefined) continue;
    const chunk: SliceChunk = {
      sourceId: stored.sourceId,
      ordinal: stored.chunk.ordinal,
      title: stored.title,
      text: stored.chunk.text,
      locator: stored.chunk.locator,
    };
    const size = byteLength(JSON.stringify(chunk)) + 1;
    if (bytes + size > maxBytes) break;
    slice.push(chunk);
    bytes += size;
  }
  return slice;
};
