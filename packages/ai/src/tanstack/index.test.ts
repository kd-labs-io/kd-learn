import { Effect, Schema, Stream } from 'effect';
import { describe, expect, it } from 'vitest';
import type { AnthropicMessagesClient } from '@tanstack/ai-anthropic';
import { jsonSchemaOf, runTurn } from './index.ts';

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    });
  });

/** A fake Anthropic client that streams text deltas forever and records when it is aborted. */
const endlessClient = () => {
  const state = { requests: 0, aborted: false };
  const client = {
    beta: {
      messages: {
        create: async (_params: unknown, options?: { signal?: AbortSignal }) => {
          state.requests++;
          const signal = options?.signal;
          signal?.addEventListener('abort', () => (state.aborted = true));
          return (async function* () {
            yield {
              type: 'message_start',
              message: {
                id: 'msg_1',
                model: 'claude-haiku-5-5',
                usage: { input_tokens: 1, output_tokens: 0 },
              },
            };
            yield {
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'text', text: '' },
            };
            for (;;) {
              yield {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'text_delta', text: 'tick ' },
              };
              await sleep(10, signal);
            }
          })();
        },
      },
    },
  } as unknown as AnthropicMessagesClient;
  return { client, state };
};

describe('jsonSchemaOf', () => {
  it('emits plain numbers and closed objects', () => {
    const schema = jsonSchemaOf(
      Schema.Struct({ a: Schema.Finite, nested: Schema.Struct({ b: Schema.String }) }),
    );
    expect(schema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      properties: {
        a: { type: 'number' },
        nested: { type: 'object', additionalProperties: false },
      },
      required: ['a', 'nested'],
    });
  });
});

describe('runTurn (TanStack AI)', () => {
  it('maps text deltas and aborts the provider request when the stream is interrupted', async () => {
    const { client, state } = endlessClient();
    const events = await Effect.runPromise(
      runTurn({ anthropicClient: client })({
        model: { provider: 'anthropic', model: 'claude-haiku-5-5', apiKey: 'unused' },
        messages: [{ role: 'user', content: 'hi' }],
      }).pipe(Stream.take(3), Stream.runCollect),
    );

    expect(events.map((e) => e._tag)).toEqual(['TextDelta', 'TextDelta', 'TextDelta']);
    expect(state.requests).toBe(1);
    await sleep(20);
    expect(state.aborted).toBe(true);
  });
});
