// Learning sources of accounts (plan nguon-hoc.md A2, A4). Paths below `/api/account/sources`:
//
// | Path | Method | Body | Answer |
// | --- | --- | --- | --- |
// | `sources` | GET | | `SourceList` |
// | `sources` | POST | `CreateNoteSourceRequest` (JSON) | 201 `SourceResponse` (`ready`) |
// | `sources` | POST | multipart, field `file` (PDF) | 202 `SourceResponse` (`pending`, job `ingest`) |
// | `sources/:id` | GET | | `SourceDetail` |
// | `sources/:id` | DELETE | | 204 |
// | `sources/:id/retry` | POST | | 202 `SourceResponse` |
//
// Another user's source answers 404, like one that does not exist.
import { Schema } from 'effect';
import { SourceChunk, SourceInfo, SourceTitle } from '@kd-learn/core';

export const ACCOUNT_SOURCES_PATH = '/api/account/sources';

/** Largest PDF accepted (A2). The multipart body may be a little larger. */
export const MAX_PDF_BYTES = 20 * 1024 * 1024;
/** Largest note file (A2), checked by the client before chunking. */
export const MAX_NOTE_BYTES = 2 * 1024 * 1024;
/** Most pages of a PDF (A2). */
export const MAX_PDF_PAGES = 500;

export const SourceList = Schema.Struct({ sources: Schema.Array(SourceInfo) });
export type SourceList = typeof SourceList.Type;

export const SourceResponse = Schema.Struct({ source: SourceInfo });
export type SourceResponse = typeof SourceResponse.Type;

export const SourceDetail = Schema.Struct({
  source: SourceInfo,
  chunks: Schema.Array(SourceChunk),
});
export type SourceDetail = typeof SourceDetail.Type;

/** A note chunked by the client (A4: notes are read and chunked on the client in every mode). */
export const CreateNoteSourceRequest = Schema.Struct({
  kind: Schema.Literal('note'),
  title: SourceTitle,
  /** The file name. */
  origin: Schema.String.check(Schema.isMaxLength(2048)),
  chunks: Schema.Array(SourceChunk).check(Schema.isMinLength(1)),
});
export type CreateNoteSourceRequest = typeof CreateNoteSourceRequest.Type;
