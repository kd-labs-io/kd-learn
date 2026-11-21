// AiPort adapter backed by TanStack AI (plan 2.4: API backends).
// Effect Schema stays the source of truth: TanStack gets plain JSON Schema, and tool input and
// structured output are decoded here with Effect, not by TanStack.
import { chat, toolDefinition, type StreamChunk } from '@tanstack/ai';
import { createAnthropicChat, type AnthropicMessagesClient } from '@tanstack/ai-anthropic';
import { createAnthropicChatWithClient } from '@tanstack/ai-anthropic';
import { createGeminiChat } from '@tanstack/ai-gemini';
import { openaiCompatibleText } from '@tanstack/ai-openai/compatible';
import { maxIterations } from '@tanstack/ai';
import { Effect, Layer, Schema, Stream } from 'effect';
import {
  AiPort,
  OutputInvalid,
  ProviderError,
  type FinishReason,
  type ModelRef,
  type ToolSpec,
  type TurnEvent,
  type TurnRequest,
} from '../port/index.ts';

/** Closes struct objects: Effect emits `additionalProperties: true`, which disables strict tool calls. Records stay open. */
const closeObjects = (node: unknown): unknown => {
  if (Array.isArray(node)) return node.map(closeObjects);
  if (!node || typeof node !== 'object') return node;
  const entries = Object.entries(node).map(([key, value]) => [key, closeObjects(value)] as const);
  const out = Object.fromEntries(entries) as Record<string, unknown>;
  if (out.additionalProperties === true && 'properties' in out) out.additionalProperties = false;
  return out;
};

/** JSON Schema for a provider, from an Effect schema. */
export const jsonSchemaOf = (schema: Schema.Top): Record<string, unknown> => {
  const doc = Schema.toJsonSchemaDocument(schema);
  const defs = doc.definitions as Record<string, unknown>;
  const base = Object.keys(defs).length > 0 ? { ...doc.schema, $defs: defs } : { ...doc.schema };
  return closeObjects(base) as Record<string, unknown>;
};

type Adapter = Parameters<typeof chat>[0]['adapter'];

/** Test hook: build the Anthropic adapter from a fake client. */
export interface AdapterOverrides {
  readonly anthropicClient?: AnthropicMessagesClient;
}

const adapterFor = (ref: ModelRef, overrides: AdapterOverrides): Adapter => {
  switch (ref.provider) {
    case 'acp':
      throw new Error('unreachable: runTurn rejects ACP models');
    case 'anthropic': {
      const model = ref.model as Parameters<typeof createAnthropicChat>[0];
      return (
        overrides.anthropicClient
          ? createAnthropicChatWithClient(model, overrides.anthropicClient)
          : createAnthropicChat(model, ref.apiKey)
      ) as Adapter;
    }
    case 'gemini':
      return createGeminiChat(
        ref.model as Parameters<typeof createGeminiChat>[0],
        ref.apiKey,
      ) as Adapter;
    case 'openai-compatible':
      return openaiCompatibleText(ref.model, {
        baseURL: ref.baseURL,
        apiKey: ref.apiKey,
        api: 'chat-completions',
      }) as Adapter;
  }
};

/** Each adapter reads the output token cap under its own provider-native name. */
const maxTokensKey = (ref: ModelRef) =>
  ref.provider === 'gemini' ? 'maxOutputTokens' : 'max_tokens';

const toTanstackTool = (spec: ToolSpec<unknown, unknown>, signal: AbortSignal) =>
  toolDefinition({
    name: spec.name,
    description: spec.description,
    inputSchema: jsonSchemaOf(spec.input),
  }).server(async (args: unknown) => {
    const program = Schema.decodeUnknownEffect(spec.input)(args).pipe(
      Effect.mapError((issue) => new Error(`Invalid input for ${spec.name}: ${issue.message}`)),
      Effect.flatMap((input) =>
        spec.run(input).pipe(Effect.mapError((error) => new Error(error.message))),
      ),
    );
    // A rejected promise is reported to the model as a failed tool call.
    return Effect.runPromise(program, { signal });
  });

const finishReasonOf = (value: unknown): FinishReason =>
  value === 'stop' || value === 'length' || value === 'tool_calls' || value === 'content_filter'
    ? value
    : 'unknown';

const usageOf = (usage: unknown): { input: number; output: number } | undefined => {
  if (usage && typeof usage === 'object' && 'promptTokens' in usage) {
    const u = usage as { promptTokens?: number; completionTokens?: number };
    return { input: u.promptTokens ?? 0, output: u.completionTokens ?? 0 };
  }
  return undefined;
};

/**
 * Maps TanStack AI events to TurnEvents for one turn. Stateful: hides the raw JSON text of the
 * structured output and keeps the finish reason of the last model call.
 */
const makeMapper = <A>(output: Schema.Codec<A, unknown> | undefined) => {
  const hidden = new Set<string>();
  const toolNames = new Map<string, string>();
  let finish: FinishReason = 'unknown';

  const map = (
    chunk: StreamChunk,
  ): Effect.Effect<ReadonlyArray<TurnEvent<A>>, ProviderError | OutputInvalid> => {
    const event = chunk as StreamChunk & Record<string, unknown>;
    switch (event.type) {
      case 'TEXT_MESSAGE_CONTENT': {
        const messageId = String(event.messageId);
        return Effect.succeed(
          hidden.has(messageId)
            ? []
            : [{ _tag: 'TextDelta', messageId, delta: String(event.delta) }],
        );
      }
      case 'TOOL_CALL_START':
        toolNames.set(String(event.toolCallId), String(event.toolCallName));
        return Effect.succeed([]);
      case 'TOOL_CALL_END': {
        const id = String(event.toolCallId);
        return Effect.succeed([
          { _tag: 'ToolCall', id, name: toolNames.get(id) ?? 'unknown', input: event.input },
        ]);
      }
      case 'TOOL_CALL_RESULT':
        return Effect.succeed([
          { _tag: 'ToolResult', id: String(event.toolCallId), output: String(event.content) },
        ]);
      case 'RUN_FINISHED': {
        finish = finishReasonOf(event.finishReason ?? event.metadata?.tanstack?.finishReason);
        const usage = usageOf(event.usage);
        return Effect.succeed(
          usage ? [{ _tag: 'Usage', inputTokens: usage.input, outputTokens: usage.output }] : [],
        );
      }
      case 'RUN_ERROR': {
        // TanStack sends the string 'undefined' when the provider gave no code.
        const code =
          typeof event.code === 'string' && event.code !== 'undefined' ? event.code : undefined;
        const tanstack = event.metadata?.tanstack as Record<string, unknown> | undefined;
        if (code?.startsWith('structured-output-')) {
          return Effect.fail(
            new OutputInvalid({
              message: String(event.message),
              raw: String(tanstack?.rawText ?? ''),
            }),
          );
        }
        const retryAfterMs = tanstack?.retryAfterMs;
        return Effect.fail(
          new ProviderError({
            message: String(event.message),
            ...(code ? { code } : {}),
            ...(typeof retryAfterMs === 'number' ? { retryAfterMs } : {}),
          }),
        );
      }
      case 'CUSTOM': {
        const value = event.value as Record<string, unknown> | undefined;
        if (event.name === 'structured-output.start' && value?.messageId) {
          hidden.add(String(value.messageId));
          return Effect.succeed([]);
        }
        if (event.name === 'structured-output.complete' && output && value) {
          return Schema.decodeUnknownEffect(output)(value.object).pipe(
            Effect.mapError(
              (issue) =>
                new OutputInvalid({ message: issue.message, raw: String(value.raw ?? '') }),
            ),
            Effect.map((decoded) => [{ _tag: 'StructuredResult', value: decoded } as const]),
          );
        }
        return Effect.succeed([]);
      }
      default:
        return Effect.succeed([]);
    }
  };

  return { map, finish: () => finish };
};

const toProviderError = (error: unknown) =>
  new ProviderError({ message: error instanceof Error ? error.message : String(error) });

export const runTurn =
  (overrides: AdapterOverrides = {}) =>
  <A = never>(
    request: TurnRequest<A>,
  ): Stream.Stream<TurnEvent<A>, ProviderError | OutputInvalid> =>
    Stream.unwrap(
      Effect.gen(function* () {
        // Closing the scope (end, failure or interrupt) aborts the provider request.
        const controller = yield* Effect.acquireRelease(
          Effect.sync(() => new AbortController()),
          (c) => Effect.sync(() => c.abort()),
        );
        const mapper = makeMapper(request.output);
        const events = chat({
          adapter: adapterFor(request.model, overrides),
          threadId: crypto.randomUUID(),
          messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
          ...(request.system ? { systemPrompts: [request.system] } : {}),
          tools: (request.tools ?? []).map((t) => toTanstackTool(t, controller.signal)),
          ...(request.output ? { outputSchema: jsonSchemaOf(request.output) } : {}),
          agentLoopStrategy: maxIterations(request.maxSteps ?? 5),
          ...(request.maxOutputTokens === undefined
            ? {}
            : { modelOptions: { [maxTokensKey(request.model)]: request.maxOutputTokens } }),
          abortController: controller,
          stream: true,
        } as Parameters<typeof chat>[0]) as AsyncIterable<StreamChunk>;

        return Stream.fromAsyncIterable(events, toProviderError).pipe(
          Stream.mapEffect(mapper.map),
          Stream.flattenIterable,
          Stream.concat(
            Stream.suspend(() =>
              Stream.make({ _tag: 'Finish', reason: mapper.finish() } as TurnEvent<A>),
            ),
          ),
        );
      }),
    );

export const layer = (overrides: AdapterOverrides = {}) =>
  Layer.succeed(AiPort, { runTurn: runTurn(overrides) });
