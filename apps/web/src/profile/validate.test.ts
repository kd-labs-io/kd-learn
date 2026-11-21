import { defaultProfile } from '@kd-learn/agent/client';
import { MAX_PROMPT_LENGTH } from '@kd-learn/core';
import { describe, expect, it } from 'vitest';
import { validateProfile } from './ProfileScreen';

const form = {
  id: crypto.randomUUID(),
  name: 'Mine',
  language: 'vi',
  maxProbeQuestions: 4,
  maxTurnsPerStep: 6,
  prompts: { ...defaultProfile.prompts },
};

describe('validateProfile', () => {
  it('accepts a copy of the default profile with a fresh id and a blank name', () => {
    expect(validateProfile(form)).toEqual({});
    expect(validateProfile({ ...form, name: '  ' })).toEqual({});
  });

  it('reports every field outside the saving limits, by path', () => {
    const errors = validateProfile({
      ...form,
      id: 'default copy',
      language: 'not a tag',
      maxProbeQuestions: 21,
      maxTurnsPerStep: 0,
      prompts: { ...form.prompts, teacher: '', merge: 'x'.repeat(MAX_PROMPT_LENGTH + 1) },
    });
    expect(Object.keys(errors).sort()).toEqual([
      'id',
      'language',
      'maxProbeQuestions',
      'maxTurnsPerStep',
      'prompts.merge',
      'prompts.teacher',
    ]);
  });
});
