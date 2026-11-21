import { Effect, Exit, Schema, Stream } from 'effect';
import { describe, expect, it } from 'vitest';
import type { AnthropicMessagesClient } from '@tanstack/ai-anthropic';
import { tool, ToolError } from '../port/index.ts';
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
  const state = { requests: 0, aborted: false, params: undefined as unknown };
  const client = {
    beta: {
      messages: {
        create: async (params: unknown, options?: { signal?: AbortSignal }) => {
          state.requests++;
          state.params = params;
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

  it('keeps records open', () => {
    const schema = jsonSchemaOf(Schema.Record(Schema.String, Schema.Unknown));
    expect(schema.additionalProperties).not.toBe(false);
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

  it('sends the output token cap to the provider', async () => {
    const { client, state } = endlessClient();
    await Effect.runPromise(
      runTurn({ anthropicClient: client })({
        model: { provider: 'anthropic', model: 'claude-haiku-5-5', apiKey: 'unused' },
        messages: [{ role: 'user', content: 'hi' }],
        maxOutputTokens: 321,
      }).pipe(Stream.take(1), Stream.runCollect),
    );
    expect(state.params).toMatchObject({ max_tokens: 321 });
  });
});

type Script = ReadonlyArray<
  | { readonly kind: 'stream'; readonly events: ReadonlyArray<unknown> }
  | { readonly kind: 'message'; readonly message: unknown }
  | { readonly kind: 'reject'; readonly error: Error }
>;

/** A fake Anthropic client that answers each request with the next scripted response. */
const scriptedClient = (script: Script) => {
  const requests: Array<Record<string, unknown>> = [];
  const client = {
    beta: {
      messages: {
        create: async (params: Record<string, unknown>) => {
          requests.push(params);
          const step = script[requests.length - 1];
          if (!step) throw new Error(`unexpected request ${requests.length}`);
          if (step.kind === 'reject') throw step.error;
          if (step.kind === 'message') return step.message;
          return (async function* () {
            yield* step.events;
          })();
        },
      },
    },
  } as unknown as AnthropicMessagesClient;
  return { client, requests };
};

const start = {
  type: 'message_start',
  message: { id: 'msg', model: 'claude-haiku-5-5', usage: { input_tokens: 1, output_tokens: 0 } },
};
const stop = (reason: string) => [
  { type: 'message_delta', delta: { stop_reason: reason }, usage: { output_tokens: 1 } },
  { type: 'message_stop' },
];
const toolUse = (id: string, name: string, input: unknown) => [
  start,
  {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'tool_use', id, name, input: {} },
  },
  {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) },
  },
  { type: 'content_block_stop', index: 0 },
  ...stop('tool_use'),
];
const text = (value: string) => [
  start,
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: value } },
  { type: 'content_block_stop', index: 0 },
  ...stop('end_turn'),
];

const model = { provider: 'anthropic', model: 'claude-haiku-5-5', apiKey: 'unused' } as const;

describe('runTurn (TanStack AI) error paths', () => {
  it('fails with ProviderError when the provider rejects the request', async () => {
    const { client } = scriptedClient([
      { kind: 'reject', error: Object.assign(new Error('invalid x-api-key'), { status: 401 }) },
    ]);
    const exit = await Effect.runPromiseExit(
      runTurn({ anthropicClient: client })({
        model,
        messages: [{ role: 'user', content: 'hi' }],
      }).pipe(Stream.runCollect),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    const error = Exit.isFailure(exit) ? exit.cause.reasons[0] : undefined;
    expect(error).toMatchObject({ _tag: 'Fail', error: { _tag: 'ProviderError' } });
    expect(JSON.stringify(error)).toContain('invalid x-api-key');
    expect(error).toMatchObject({ error: { code: '401' } });
  });

  it('sends a failed tool call back to the model and continues the turn', async () => {
    const flaky = tool({
      name: 'flaky',
      description: 'Fails on purpose.',
      input: Schema.Struct({ n: Schema.Finite }),
      run: () => Effect.fail(new ToolError({ message: 'service down' })),
    });
    const { client, requests } = scriptedClient([
      { kind: 'stream', events: toolUse('toolu_1', 'flaky', { n: 1 }) },
      { kind: 'stream', events: text('Sorry, the tool failed.') },
    ]);
    const events = await Effect.runPromise(
      runTurn({ anthropicClient: client })({
        model,
        messages: [{ role: 'user', content: 'call flaky' }],
        tools: [flaky],
      }).pipe(Stream.runCollect),
    );

    // The demo meter (packages/server/src/demo/metered.ts) relies on this order: one `Usage` per
    // model call, which can land between a tool call and its result.
    expect(events.map((e) => e._tag)).toEqual([
      'ToolCall',
      'Usage',
      'ToolResult',
      'TextDelta',
      'Usage',
      'Finish',
    ]);
    expect(requests).toHaveLength(2);
    const result = events.find((e) => e._tag === 'ToolResult');
    expect(result).toMatchObject({ _tag: 'ToolResult', id: 'toolu_1' });
    expect(result?._tag === 'ToolResult' && result.output).toContain('service down');
    // The second request carries the failure to the model.
    expect(JSON.stringify(requests[1])).toContain('service down');
    expect(events.at(-1)).toEqual({ _tag: 'Finish', reason: 'stop' });
  });

  it('rejects tool input that does not match the schema without calling run', async () => {
    let ran = false;
    const strict = tool({
      name: 'strict',
      description: 'Needs a number.',
      input: Schema.Struct({ n: Schema.Finite }),
      run: () => Effect.sync(() => (ran = true)),
    });
    const { client, requests } = scriptedClient([
      { kind: 'stream', events: toolUse('toolu_2', 'strict', { n: 'one' }) },
      { kind: 'stream', events: text('ok') },
    ]);
    await Effect.runPromise(
      runTurn({ anthropicClient: client })({
        model,
        messages: [{ role: 'user', content: 'call strict' }],
        tools: [strict],
      }).pipe(Stream.runDrain),
    );
    expect(ran).toBe(false);
    // TanStack checks the JSON Schema first; the Effect decode in the adapter is a second guard.
    expect(JSON.stringify(requests[1])).toContain('Input validation failed for tool strict');
  });

  it('fails with OutputInvalid when the structured result does not match the schema', async () => {
    // claude-haiku-5-5 supports tools and an output schema together: the result streams as JSON text.
    const { client } = scriptedClient([{ kind: 'stream', events: text('{"sum":"many"}') }]);
    const exit = await Effect.runPromiseExit(
      runTurn({ anthropicClient: client })({
        model,
        messages: [{ role: 'user', content: 'sum' }],
        output: Schema.Struct({ sum: Schema.Finite }),
      }).pipe(Stream.runCollect),
    );
    const error = Exit.isFailure(exit) ? exit.cause.reasons[0] : undefined;
    expect(error).toMatchObject({ _tag: 'Fail', error: { _tag: 'OutputInvalid' } });
    expect(JSON.stringify(error)).toContain('many');
  });
});
