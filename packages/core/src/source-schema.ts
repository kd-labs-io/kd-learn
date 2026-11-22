// Schemas of learning sources (plan nguon-hoc.md A2, A3), apart from the functions in
// `source.ts` so that event schemas can import them without an import cycle. Only `effect`.
import { Schema } from 'effect';

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const SourceId = Schema.NonEmptyString;
export type SourceId = typeof SourceId.Type;

export const SourceKind = Schema.Literals(['pdf', 'note', 'web']);
export type SourceKind = typeof SourceKind.Type;

export const SourceState = Schema.Literals(['pending', 'ready', 'failed']);
export type SourceState = typeof SourceState.Type;

export const maxSourceTitleLength = 300;
export const SourceTitle = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(maxSourceTitleLength),
);

/** Where a chunk sits in its source: the page of a PDF, the heading of a note, the URL of a web result. */
export const ChunkLocator = Schema.Struct({
  page: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  heading: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(300))),
  url: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2048))),
});
export type ChunkLocator = typeof ChunkLocator.Type;

/** Default chunk size in characters (spike C3 may tune it). */
export const defaultChunkChars = 1500;
/** Longest text of one chunk. A chunker never makes one longer. */
export const maxChunkChars = 4000;

/** One chunk. `ordinal` (0-based) identifies it within its source. */
export const SourceChunk = Schema.Struct({
  ordinal: NonNegativeInt,
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(maxChunkChars)),
  locator: ChunkLocator,
});
export type SourceChunk = typeof SourceChunk.Type;

/** A chunk of a source, as events refer to it. */
export const SourceChunkRef = Schema.Struct({
  sourceId: SourceId,
  ordinal: NonNegativeInt,
});
export type SourceChunkRef = typeof SourceChunkRef.Type;

/** A `[S<label>]` mark of a teacher message, resolved to the chunk it cites. */
export const Citation = Schema.Struct({
  label: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  sourceId: SourceId,
  ordinal: NonNegativeInt,
});
export type Citation = typeof Citation.Type;

/** Why a source failed. `message` never holds a key. */
export const SourceFailure = Schema.Struct({
  code: Schema.NonEmptyString,
  message: Schema.String.check(Schema.isMaxLength(500)),
});
export type SourceFailure = typeof SourceFailure.Type;

/** One row of the source list. */
export const SourceInfo = Schema.Struct({
  sourceId: SourceId,
  kind: SourceKind,
  title: SourceTitle,
  /** File name, URL or research question. */
  origin: Schema.String.check(Schema.isMaxLength(2048)),
  state: SourceState,
  failure: Schema.optionalKey(SourceFailure),
  /** UTF-8 bytes of the chunk text (0 while pending). */
  bytes: NonNegativeInt,
  chunkCount: NonNegativeInt,
  createdAt: NonNegativeInt,
});
export type SourceInfo = typeof SourceInfo.Type;
