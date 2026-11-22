// Web research (plan nguon-hoc.md A5, A7).
//
// - Guest and demo: `POST /api/research` takes `ResearchRequest` and streams SSE frames `result` or
//   `error`, then `done`. Without state: the client stores the source (`kind: 'web'`) in one batch.
// - Accounts: `POST /api/account/research` takes `CreateResearchRequest` and answers 202 with the
//   `pending` source; the job `research` makes it `ready` or `failed`.
//
// `provider` is one of `GET /api/search/options` for the caller's mode; any other is refused.
import { Schema } from 'effect';
import { SavedProfile, SourceChunk, SourceTitle } from '@kd-learn/core';
import { DoneFrame, ErrorFrame, ModelChoice, SearchProvider } from './contract.ts';

export const RESEARCH_PATH = '/api/research';
export const ACCOUNT_RESEARCH_PATH = '/api/account/research';

/** Longest research question (A5). */
export const MAX_RESEARCH_QUESTION = 500;

const Question = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_RESEARCH_QUESTION),
);
const LanguageTag = Schema.String.check(
  Schema.isPattern(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8}){0,3}$/),
);

export const ResearchRequest = Schema.Struct({
  model: ModelChoice,
  question: Question,
  /** Language of the summary and of the searches. */
  language: LanguageTag,
  provider: SearchProvider,
  /** The profile in use (research prompts). Absent: the default. Ignored in demo mode. */
  profile: Schema.optionalKey(SavedProfile),
});
export type ResearchRequest = typeof ResearchRequest.Type;

/** The source to store: summary then results (`chunkWeb`), ordinals from 0. */
export const ResearchResultFrame = Schema.TaggedStruct('result', {
  title: SourceTitle,
  chunks: Schema.Array(SourceChunk),
  queries: Schema.Array(Schema.String),
});

export const ResearchFrame = Schema.Union([ResearchResultFrame, ErrorFrame, DoneFrame]);
export type ResearchFrame = typeof ResearchFrame.Type;

export const CreateResearchRequest = Schema.Struct({
  question: Question,
  language: LanguageTag,
  provider: SearchProvider,
  /** Attach the source to this lesson once it is ready (research at lesson creation, A5). */
  sessionId: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64))),
});
export type CreateResearchRequest = typeof CreateResearchRequest.Type;

/**
 * `origin` of a `web` source: what the research asked, as JSON, so a failed or interrupted one can
 * run again with the same question, language and search source.
 */
export const WebOrigin = Schema.Struct({
  question: Question,
  language: LanguageTag,
  provider: SearchProvider,
});
export type WebOrigin = typeof WebOrigin.Type;

export const webOrigin = (origin: WebOrigin): string =>
  JSON.stringify(Schema.encodeSync(WebOrigin)(origin));

/** Undefined when `origin` is not a research origin. */
export const parseWebOrigin = (origin: string): WebOrigin | undefined => {
  try {
    return Schema.decodeUnknownSync(WebOrigin)(JSON.parse(origin));
  } catch {
    return undefined;
  }
};
