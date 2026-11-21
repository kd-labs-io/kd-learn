import { Result, Schema } from 'effect';
import { describe, expect, it } from 'vitest';
import { EventLog } from './event.ts';
import { phase2Session } from './fixtures/phase-2-session.ts';
import { MAX_PROMPT_LENGTH, SavedProfile, TeachingProfile } from './profile.ts';
import { projectSession } from './session.ts';

const base = {
  id: 'mine',
  language: 'vi',
  maxProbeQuestions: 3,
  maxTurnsPerStep: 5,
  prompts: { prober: 'p', teacher: 't', sideChat: 's' },
};

describe('teaching profile v2 (phase 3 A2)', () => {
  it('still decodes and projects a phase 1-2 log', () => {
    const log = Schema.decodeUnknownSync(EventLog)(phase2Session);
    const first = log[0];
    expect(first?._tag).toBe('SessionCreated');
    if (first?._tag === 'SessionCreated')
      expect(first.profile.prompts.practitioner).toBeUndefined();
    const session = projectSession(log);
    expect(Result.isSuccess(session)).toBe(true);
    if (Result.isSuccess(session)) expect(session.success.state._tag).toBe('Done');
  });

  it('accepts the phase 3 prompts as optional fields', () => {
    const decoded = Schema.decodeUnknownSync(TeachingProfile)({
      ...base,
      name: 'Mine',
      prompts: { ...base.prompts, practitioner: 'x', merge: 'm' },
    });
    expect(decoded.prompts.merge).toBe('m');
  });

  it('keeps the event schema free of the saving limits', () => {
    const long = {
      ...base,
      prompts: { ...base.prompts, teacher: 'x'.repeat(MAX_PROMPT_LENGTH + 1) },
    };
    expect(Result.isSuccess(Schema.decodeUnknownResult(TeachingProfile)(long))).toBe(true);
    expect(Result.isFailure(Schema.decodeUnknownResult(SavedProfile)(long))).toBe(true);
  });

  it('rejects a saved profile out of bounds', () => {
    const bad = (patch: object) =>
      Result.isFailure(Schema.decodeUnknownResult(SavedProfile)({ ...base, ...patch }));
    expect(Result.isSuccess(Schema.decodeUnknownResult(SavedProfile)(base))).toBe(true);
    expect(bad({ id: 'has space' })).toBe(true);
    expect(bad({ language: 'not a tag' })).toBe(true);
    expect(bad({ maxProbeQuestions: 0 })).toBe(true);
    expect(bad({ maxTurnsPerStep: 51 })).toBe(true);
    expect(bad({ prompts: { ...base.prompts, sideChat: '' } })).toBe(true);
    expect(bad({ name: 'n'.repeat(101) })).toBe(true);
  });
});
