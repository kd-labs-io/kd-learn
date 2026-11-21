// Keeping the guest's key out of logs and error text (plan A7, risk 19). Everything that leaves
// the server (frames, error bodies, log entries) goes through these helpers.
import type { Schema, SchemaIssue } from 'effect';
import type { Frame } from '@kd-learn/api';

/** Replaces every occurrence of `secret` in `text`. Short strings are not treated as secrets. */
export const redact = (text: string, secret: string | undefined): string =>
  secret !== undefined && secret.length >= 8 ? text.split(secret).join('[redacted]') : text;

/** Scrubs the text fields that carry error messages. Other frames pass through unchanged. */
export const scrubFrame = (frame: Frame, secret: string | undefined): Frame => {
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
