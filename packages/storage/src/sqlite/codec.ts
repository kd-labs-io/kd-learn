// Mapping between domain events and rows of the `events` table, shared by every SQLite driver.
// Pure: no driver code here.
import { Schema } from 'effect';
import { DomainEvent, type EventLog } from '@kd-learn/core';
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
