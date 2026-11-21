// Messages between the page (index.ts) and the Worker (worker.ts). Structured-clone values only.
import type { EventRow, SessionRow } from '../sqlite/codec.ts';
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
  | { readonly op: 'close' };

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
      readonly kind: 'unavailable' | 'failure';
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
