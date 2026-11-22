import {
  MAX_PROBE_QUESTIONS,
  MAX_PROFILE_NAME_LENGTH,
  MAX_PROMPT_LENGTH,
  MAX_TURNS_PER_STEP,
  SavedProfile,
  type FigureSettings,
  type PromptKey,
} from '@kd-learn/core';
import { m } from '@kd-learn/i18n';
import { Schema } from 'effect';

// Kept out of ProfileScreen so unit tests can import it without the UI (StyleX needs its compiler).

/** What the form edits: every prompt filled in, the name as text (blank means none). */
export interface ProfileForm {
  readonly id: string;
  readonly name: string;
  readonly language: string;
  readonly maxProbeQuestions: number;
  readonly maxTurnsPerStep: number;
  readonly figures: FigureSettings;
  readonly prompts: Record<PromptKey, string>;
}

export const toSaved = (form: ProfileForm): SavedProfile => {
  const name = form.name.trim();
  return {
    id: form.id,
    ...(name === '' ? {} : { name }),
    language: form.language.trim(),
    maxProbeQuestions: form.maxProbeQuestions,
    maxTurnsPerStep: form.maxTurnsPerStep,
    figures: form.figures,
    prompts: form.prompts,
  };
};

const standard = Schema.toStandardSchemaV1(SavedProfile, { parseOptions: { errors: 'all' } });

/** Our message for a field the schema rejects, by its path in the form. */
const messageFor = (path: string): string => {
  if (path === 'name') return m.profile_error_name({ max: MAX_PROFILE_NAME_LENGTH });
  if (path === 'language') return m.profile_error_language();
  if (path === 'maxProbeQuestions') return m.profile_error_range({ max: MAX_PROBE_QUESTIONS });
  if (path === 'maxTurnsPerStep') return m.profile_error_range({ max: MAX_TURNS_PER_STEP });
  return m.profile_error_prompt({ max: MAX_PROMPT_LENGTH });
};

/** Field errors of a form value, keyed by path (`prompts.teacher`). Empty when it can be saved. */
export function validateProfile(form: ProfileForm): Record<string, string> {
  const result = standard['~standard'].validate(toSaved(form));
  if (result instanceof Promise || result.issues === undefined) return {};
  const fields: Record<string, string> = {};
  for (const issue of result.issues) {
    const path = (issue.path ?? [])
      .map((part) => String(typeof part === 'object' ? part.key : part))
      .join('.');
    fields[path] ??= messageFor(path);
  }
  return fields;
}
