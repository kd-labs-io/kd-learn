// Keeping the guest's key out of logs and error text (plan A7, risk 19). Everything that leaves
// the server (frames, error bodies, log entries) goes through these helpers.
import type { Schema, SchemaIssue } from 'effect';
import type { Frame } from '@kd-learn/api';

/** One key, or several (a turn's model key and its image key, phase 5 A6). */
export type Secrets = string | undefined | ReadonlyArray<string | undefined>;

const secretsOf = (secret: Secrets): ReadonlyArray<string> =>
  (typeof secret === 'string' || secret === undefined ? [secret] : secret).filter(
    (one): one is string => one !== undefined && one.length >= 8,
  );

/** Replaces every occurrence of each secret in `text`. Short strings are not treated as secrets. */
export const redact = (text: string, secret: Secrets): string =>
  secretsOf(secret).reduce((out, one) => out.split(one).join('[redacted]'), text);

/** Scrubs the text fields that carry error messages. Other frames pass through unchanged. */
export const scrubFrame = (frame: Frame, secret: Secrets): Frame => {
  switch (frame._tag) {
    case 'error':
      return { ...frame, error: { ...frame.error, message: redact(frame.error.message, secret) } };
    case 'event':
      return frame.event._tag === 'TurnFailed' || frame.event._tag === 'SideTurnFailed'
        ? { ...frame, event: { ...frame.event, message: redact(frame.event.message, secret) } }
        : frame;
    default:
      return frame;
  }
};

/**
 * Drops figures whose text body holds `secret`, with their `FigureAdded` (risk 19). Redacting the
 * body instead would break its byte count, and the client would refuse the whole batch. Bodies come
 * before events, so one pass is enough. Stateful: one per stream.
 */
export const makeFigureLeakFilter = (secret: Secrets) => {
  const dropped = new Set<string>();
  return (frame: Frame): boolean => {
    if (frame._tag === 'figure' && frame.encoding === 'text') {
      if (redact(frame.body, secret) === frame.body) return true;
      dropped.add(frame.figureId);
      return false;
    }
    return !(
      frame._tag === 'event' &&
      frame.event._tag === 'FigureAdded' &&
      dropped.has(frame.event.figureId)
    );
  };
};

/**
 * Describes a decoding failure by paths and kinds only, never by the offending values: a value
 * can be the key itself (a key sent where a number is expected).
 */
export const describeIssue = (error: Schema.SchemaError): string => {
  const found = new Set<string>();
  const walk = (issue: SchemaIssue.Issue, path: ReadonlyArray<string>): void => {
    switch (issue._tag) {
      case 'Pointer':
        return walk(issue.issue, [...path, ...issue.path.map(String)]);
      case 'Filter':
      case 'Encoding':
        return walk(issue.issue, path);
      case 'Composite':
      case 'AnyOf':
        return issue.issues.forEach((inner) => walk(inner, path));
      case 'MissingKey':
        found.add(`${path.join('.') || '(root)'}: missing`);
        return;
      case 'UnexpectedKey':
        found.add(`${path.join('.') || '(root)'}: not allowed`);
        return;
      default:
        found.add(`${path.join('.') || '(root)'}: invalid`);
    }
  };
  walk(error.issue, []);
  const list = [...found].slice(0, 5).join('; ');
  return list === '' ? 'Invalid request.' : `Invalid request: ${list}.`;
};

export const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** Redacts `secret` in every string of a value (events are plain JSON data). */
export const scrubDeep = <T>(value: T, secret: Secrets): T => {
  if (secretsOf(secret).length === 0) return value;
  const walk = (inner: unknown): unknown => {
    if (typeof inner === 'string') return redact(inner, secret);
    if (Array.isArray(inner)) return inner.map(walk);
    if (typeof inner === 'object' && inner !== null) {
      return Object.fromEntries(Object.entries(inner).map(([k, v]) => [k, walk(v)]));
    }
    return inner;
  };
  return walk(value) as T;
};
