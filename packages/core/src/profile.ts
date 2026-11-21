// Teaching profile (plan A6): data with a schema. The default profile lives in `agent`.
import { Schema } from 'effect';

/** Integer >= 1. */
export const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

/** Agent roles that have a prompt of their own. */
export const AgentRole = Schema.Literals(['prober', 'teacher', 'sideChat']);
export type AgentRole = typeof AgentRole.Type;

export const TeachingProfile = Schema.Struct({
  /** Stable id so a session can say which profile it was started with. */
  id: Schema.NonEmptyString,
  /** Language the agents teach in, a BCP 47 tag such as `vi` or `en`. */
  language: Schema.NonEmptyString,
  /** N: the Prober asks at most this many questions before it must submit an assessment. */
  maxProbeQuestions: PositiveInt,
  /** M: after this many turns on one step the learner may skip it. */
  maxTurnsPerStep: PositiveInt,
  /** System prompt per role. */
  prompts: Schema.Struct({
    prober: Schema.NonEmptyString,
    teacher: Schema.NonEmptyString,
    sideChat: Schema.NonEmptyString,
  }),
});
export type TeachingProfile = typeof TeachingProfile.Type;
