// AI port (plan 3.3): "run one turn with this toolset, return a stream of events".
// Pure: only `effect` is imported here, so `packages/agent` may depend on it.
import { Context, Data, Effect, Schema, Stream } from 'effect';

/** Which backend and model serve a turn. Keys come from the caller (guest) or the server store (account). */
export type ModelRef =
  | { readonly provider: 'anthropic'; readonly model: string; readonly apiKey: string }
  | { readonly provider: 'gemini'; readonly model: string; readonly apiKey: string }
  | {
      readonly provider: 'openai-compatible';
      readonly model: string;
      readonly apiKey: string;
      readonly baseURL: string;
    }
  | {
      /** An agent CLI driven over ACP. Auth comes from the agent's own login on the server. */
      readonly provider: 'acp';
      readonly agent: 'claude-code' | 'antigravity' | 'opencode';
      readonly model?: string;
      /** Optional key for agents that accept one (Antigravity: Gemini API key). */
      readonly apiKey?: string;
    };

export interface Message {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

/** A tool the model may call. Input is decoded with Effect Schema before `run`. */
export interface ToolSpec<I = never, O = unknown> {
  readonly name: string;
  readonly description: string;
  readonly input: Schema.Codec<I, unknown>;
  readonly run: (input: I) => Effect.Effect<O, ToolError>;
}

/** Helper that keeps the input type of `run` tied to the schema. */
export const tool = <I, O>(spec: ToolSpec<I, O>): ToolSpec<I, O> => spec;

export interface TurnRequest<A = never> {
  readonly model: ModelRef;
  readonly system?: string;
  readonly messages: ReadonlyArray<Message>;
  // `any` input: a list of tools has a different input type per entry.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly tools?: ReadonlyArray<ToolSpec<any, unknown>>;
  /** When set, the turn ends with one `StructuredResult` decoded with this schema. */
  readonly output?: Schema.Codec<A, unknown>;
  /** Upper bound on model calls in the tool loop. */
  readonly maxSteps?: number;
}

export type FinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'unknown';

export type TurnEvent<A = never> =
  | { readonly _tag: 'TextDelta'; readonly messageId: string; readonly delta: string }
  | {
      readonly _tag: 'ToolCall';
      readonly id: string;
      readonly name: string;
      readonly input: unknown;
    }
  | { readonly _tag: 'ToolResult'; readonly id: string; readonly output: string }
  | { readonly _tag: 'StructuredResult'; readonly value: A }
  | { readonly _tag: 'Usage'; readonly inputTokens: number; readonly outputTokens: number }
  | { readonly _tag: 'Finish'; readonly reason: FinishReason };

/** The provider or agent failed (network, auth, rate limit, bad request). */
export class ProviderError extends Data.TaggedError('ProviderError')<{
  readonly message: string;
  readonly code?: string;
  readonly retryAfterMs?: number;
}> {}

/** The model returned a structured result that does not match `output`. */
export class OutputInvalid extends Data.TaggedError('OutputInvalid')<{
  readonly message: string;
  readonly raw: string;
}> {}

/** A tool failed. The message is sent back to the model so it can recover. */
export class ToolError extends Data.TaggedError('ToolError')<{ readonly message: string }> {}

export type AiError = ProviderError | OutputInvalid;

export class AiPort extends Context.Service<
  AiPort,
  {
    /** Interrupting the stream cancels the request to the provider or agent. */
    readonly runTurn: <A = never>(request: TurnRequest<A>) => Stream.Stream<TurnEvent<A>, AiError>;
  }
>()('@kd-learn/ai/AiPort') {}
