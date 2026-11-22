// Mapping between domain events and rows of the `events` table, shared by every SQLite driver.
// Pure: no driver code here.
import { Schema } from 'effect';
import {
  DomainEvent,
  KnowledgeEvent,
  SavedProfile,
  SourceChunk,
  SourceInfo,
  TeachingProfile,
  chunksBytes,
  maxSourceTextBytes,
  type EventLog,
  type KnowledgeLog,
} from '@kd-learn/core';
import type { SessionSummary } from '../port/index.ts';

/** An event as stored: the payload is the JSON of the whole event. */
export interface EventRow {
  readonly id: string;
  readonly tag: string;
  readonly at: number;
  readonly payload: string;
}

/** One session as the list query returns it. */
export interface SessionRow {
  readonly sessionId: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly eventCount: number;
  /** Payload of the `SessionCreated` event, when the session has one. */
  readonly created: string | undefined;
}

const decodeEvent = Schema.decodeUnknownSync(DomainEvent);

export const toEventRow = (event: DomainEvent): EventRow => ({
  id: event.id,
  tag: event._tag,
  at: event.at,
  payload: JSON.stringify(event),
});

/** Decodes stored payloads, oldest first. Throws on a payload that is not a valid event. */
export const decodeLog = (payloads: ReadonlyArray<string>): EventLog =>
  payloads.map((payload) => decodeEvent(JSON.parse(payload)));

const decodeKnowledgeEvent = Schema.decodeUnknownSync(KnowledgeEvent);

export const toKnowledgeRow = (event: KnowledgeEvent): EventRow => ({
  id: event.id,
  tag: event._tag,
  at: event.at,
  payload: JSON.stringify(event),
});

/** Decodes stored knowledge payloads, oldest first. Throws on a payload that is not valid. */
export const decodeKnowledgeLog = (payloads: ReadonlyArray<string>): KnowledgeLog =>
  payloads.map((payload) => decodeKnowledgeEvent(JSON.parse(payload)));

export const summarize = (row: SessionRow): SessionSummary => {
  let topic = '';
  if (row.created !== undefined) {
    try {
      const event = decodeEvent(JSON.parse(row.created));
      if (event._tag === 'SessionCreated') topic = event.topic;
    } catch {
      // A damaged SessionCreated must not hide the session from the list.
    }
  }
  return {
    sessionId: row.sessionId,
    topic,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    eventCount: row.eventCount,
  };
};

const checkProfile = Schema.encodeUnknownSync(SavedProfile);
const decodeProfilePayload = Schema.decodeUnknownSync(TeachingProfile);

/** JSON of a profile to save. Throws when it is not a valid `SavedProfile`. */
export const encodeProfile = (profile: SavedProfile): string =>
  JSON.stringify(checkProfile(profile));

/** A stored profile. Throws on a payload that is not a valid `TeachingProfile`. */
export const decodeProfile = (payload: string): TeachingProfile =>
  decodeProfilePayload(JSON.parse(payload));

// ---------------------------------------------------------------------------------------------
// Sources (phase 4 A2)

/** A row of `sources` as every SQLite driver reads it. */
export interface SourceRow {
  readonly source_id: string;
  readonly kind: string;
  readonly title: string;
  readonly origin: string;
  readonly state: string;
  readonly failure: string | null;
  readonly bytes: number;
  readonly chunk_count: number;
  readonly created_at: number;
}

const decodeSourceInfo = Schema.decodeUnknownSync(SourceInfo);
const decodeChunk = Schema.decodeUnknownSync(SourceChunk);

export const fromSourceRow = (row: SourceRow): SourceInfo =>
  decodeSourceInfo({
    sourceId: row.source_id,
    kind: row.kind,
    title: row.title,
    origin: row.origin,
    state: row.state,
    ...(row.failure === null ? {} : { failure: JSON.parse(row.failure) }),
    bytes: Number(row.bytes),
    chunkCount: Number(row.chunk_count),
    createdAt: Number(row.created_at),
  });

/** Validates chunks before a write: schema, ordinals 0..n-1, and the size limit of a source. */
export const checkChunks = (chunks: ReadonlyArray<SourceChunk>): number => {
  chunks.forEach((chunk, index) => {
    decodeChunk(chunk);
    if (chunk.ordinal !== index) throw new Error('Chunk ordinals must be 0, 1, 2, ...');
  });
  const bytes = chunksBytes(chunks);
  if (bytes > maxSourceTextBytes) throw new Error('The source text is too large.');
  return bytes;
};

export const toChunkRow = (chunk: SourceChunk) => ({
  ordinal: chunk.ordinal,
  text: chunk.text,
  locator: JSON.stringify(chunk.locator),
});

export const fromChunkRow = (row: { ordinal: number; text: string; locator: string }) =>
  decodeChunk({ ordinal: Number(row.ordinal), text: row.text, locator: JSON.parse(row.locator) });

/** Checks the info of a new source against its schema. */
export const checkNewSourceInfo = (
  info: Omit<SourceInfo, 'state' | 'failure' | 'bytes' | 'chunkCount'>,
) => decodeSourceInfo({ ...info, state: 'pending', bytes: 0, chunkCount: 0 });
