// Figures in a Teacher turn (phase 5 A1): diagrams (SVG, Mermaid), demos (HTML) and images. The
// log holds only metadata (`FigureAdded`) and a marker in the message text; the body lives in a
// table of its own, written in the same batch as the turn's events.
import { Schema } from 'effect';
import { utf8Length } from './slice.ts';

export const FigureKind = Schema.Literals(['svg', 'mermaid', 'html', 'image']);
export type FigureKind = typeof FigureKind.Type;

export const FigureId = Schema.NonEmptyString.check(Schema.isMaxLength(64));
export type FigureId = typeof FigureId.Type;

export const FigureTitle = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));

export const FigureMime = Schema.Literals([
  'image/svg+xml',
  'text/vnd.mermaid',
  'text/html',
  'image/png',
  'image/jpeg',
  'image/webp',
]);
export type FigureMime = typeof FigureMime.Type;

/** The mime type of the text kinds. Images carry the type the provider returned. */
export const textFigureMime = {
  svg: 'image/svg+xml',
  mermaid: 'text/vnd.mermaid',
  html: 'text/html',
} as const satisfies Record<Exclude<FigureKind, 'image'>, FigureMime>;

/** Largest body of each kind, in bytes (UTF-8 for text). Plan A1. */
export const figureMaxBytes: Readonly<Record<FigureKind, number>> = {
  svg: 64 * 1024,
  mermaid: 16 * 1024,
  html: 128 * 1024,
  image: 2 * 1024 * 1024,
};

/** Per-turn and per-session caps (plan A1). The profile may lower them, never raise them. */
export const figureCaps = { perTurn: 3, imagesPerTurn: 1, imagesPerSession: 6 } as const;

/**
 * Libraries a demo may load (plan A5, spike step 0): one exact file per entry, pinned version,
 * classic (non-module) build so the frame's hash-only CSP can allow it by its SRI hash. jsDelivr
 * serves versioned npm files immutably.
 */
export const demoLibraries = [
  {
    id: 'd3',
    name: 'D3',
    version: '7.9.2',
    global: 'd3',
    license: 'ISC',
    url: 'https://cdn.jsdelivr.net/npm/d3@7.9.2/dist/d3.min.js',
    npmPath: 'd3/dist/d3.min.js',
    integrity: 'sha384-LxfWGZyh6PaLjBRPf7NWiEYs9Mn0UQ6ZmqbLLZhxlOBBNWF2a2K0Pfc5efkrNnhQ',
  },
  {
    id: 'chart.js',
    name: 'Chart.js',
    version: '4.6.1',
    global: 'Chart',
    license: 'MIT',
    url: 'https://cdn.jsdelivr.net/npm/chart.js@4.6.1/dist/chart.umd.min.js',
    npmPath: 'chart.js/dist/chart.umd.min.js',
    integrity: 'sha384-Emf5ZVIUiarAdhkgtqK+5/Z5qIvM6QoVrS+qAVtfyZVuD5lIHrac0me485+Antp0',
  },
  {
    id: 'matter-js',
    name: 'Matter.js',
    version: '0.20.0',
    global: 'Matter',
    license: 'MIT',
    url: 'https://cdn.jsdelivr.net/npm/matter-js@0.20.0/build/matter.min.js',
    npmPath: 'matter-js/build/matter.min.js',
    integrity: 'sha384-ZRKYEXtLBVeqs9z1WxyeKutCqnkqolS/r1EUWuoUpG4ZKbnRAIXnHhHdnNuiB6CL',
  },
] as const;
export type DemoLibrary = (typeof demoLibraries)[number];
export type DemoLibraryId = DemoLibrary['id'];

/** Kept in step with `demoLibraries` (a test checks). */
export const DemoLibraryId = Schema.Literals(['d3', 'chart.js', 'matter-js']);

export const demoLibrary = (id: string): DemoLibrary | undefined =>
  demoLibraries.find((library) => library.id === id);

/**
 * Color tokens a figure may use (`var(--kd-<name>)`), filled from the app theme at display time so
 * figures follow theme changes (plan A3, A8).
 */
export const figureColorTokens = [
  'fg',
  'bg',
  'muted',
  'accent',
  'border',
  'cat-1',
  'cat-2',
  'cat-3',
  'cat-4',
  'cat-5',
  'cat-6',
] as const;
export type FigureColorToken = (typeof figureColorTokens)[number];

/** The tokens as the model is told about them. */
export const figureColorList = figureColorTokens.map((name) => `--kd-${name}`).join(', ');

/** Metadata of one figure, as the log holds it. */
export const FigureInfo = Schema.Struct({
  figureId: FigureId,
  kind: FigureKind,
  title: FigureTitle,
  mime: FigureMime,
  bytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  /** Demo only: libraries the frame loads before the demo's own code. */
  libraries: Schema.optionalKey(Schema.Array(DemoLibraryId)),
});
export type FigureInfo = typeof FigureInfo.Type;

/** Body of one figure. Text kinds carry a string, images the raw bytes. */
export interface FigureBody {
  readonly figureId: string;
  readonly body: string | Uint8Array;
}

/** Byte size of a body: UTF-8 length of a string, length of the bytes. */
export const figureBodyBytes = (body: string | Uint8Array): number =>
  typeof body === 'string' ? utf8Length(body) : body.length;

// Markers: `[[figure:<id>]]` on a line of its own, where the tool ran (plan A1).
const MARKER = /\[\[figure:([A-Za-z0-9_-]{1,64})\]\]/g;

export const figureMarker = (figureId: string) => `[[figure:${figureId}]]`;

/** Removes the markers that name no figure of `known` (a model may type one itself). */
export const keepKnownFigureMarkers = (content: string, known: ReadonlySet<string>): string =>
  content.replace(MARKER, (marker, id: string) => (known.has(id) ? marker : ''));

export type FigureSegment =
  | { readonly _tag: 'text'; readonly text: string }
  | { readonly _tag: 'figure'; readonly figureId: string };

/** Splits a message into text and figure segments, in order. Empty text segments are dropped. */
export const splitFigureMarkers = (content: string): ReadonlyArray<FigureSegment> => {
  const segments: Array<FigureSegment> = [];
  let last = 0;
  for (const match of content.matchAll(MARKER)) {
    const text = content.slice(last, match.index);
    if (text.trim() !== '') segments.push({ _tag: 'text', text });
    segments.push({ _tag: 'figure', figureId: match[1]! });
    last = match.index + match[0].length;
  }
  const rest = content.slice(last);
  if (rest.trim() !== '') segments.push({ _tag: 'text', text: rest });
  return segments;
};

/**
 * The marker as the model sees it in later turns: kind and title, never the code (plan A1). A
 * marker of an unknown figure disappears.
 */
export const describeFigureMarkers = (
  content: string,
  figures: ReadonlyMap<string, Pick<FigureInfo, 'kind' | 'title'>>,
): string =>
  content.replace(MARKER, (_marker, id: string) => {
    const figure = figures.get(id);
    return figure === undefined ? '' : `[figure: ${figure.kind} "${figure.title}"]`;
  });
