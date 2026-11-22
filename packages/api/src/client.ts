// Typed client for the contract: `fetch` plus SSE parsing. Runs in the browser and in Node.
// Interrupting the returned stream aborts the request, which makes the server cancel the turn
// and the provider request (plan 3.3).
import { Data, Effect, Schema, Stream } from 'effect';
import {
  ENDPOINTS_PATH,
  EndpointsResponse,
  ErrorBody,
  ErrorCode,
  EXTRACT_PATH,
  ExtractFrame,
  ExtractRequest,
  Frame,
  SEARCH_OPTIONS_PATH,
  SearchOptions,
  TURNS_PATH,
  TurnRequest,
} from './contract.ts';
import { RESEARCH_PATH, ResearchFrame, ResearchRequest, ResearchResultFrame } from './research.ts';
import type { EndpointInfo, Failure } from './contract.ts';
import type { KnowledgeEvent } from '@kd-learn/core';
import { makeSseParser } from './sse.ts';

/**
 * The request did not reach the server (`Network`) or the response is not a valid stream
 * (`Protocol`), including a stream that ended without a `done` frame (the turn was cut off).
 */
export class ClientError extends Data.TaggedError('ClientError')<{
  readonly reason: 'Network' | 'Protocol';
  readonly message: string;
}> {}

export interface ClientOptions {
  /** Origin of the server, e.g. `https://learn.example.com`. Empty means same origin (web build). */
  readonly baseUrl?: string;
  /** Custom `fetch` (tests, native HTTP). Defaults to the global one. */
  readonly fetch?: typeof fetch;
}

const urlOf = (options: ClientOptions, path: string) =>
  `${(options.baseUrl ?? '').replace(/\/+$/, '')}${path}`;

const network = (error: unknown) =>
  new ClientError({
    reason: 'Network',
    message: error instanceof Error ? error.message : 'Network request failed.',
  });

const protocol = (message: string) => new ClientError({ reason: 'Protocol', message });

/** An HTTP error response as the frames a stream would have carried, so callers have one path. */
const unexpected = (status: number): Failure => ({
  code: ErrorCode.Internal,
  message: `Unexpected response (HTTP ${status}).`,
  retryable: status >= 500,
});

const errorFrames = (response: Response): Effect.Effect<ReadonlyArray<Frame>, ClientError> =>
  Effect.tryPromise({ try: () => response.json() as Promise<unknown>, catch: network }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(ErrorBody)),
    Effect.map(({ error }): ReadonlyArray<Frame> => [
      { _tag: 'error', error },
      { _tag: 'done', outcome: 'failed' },
    ]),
    Effect.catch(() =>
      Effect.succeed<ReadonlyArray<Frame>>([
        {
          _tag: 'error',
          error: {
            code: ErrorCode.Internal,
            message: `Unexpected response (HTTP ${response.status}).`,
            retryable: response.status >= 500,
          },
        },
        { _tag: 'done', outcome: 'failed' },
      ]),
    ),
  );

async function* messages(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = makeSseParser();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      yield* parser.push(decoder.decode(value, { stream: true }));
    }
    yield* parser.push(`${decoder.decode()}\n\n`);
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

const decodeFrame = (data: string): Effect.Effect<Frame, ClientError> =>
  Effect.try({
    try: () => JSON.parse(data) as unknown,
    catch: () => protocol('Frame is not JSON.'),
  }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Frame)),
    Effect.mapError((error) =>
      error instanceof ClientError ? error : protocol('Frame does not match the contract.'),
    ),
  );

/**
 * Starts a turn and streams its frames. A response that is not a stream (HTTP error) becomes an
 * `error` frame followed by `done`, so callers handle failures in one place. The stream fails with
 * `ClientError` only for transport problems.
 */
export const streamTurn = (
  request: TurnRequest,
  options: ClientOptions = {},
): Stream.Stream<Frame, ClientError> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const controller = yield* Effect.acquireRelease(
        Effect.sync(() => new AbortController()),
        (c) => Effect.sync(() => c.abort()),
      );
      const doFetch = options.fetch ?? globalThis.fetch;
      const response = yield* Effect.tryPromise({
        try: () =>
          doFetch(urlOf(options, TURNS_PATH), {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
            body: JSON.stringify(Schema.encodeSync(TurnRequest)(request)),
            signal: controller.signal,
          }),
        catch: network,
      });
      if (!response.ok || response.body === null) {
        return response.ok
          ? Stream.fail(protocol('The response has no body.'))
          : Stream.fromIterableEffect(errorFrames(response));
      }
      let sawDone = false;
      return Stream.fromAsyncIterable(messages(response.body), network).pipe(
        Stream.mapEffect((message) =>
          decodeFrame(message.data).pipe(
            Effect.tap((frame) =>
              Effect.sync(() => {
                if (frame._tag === 'done') sawDone = true;
              }),
            ),
          ),
        ),
        Stream.concat(
          Stream.suspend(() =>
            sawDone ? Stream.empty : Stream.fail(protocol('The stream ended before `done`.')),
          ),
        ),
      );
    }),
  );

export type ExtractOutcome =
  | { readonly _tag: 'Extracted'; readonly events: ReadonlyArray<KnowledgeEvent> }
  | { readonly _tag: 'Failed'; readonly error: Failure };

/**
 * `POST /api/knowledge/extract` (guest, demo). Waits for the whole result: an extraction streams no
 * text. An HTTP error or an `error` frame is `Failed`; the effect fails with `ClientError` only for
 * transport problems, including a stream cut before `done`. Interrupting it aborts the request.
 */
export const extractSession = (
  request: ExtractRequest,
  options: ClientOptions = {},
): Effect.Effect<ExtractOutcome, ClientError> =>
  Effect.tryPromise({
    // One promise for the request and the body, so interrupting aborts either.
    try: async (signal): Promise<ExtractOutcome | ClientError> => {
      const doFetch = options.fetch ?? globalThis.fetch;
      const response = await doFetch(urlOf(options, EXTRACT_PATH), {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify(Schema.encodeSync(ExtractRequest)(request)),
        signal,
      });
      if (!response.ok) {
        const [first] = await Effect.runPromise(errorFrames(response));
        return {
          _tag: 'Failed',
          error: first?._tag === 'error' ? first.error : unexpected(response.status),
        };
      }
      if (response.body === null) return protocol('The response has no body.');
      let outcome: ExtractOutcome | undefined;
      for await (const message of messages(response.body)) {
        let frame: ExtractFrame;
        try {
          frame = Schema.decodeUnknownSync(ExtractFrame)(JSON.parse(message.data));
        } catch {
          return protocol('Frame does not match the contract.');
        }
        if (frame._tag === 'result') outcome = { _tag: 'Extracted', events: frame.events };
        else if (frame._tag === 'error') outcome = { _tag: 'Failed', error: frame.error };
        else return outcome ?? protocol('The stream ended without a result.');
      }
      return protocol('The stream ended before `done`.');
    },
    catch: network,
  }).pipe(
    Effect.flatMap((result) =>
      result instanceof ClientError ? Effect.fail(result) : Effect.succeed(result),
    ),
  );

/** `GET /api/endpoints`: the OpenAI-compatible endpoints the guest may choose from. */
export const listEndpoints = (
  options: ClientOptions = {},
): Effect.Effect<ReadonlyArray<EndpointInfo>, ClientError> =>
  Effect.gen(function* () {
    const doFetch = options.fetch ?? globalThis.fetch;
    const response = yield* Effect.tryPromise({
      try: (signal) => doFetch(urlOf(options, ENDPOINTS_PATH), { signal }),
      catch: network,
    });
    if (!response.ok) return yield* Effect.fail(protocol(`HTTP ${response.status}.`));
    const json = yield* Effect.tryPromise({
      try: () => response.json() as Promise<unknown>,
      catch: network,
    });
    const decoded = yield* Schema.decodeUnknownEffect(EndpointsResponse)(json).pipe(
      Effect.mapError(() => protocol('Response does not match the contract.')),
    );
    return decoded.endpoints;
  });

export type ResearchOutcome =
  | {
      readonly _tag: 'Researched';
      readonly title: string;
      readonly chunks: (typeof ResearchResultFrame.Type)['chunks'];
    }
  | { readonly _tag: 'Failed'; readonly error: Failure };

/**
 * `POST /api/research` (guest, demo; phase 4 A5). Like `extractSession`: waits for the whole
 * result; an HTTP error or an `error` frame is `Failed`, transport problems fail the effect.
 */
export const researchWeb = (
  request: ResearchRequest,
  options: ClientOptions = {},
): Effect.Effect<ResearchOutcome, ClientError> =>
  Effect.tryPromise({
    try: async (signal): Promise<ResearchOutcome | ClientError> => {
      const doFetch = options.fetch ?? globalThis.fetch;
      const response = await doFetch(urlOf(options, RESEARCH_PATH), {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify(Schema.encodeSync(ResearchRequest)(request)),
        signal,
      });
      if (!response.ok) {
        const [first] = await Effect.runPromise(errorFrames(response));
        return {
          _tag: 'Failed',
          error: first?._tag === 'error' ? first.error : unexpected(response.status),
        };
      }
      if (response.body === null) return protocol('The response has no body.');
      let outcome: ResearchOutcome | undefined;
      for await (const message of messages(response.body)) {
        let frame: ResearchFrame;
        try {
          frame = Schema.decodeUnknownSync(ResearchFrame)(JSON.parse(message.data));
        } catch {
          return protocol('Frame does not match the contract.');
        }
        if (frame._tag === 'result') {
          outcome = { _tag: 'Researched', title: frame.title, chunks: frame.chunks };
        } else if (frame._tag === 'error') outcome = { _tag: 'Failed', error: frame.error };
        else return outcome ?? protocol('The stream ended without a result.');
      }
      return protocol('The stream ended before `done`.');
    },
    catch: network,
  }).pipe(
    Effect.flatMap((result) =>
      result instanceof ClientError ? Effect.fail(result) : Effect.succeed(result),
    ),
  );

/** `GET /api/search/options` for a guest (or `demo`): the search sources offered. */
export const searchOptions = (
  mode: 'guest' | 'demo',
  options: ClientOptions = {},
): Effect.Effect<SearchOptions['providers'], ClientError> =>
  Effect.gen(function* () {
    const doFetch = options.fetch ?? globalThis.fetch;
    const path = mode === 'demo' ? `${SEARCH_OPTIONS_PATH}?mode=demo` : SEARCH_OPTIONS_PATH;
    const response = yield* Effect.tryPromise({
      try: (signal) => doFetch(urlOf(options, path), { signal }),
      catch: network,
    });
    if (!response.ok) return yield* Effect.fail(protocol(`HTTP ${response.status}.`));
    const json = yield* Effect.tryPromise({
      try: () => response.json() as Promise<unknown>,
      catch: network,
    });
    const decoded = yield* Schema.decodeUnknownEffect(SearchOptions)(json).pipe(
      Effect.mapError(() => protocol('Response does not match the contract.')),
    );
    return decoded.providers;
  });
