// The turn loop (plan A1-A4). Input: the event log (its last turn is open, written by the client
// before the request, plan A3). Output: a stream the server maps to SSE frames:
//   Delta -> `delta`, Event -> `event`, Error -> `error`, Done -> `done`.
// A provider failure is an `Error` output plus a `TurnFailed` event, not a failed stream, so the
// client always gets a complete, storable record. The stream fails only when the log itself is bad.
import { Clock, Data, Effect, Result, Stream } from 'effect';
import { AiPort } from '@kd-learn/ai/port';
import type { AiError, ModelRef, TurnEvent } from '@kd-learn/ai/port';
import {
  figureMarker,
  findInterruptedTurn,
  keepKnownFigureMarkers,
  projectSession,
} from '@kd-learn/core';
import type {
  DomainEvent,
  EventLog,
  FigureBody,
  FinishReason,
  Session,
  SourceSlice,
} from '@kd-learn/core';
import { figureTools, makeFigureQueue } from './figures.ts';
import type { FigureOptions } from './figures.ts';
import { resolveProfile } from './profile.ts';
import { mainSystem, toMessages } from './context.ts';
import { historyForModel, resolveCitations, sourceBlock } from './sources.ts';
import { toolsFor } from './tools.ts';
import type { ToolContext } from './tools.ts';

/** A failure the client can show. Never contains the API key. */
export interface FailureInfo {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export type AgentOutput =
  /** Live text of the assistant message `messageId`. Display only; not stored. */
  | { readonly _tag: 'Delta'; readonly messageId: string; readonly delta: string }
  /**
   * The body of a figure of this turn (phase 5 A1). Comes just before the events, only when the turn
   * completes; the writer stores it in the same batch as its `FigureAdded`.
   */
  | { readonly _tag: 'Figure'; readonly figure: FigureBody }
  /** A complete domain event. The client appends it to its log. */
  | { readonly _tag: 'Event'; readonly event: DomainEvent }
  /** The turn failed. Follows the `TurnFailed` / `SideTurnFailed` event that records it. */
  | { readonly _tag: 'Error'; readonly error: FailureInfo }
  /** Always the last output. */
  | { readonly _tag: 'Done'; readonly outcome: 'completed' | 'failed' };

/** The log or request cannot start a turn. No events are produced. */
export class InvalidTurn extends Data.TaggedError('InvalidTurn')<{ readonly message: string }> {}

export interface TurnParams {
  /** The whole event log of the session, ending with the open `TurnStarted`. */
  readonly log: EventLog;
  readonly model: ModelRef;
  /** Id generator for new events and messages (core and agent have no random source). */
  readonly newId: () => string;
  /** Upper bound on model calls inside the turn. Default 6. */
  readonly maxSteps?: number;
  /** Chunks of the attached sources for this turn (phase 4 A3), already cut to the byte budget. */
  readonly sourceSlice?: SourceSlice;
  /** Figure tools the server allows (phase 5). Absent: the Teacher gets none. */
  readonly figures?: FigureOptions;
}

/** Name used in `UsageRecorded`. */
export const modelName = (model: ModelRef): string =>
  model.provider === 'acp' ? (model.model ?? model.agent) : model.model;

const AUTH_PATTERN = /auth|api[_ -]?key|401|403|permission|forbidden|invalid_request|\b400\b/i;

/** Maps a port error to a failure record, and removes the key from the text (plan A7). */
export const failureOf = (error: AiError, model: ModelRef): FailureInfo => {
  const key = 'apiKey' in model ? model.apiKey : undefined;
  const message =
    key && key.length >= 8 ? error.message.split(key).join('[redacted]') : error.message;
  if (error._tag === 'OutputInvalid') {
    return { code: 'OutputInvalid', message, retryable: true };
  }
  const code = error.code ?? 'ProviderError';
  return {
    code,
    message,
    retryable: error.retryAfterMs !== undefined || !AUTH_PATTERN.test(`${code} ${message}`),
  };
};

/** Collects the pieces of one model run: merged text, summed usage, last finish reason. */
export interface RunCollector {
  readonly observe: (event: TurnEvent) => ReadonlyArray<string>;
  readonly text: () => string;
  readonly usage: () => { readonly inputTokens: number; readonly outputTokens: number };
  readonly finish: () => FinishReason;
}

/**
 * `takeMarkers` (phase 5 A1): figure ids whose marker goes into the text when the tool result that
 * produced them arrives, so the figure sits where the model called the tool.
 */
export const makeCollector = (
  takeMarkers: () => ReadonlyArray<string> = () => [],
): RunCollector => {
  let text = '';
  let lastSource: string | undefined;
  let inputTokens = 0;
  let outputTokens = 0;
  let finish: FinishReason = 'unknown';
  return {
    // Returns the deltas to show. A new provider message (after a tool call) starts a new paragraph.
    observe: (event) => {
      switch (event._tag) {
        case 'TextDelta': {
          const separator =
            lastSource !== undefined && lastSource !== event.messageId ? '\n\n' : '';
          lastSource = event.messageId;
          const delta = `${separator}${event.delta}`;
          text += delta;
          return [delta];
        }
        case 'Usage':
          inputTokens += event.inputTokens;
          outputTokens += event.outputTokens;
          return [];
        case 'Finish':
          finish = event.reason;
          return [];
        case 'ToolResult': {
          const ids = takeMarkers();
          if (ids.length === 0) return [];
          const delta = ids.map((id) => `\n\n${figureMarker(id)}\n\n`).join('');
          text += delta;
          return [delta];
        }
        default:
          return [];
      }
    },
    text: () => text,
    usage: () => ({ inputTokens, outputTokens }),
    finish: () => finish,
  };
};

const fromIterable = <A>(items: Iterable<A>) => Stream.fromIterable(items);

/** The open turn at the end of the log, or why there is none. */
const openTurnOf = (session: Session): Result.Result<{ turnId: string; input: string }, string> => {
  const turn = findInterruptedTurn(session);
  return turn === undefined
    ? Result.fail('The log must end with a TurnStarted whose turn is still open.')
    : Result.succeed({ turnId: turn.turnId, input: turn.input });
};

/**
 * Runs one turn of the main thread for the session in `log`, using the agent of the current state
 * (Prober while probing, Teacher after) and the tools of that state.
 *
 * Events are produced when the turn ends, in this order: `MessageAppended`, the tool events
 * (`AssessmentRecorded`, `PlanCreated`, `StepCompleted`, `SessionCompleted`), `UsageRecorded`,
 * `TurnCompleted`. If the model call fails, the output is only `UsageRecorded` (if any tokens were
 * spent) and `TurnFailed`: partial text and tool events are dropped, so a retry starts clean.
 */
export const runTurn = (params: TurnParams): Stream.Stream<AgentOutput, InvalidTurn, AiPort> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const projected = projectSession(params.log);
      if (Result.isFailure(projected)) {
        return Stream.fail(new InvalidTurn({ message: projected.failure.message }));
      }
      const session = projected.success;
      const open = openTurnOf(session);
      if (Result.isFailure(open)) return Stream.fail(new InvalidTurn({ message: open.failure }));
      if (session.state._tag === 'Done') {
        return Stream.fail(new InvalidTurn({ message: 'The session is already done.' }));
      }
      if (session.state._tag === 'Teaching' && session.state.stepId === undefined) {
        return Stream.fail(
          new InvalidTurn({ message: 'Every step is resolved but SessionCompleted is missing.' }),
        );
      }
      const { turnId, input } = open.success;
      const ai = yield* AiPort;

      const ctx: ToolContext = { log: params.log, turnId, newId: params.newId, pending: [] };
      const figures = makeFigureQueue();
      const takeMarkers = () => figures.markers.splice(0);
      const collector = makeCollector(takeMarkers);
      const messageId = params.newId();
      const agent = session.state._tag === 'Probing' ? 'prober' : 'teacher';
      const stamp = (at: number) => ({ id: params.newId(), at });

      const slice = params.sourceSlice ?? [];
      const references = sourceBlock(slice);
      const live = ai
        .runTurn({
          model: params.model,
          system:
            references === '' ? mainSystem(session) : `${mainSystem(session)}\n\n${references}`,
          messages: toMessages([...historyForModel(session), { role: 'user', content: input }]),
          tools: [
            ...toolsFor(session, ctx),
            ...(session.state._tag === 'Teaching'
              ? figureTools(ctx, figures, resolveProfile(session.profile), params.figures)
              : []),
          ],
          maxSteps: params.maxSteps ?? 6,
        })
        .pipe(
          Stream.flatMap((event) =>
            fromIterable(
              collector
                .observe(event)
                .map((delta): AgentOutput => ({ _tag: 'Delta', messageId, delta })),
            ),
          ),
        );

      const usageEvent = (at: number): ReadonlyArray<DomainEvent> => {
        const usage = collector.usage();
        return usage.inputTokens + usage.outputTokens === 0
          ? []
          : [
              {
                _tag: 'UsageRecorded',
                ...stamp(at),
                turnId,
                model: modelName(params.model),
                ...usage,
              },
            ];
      };

      const completed = Stream.unwrap(
        Effect.map(Clock.currentTimeMillis, (at) => {
          // Markers of figures whose tool result never came through go at the end.
          const late = takeMarkers()
            .map((id) => `\n\n${figureMarker(id)}`)
            .join('');
          const known = new Set(figures.bodies.map((body) => body.figureId));
          const { content: text, citations } = resolveCitations(
            keepKnownFigureMarkers(`${collector.text()}${late}`, known),
            slice,
          );
          const events: Array<DomainEvent> = [
            ...(text.trim() === ''
              ? []
              : [
                  {
                    _tag: 'MessageAppended',
                    ...stamp(at),
                    turnId,
                    messageId,
                    agent,
                    content: text,
                    ...(citations.length === 0 ? {} : { citations }),
                  } satisfies DomainEvent,
                ]),
            ...ctx.pending,
            ...usageEvent(at),
            {
              _tag: 'TurnCompleted',
              ...stamp(at),
              turnId,
              reason: collector.finish(),
              ...(slice.length === 0
                ? {}
                : { sourceRefs: slice.map(({ sourceId, ordinal }) => ({ sourceId, ordinal })) }),
            },
          ];
          return fromIterable<AgentOutput>([
            ...figures.bodies.map((figure): AgentOutput => ({ _tag: 'Figure', figure })),
            ...events.map((event): AgentOutput => ({ _tag: 'Event', event })),
            { _tag: 'Done', outcome: 'completed' },
          ]);
        }),
      );

      const failed = (error: AiError) =>
        Stream.unwrap(
          Effect.map(Clock.currentTimeMillis, (at) => {
            const failure = failureOf(error, params.model);
            const events: ReadonlyArray<DomainEvent> = [
              ...usageEvent(at),
              { _tag: 'TurnFailed', ...stamp(at), turnId, ...failure },
            ];
            return fromIterable<AgentOutput>([
              ...events.map((event): AgentOutput => ({ _tag: 'Event', event })),
              { _tag: 'Error', error: failure },
              { _tag: 'Done', outcome: 'failed' },
            ]);
          }),
        );

      return live.pipe(Stream.concat(completed), Stream.catch(failed));
    }),
  );
