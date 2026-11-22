// Messages between the page (index.ts) and the Worker (worker.ts). Structured-clone values only.
import type { EventRow, SessionRow, SourceRow } from '../sqlite/codec.ts';
import type { SettingsKey } from '../sqlite/schema.ts';

/** An event as stored. */
export type WireEvent = EventRow;

/** One row of the session list. */
export type WireSession = SessionRow;

export type Operation =
  | { readonly op: 'open'; readonly name: string }
  | { readonly op: 'append'; readonly sessionId: string; readonly events: ReadonlyArray<WireEvent> }
  | { readonly op: 'read'; readonly sessionId: string }
  | { readonly op: 'list' }
  | {
      readonly op: 'appendKnowledge';
      readonly events: ReadonlyArray<WireEvent>;
      readonly expectedLastSeq: number;
    }
  | { readonly op: 'readKnowledge' }
  | { readonly op: 'getSettings' }
  | {
      readonly op: 'putSettings';
      readonly entries: Readonly<Partial<Record<SettingsKey, string>>>;
      readonly remove: ReadonlyArray<SettingsKey>;
    }
  | { readonly op: 'getProfile' }
  /** `payload` undefined removes the saved profile. */
  | { readonly op: 'putProfile'; readonly payload: string | undefined; readonly at: number }
  | {
      readonly op: 'createSource';
      readonly row: Omit<SourceRow, 'failure'>;
      readonly chunks: ReadonlyArray<WireChunk>;
      readonly file: Uint8Array | undefined;
    }
  | {
      readonly op: 'completeSource';
      readonly sourceId: string;
      readonly chunks: ReadonlyArray<WireChunk>;
      readonly bytes: number;
      readonly title: string | undefined;
    }
  | { readonly op: 'failSource'; readonly sourceId: string; readonly failure: string }
  | { readonly op: 'retrySource'; readonly sourceId: string }
  | { readonly op: 'listSources' }
  | { readonly op: 'getSource'; readonly sourceId: string }
  | { readonly op: 'readSourceFile'; readonly sourceId: string }
  | { readonly op: 'readChunks'; readonly sourceIds: ReadonlyArray<string> }
  | { readonly op: 'deleteSource'; readonly sourceId: string }
  | { readonly op: 'close' };

/** A chunk as stored: the locator is JSON. */
export interface WireChunk {
  readonly ordinal: number;
  readonly text: string;
  readonly locator: string;
}

export interface WireStoredChunk extends WireChunk {
  readonly sourceId: string;
  readonly title: string;
}

export type Request = Operation & { readonly id: number };

/**
 * `unavailable`: the store could not be opened at all. `failure`: the call was rejected.
 * `conflict`: `appendKnowledge` found the log at another seq than expected; nothing was written.
 */
export type Response =
  | { readonly id: number; readonly ok: true; readonly result: unknown }
  | {
      readonly id: number;
      readonly ok: false;
      readonly kind: 'unavailable' | 'failure' | 'sourceConflict';
      readonly message: string;
    }
  | {
      readonly id: number;
      readonly ok: false;
      readonly kind: 'conflict';
      readonly message: string;
      readonly expectedLastSeq: number;
      readonly lastSeq: number;
    };

export interface AppendReply {
  readonly lastSeq: number;
}
