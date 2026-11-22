// Notes as sources (plan nguon-hoc.md A4): `.md` and `.txt` files are read and chunked here, in the
// browser, in every mode; an account sends the chunks to the server. One file is one source.
import { MAX_NOTE_BYTES } from '@kd-learn/api';
import {
  SourceFailureCode,
  chunkNote,
  chunksBytes,
  maxSourceTextBytes,
  type SourceChunk,
  type SourceFailure,
} from '@kd-learn/core';

export const NOTE_EXTENSIONS = ['.md', '.markdown', '.txt'] as const;

export type NoteRead =
  | {
      readonly ok: true;
      readonly title: string;
      readonly origin: string;
      readonly chunks: SourceChunk[];
    }
  | { readonly ok: false; readonly origin: string; readonly failure: SourceFailure };

/** A note's title: its file name without the extension, at most 300 characters. */
export const noteTitle = (fileName: string): string => {
  const base = fileName
    .replace(/^.*[\\/]/, '')
    .replace(/\.(md|markdown|txt)$/i, '')
    .trim();
  return (base === '' ? 'Note' : base).slice(0, 300);
};

/** Chunks of a note's text, or why it cannot be a source. Pure. */
export const noteChunks = (fileName: string, text: string): NoteRead => {
  const origin = fileName.slice(0, 2048);
  const chunks = chunkNote(text);
  if (chunks.length === 0) {
    return {
      ok: false,
      origin,
      failure: { code: SourceFailureCode.NoText, message: 'This note has no text.' },
    };
  }
  if (chunksBytes(chunks) > maxSourceTextBytes) {
    return {
      ok: false,
      origin,
      failure: { code: SourceFailureCode.TooLarge, message: 'This note is too large.' },
    };
  }
  return { ok: true, title: noteTitle(fileName), origin, chunks };
};

/** Reads one note file. Files over 2 MiB, or not UTF-8, are refused. */
export const readNoteFile = async (file: File): Promise<NoteRead> => {
  const origin = file.name.slice(0, 2048);
  if (file.size > MAX_NOTE_BYTES) {
    return {
      ok: false,
      origin,
      failure: { code: SourceFailureCode.TooLarge, message: 'A note may be 2 MiB at most.' },
    };
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
  } catch {
    return {
      ok: false,
      origin,
      failure: { code: SourceFailureCode.Invalid, message: 'This file is not UTF-8 text.' },
    };
  }
  return noteChunks(file.name, text);
};
