// Messages between the page (index.ts) and the Worker (worker.ts). Structured-clone values only.
import type { SettingsKey } from '../sqlite/schema.ts';

/** An event as stored: the payload is the JSON of the whole event. */
export interface WireEvent {
  readonly id: string;
  readonly tag: string;
  readonly at: number;
  readonly payload: string;
}

export interface WireSession {
  readonly sessionId: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly eventCount: number;
  /** Payload of the `SessionCreated` event, when the session has one. */
  readonly created: string | undefined;
}

export type Operation =
  | { readonly op: 'open'; readonly name: string }
  | { readonly op: 'append'; readonly sessionId: string; readonly events: ReadonlyArray<WireEvent> }
  | { readonly op: 'read'; readonly sessionId: string }
  | { readonly op: 'list' }
  | { readonly op: 'getSettings' }
  | {
      readonly op: 'putSettings';
      readonly entries: Readonly<Partial<Record<SettingsKey, string>>>;
      readonly remove: ReadonlyArray<SettingsKey>;
    }
  | { readonly op: 'close' };

export type Request = Operation & { readonly id: number };

/** `unavailable`: the store could not be opened at all. `failure`: the call was rejected. */
export type Response =
  | { readonly id: number; readonly ok: true; readonly result: unknown }
  | {
      readonly id: number;
      readonly ok: false;
      readonly kind: 'unavailable' | 'failure';
      readonly message: string;
    };

export interface AppendReply {
  readonly lastSeq: number;
}
