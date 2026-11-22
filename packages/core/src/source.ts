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
} from './source-schema.ts';
import { lexicalSimilarity, tokenize, utf8Length } from './slice.ts';
import { currentStep, type Session } from './session.ts';

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
