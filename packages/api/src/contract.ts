// The HTTP contract between the client (browser, Capacitor) and the server (plan A1, A6).
// Plain data, no IO: the server decodes requests and encodes frames with these schemas, the
// client does the opposite, and neither side hand-writes JSON shapes.
import { Schema } from 'effect';
import { DomainEvent, EventLog } from '@kd-learn/core';

export const TURNS_PATH = '/api/turns';
export const ENDPOINTS_PATH = '/api/endpoints';

const Secret = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512));
const ModelName = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));

/** Id of an OpenAI-compatible endpoint the server admin allows (plan A6, risk 6). */
export const EndpointId = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9_-]{0,63}$/));
export type EndpointId = typeof EndpointId.Type;

/**
 * Which model serves the turn, chosen by the guest: provider, model and the guest's own key.
 * An OpenAI-compatible endpoint is chosen by id only. There is deliberately no `baseURL` field,
 * and the server rejects a request that carries one (risk 6: SSRF). ACP is account mode only.
 */
export const ModelChoice = Schema.Union([
  Schema.Struct({
    provider: Schema.Literal('anthropic'),
    model: ModelName,
    apiKey: Secret,
  }),
  Schema.Struct({
    provider: Schema.Literal('gemini'),
    model: ModelName,
    apiKey: Secret,
  }),
  Schema.Struct({
    provider: Schema.Literal('openai-compatible'),
    endpointId: EndpointId,
    model: ModelName,
    apiKey: Secret,
  }),
]);
export type ModelChoice = typeof ModelChoice.Type;

/** The main thread, or a side chat thread (plan A5). */
export const TurnSelector = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('main') }),
  Schema.Struct({ kind: Schema.Literal('side'), threadId: Schema.NonEmptyString }),
]);
export type TurnSelector = typeof TurnSelector.Type;

/**
 * `POST /api/turns`. The log ends with the open `TurnStarted` (main) or the learner's
 * `SideMessageAppended` (side), written by the client before the request (plan A3).
 * Decode with `onExcessProperty: 'error'` so unknown fields are rejected, not dropped.
 */
export const TurnRequest = Schema.Struct({
  model: ModelChoice,
  turn: TurnSelector,
  log: EventLog,
});
export type TurnRequest = typeof TurnRequest.Type;

/** A failure the client can show. Never contains a key (plan A7). */
export const Failure = Schema.Struct({
  code: Schema.NonEmptyString,
  message: Schema.String,
  retryable: Schema.Boolean,
});
export type Failure = typeof Failure.Type;

/**
 * Codes the server itself produces. Provider failures carry the provider's own code
 * (or `ProviderError`), so `Failure.code` stays a plain string.
 */
export const ErrorCode = {
  InvalidRequest: 'InvalidRequest',
  HistoryTooLarge: 'HistoryTooLarge',
  UnknownEndpoint: 'UnknownEndpoint',
  InvalidTurn: 'InvalidTurn',
  MethodNotAllowed: 'MethodNotAllowed',
  Misconfigured: 'ServerMisconfigured',
  Internal: 'InternalError',
} as const;

/** Body of a response that is not a stream (HTTP 4xx and 5xx). */
export const ErrorBody = Schema.Struct({ error: Failure });
export type ErrorBody = typeof ErrorBody.Type;

/** Live text of the assistant message `messageId`. Display only; the client does not store it. */
export const DeltaFrame = Schema.TaggedStruct('delta', {
  messageId: Schema.NonEmptyString,
  delta: Schema.String,
});

/** One complete domain event. The client appends it to its local log, in order. */
export const EventFrame = Schema.TaggedStruct('event', { event: DomainEvent });

/** The turn failed. Follows the `TurnFailed` / `SideTurnFailed` event when the model call failed. */
export const ErrorFrame = Schema.TaggedStruct('error', { error: Failure });

/** Always the last frame of a stream. */
export const DoneFrame = Schema.TaggedStruct('done', {
  outcome: Schema.Literals(['completed', 'failed']),
});

export const Frame = Schema.Union([DeltaFrame, EventFrame, ErrorFrame, DoneFrame]);
export type Frame = typeof Frame.Type;

/** An OpenAI-compatible endpoint the guest may pick. The base URL stays on the server. */
export const EndpointInfo = Schema.Struct({ id: EndpointId, label: Schema.NonEmptyString });
export type EndpointInfo = typeof EndpointInfo.Type;

/** `GET /api/endpoints`. */
export const EndpointsResponse = Schema.Struct({ endpoints: Schema.Array(EndpointInfo) });
export type EndpointsResponse = typeof EndpointsResponse.Type;
