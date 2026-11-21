import { Result, Schema } from 'effect';
import { describe, expect, it } from 'vitest';
import { TurnRequest } from '@kd-learn/api';
import { describeIssue, redact, scrubFrame } from './safety.ts';

const KEY = 'sk-ant-SECRET-key-0123456789';

describe('redact', () => {
  it('replaces every occurrence of the key and leaves short secrets alone', () => {
    expect(redact(`a ${KEY} b ${KEY}`, KEY)).toBe('a [redacted] b [redacted]');
    expect(redact('abc abc', 'abc')).toBe('abc abc');
    expect(redact('x', undefined)).toBe('x');
  });
});

describe('scrubFrame', () => {
  it('scrubs error frames and failure events, and leaves other frames alone', () => {
    const failure = { code: 'E', message: `bad ${KEY}`, retryable: false };
    expect(scrubFrame({ _tag: 'error', error: failure }, KEY)).toEqual({
      _tag: 'error',
      error: { ...failure, message: 'bad [redacted]' },
    });
    const turnFailed = { _tag: 'TurnFailed', id: 'e', at: 1, turnId: 't', ...failure } as const;
    expect(JSON.stringify(scrubFrame({ _tag: 'event', event: turnFailed }, KEY))).not.toContain(
      KEY,
    );
    const side = { _tag: 'SideTurnFailed', id: 'e', at: 1, threadId: 'th', ...failure } as const;
    expect(JSON.stringify(scrubFrame({ _tag: 'event', event: side }, KEY))).not.toContain(KEY);
    const delta = { _tag: 'delta', messageId: 'm', delta: 'hi' } as const;
    expect(scrubFrame(delta, KEY)).toBe(delta);
  });
});

describe('describeIssue', () => {
  it('lists paths and kinds, never values', () => {
    const result = Schema.decodeUnknownResult(TurnRequest)(
      { model: { provider: 'anthropic', model: 7, apiKey: KEY, extra: KEY }, turn: KEY, log: [] },
      { onExcessProperty: 'error' },
    );
    expect(Result.isFailure(result)).toBe(true);
    const message = Result.isFailure(result) ? describeIssue(result.failure) : '';
    expect(message).toMatch(/^Invalid request: /);
    expect(message).not.toContain(KEY);
  });
});
