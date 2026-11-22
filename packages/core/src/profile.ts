// Teaching profile (plan A6, phase 3 A2): data with a schema. The default profile lives in `agent`.
//
// Compatibility rule (phase 3 A2): every `SessionCreated` ever written holds a snapshot of the
// profile of its time. A field added later is always optional, and a missing field takes the value
// of the default profile (`resolveProfile` in `agent`). Never make an existing field required or
// change what it means.
import { Schema } from 'effect';

/** Integer >= 1. */
export const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

/** Agent roles that have a prompt of their own. */
export const AgentRole = Schema.Literals([
  'prober',
  'teacher',
  'sideChat',
  /** Writes and grades exercises (phase 3 A6, A7). */
  'practitioner',
  /** Extraction: extractor, auditor and merge share this role's model (phase 3 A3, A5). */
  'extractor',
  /** Web research: queries and summary share this role's model (phase 4 A5). */
  'researcher',
]);
export type AgentRole = typeof AgentRole.Type;

/** Keys of `prompts`. Extraction has three prompts on one model role. */
export const PromptKey = Schema.Literals([
  'prober',
  'teacher',
  'sideChat',
  'practitioner',
  'extractor',
  'auditor',
  'merge',
  'researchQueries',
  'researchSummary',
]);
export type PromptKey = typeof PromptKey.Type;

export const TeachingProfile = Schema.Struct({
  /** Stable id so a session can say which profile it was started with. */
  id: Schema.NonEmptyString,
  /** Shown in the profile list (phase 3). Absent: the id. */
  name: Schema.optionalKey(Schema.String),
  /** Language the agents teach in, a BCP 47 tag such as `vi` or `en`. */
  language: Schema.NonEmptyString,
  /** N: the Prober asks at most this many questions before it must submit an assessment. */
  maxProbeQuestions: PositiveInt,
  /** M: after this many turns on one step the learner may skip it. */
  maxTurnsPerStep: PositiveInt,
  /** System prompt per role. The phase 3 prompts are optional (see the compatibility rule). */
  prompts: Schema.Struct({
    prober: Schema.NonEmptyString,
    teacher: Schema.NonEmptyString,
    sideChat: Schema.NonEmptyString,
    practitioner: Schema.optionalKey(Schema.NonEmptyString),
    extractor: Schema.optionalKey(Schema.NonEmptyString),
    auditor: Schema.optionalKey(Schema.NonEmptyString),
    merge: Schema.optionalKey(Schema.NonEmptyString),
    researchQueries: Schema.optionalKey(Schema.NonEmptyString),
    researchSummary: Schema.optionalKey(Schema.NonEmptyString),
  }),
});
export type TeachingProfile = typeof TeachingProfile.Type;

/** A profile with every optional field filled in: what the agents actually run with. */
export type ResolvedProfile = TeachingProfile & {
  readonly name: string;
  readonly prompts: Readonly<Record<PromptKey, string>>;
};

// Limits of a profile a person saves (phase 3 A2). Only for saving: the event schema above stays
// as loose as it was, so an old log is never rejected because of a limit added later.

/** Longest prompt a saved profile may hold, in UTF-16 code units. */
export const MAX_PROMPT_LENGTH = 20_000;
export const MAX_PROFILE_NAME_LENGTH = 100;
export const MAX_PROFILE_ID_LENGTH = 64;
/** Upper bounds of N and M in a saved profile. */
export const MAX_PROBE_QUESTIONS = 20;
export const MAX_TURNS_PER_STEP = 50;

const Prompt = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_PROMPT_LENGTH));

/** A profile a person saved (guest DB, account API). Stricter than `TeachingProfile`. */
export const SavedProfile = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/)),
  name: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(MAX_PROFILE_NAME_LENGTH))),
  language: Schema.String.check(Schema.isPattern(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8}){0,3}$/)),
  maxProbeQuestions: Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: MAX_PROBE_QUESTIONS }),
  ),
  maxTurnsPerStep: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_TURNS_PER_STEP })),
  prompts: Schema.Struct({
    prober: Prompt,
    teacher: Prompt,
    sideChat: Prompt,
    practitioner: Schema.optionalKey(Prompt),
    extractor: Schema.optionalKey(Prompt),
    auditor: Schema.optionalKey(Prompt),
    merge: Schema.optionalKey(Prompt),
    researchQueries: Schema.optionalKey(Prompt),
    researchSummary: Schema.optionalKey(Prompt),
  }),
});
export type SavedProfile = typeof SavedProfile.Type;
