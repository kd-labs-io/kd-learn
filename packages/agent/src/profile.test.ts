import { Schema } from 'effect';
import { describe, expect, it } from 'vitest';
import { SavedProfile, TeachingProfile } from '@kd-learn/core';
import { defaultProfile, resolveProfile } from './profile.ts';

describe('resolveProfile (phase 3 A2)', () => {
  it('fills the phase 3 prompts of an old snapshot from the default profile', () => {
    const old = {
      id: 'old',
      language: 'vi',
      maxProbeQuestions: 2,
      maxTurnsPerStep: 3,
      prompts: { prober: 'p', teacher: 't', sideChat: 's' },
    };
    const resolved = resolveProfile(old);
    expect(resolved.name).toBe('old');
    expect(resolved.prompts.teacher).toBe('t');
    expect(resolved.prompts.extractor).toBe(defaultProfile.prompts.extractor);
    expect(resolved.prompts.merge).toBe(defaultProfile.prompts.merge);
  });

  it('keeps prompts the profile sets', () => {
    const own = { ...defaultProfile, prompts: { ...defaultProfile.prompts, auditor: 'mine' } };
    expect(resolveProfile(own).prompts.auditor).toBe('mine');
  });

  it('ships a default profile that is valid as an event and as a saved profile', () => {
    expect(() => Schema.decodeUnknownSync(TeachingProfile)(defaultProfile)).not.toThrow();
    expect(() => Schema.decodeUnknownSync(SavedProfile)(defaultProfile)).not.toThrow();
  });
});
