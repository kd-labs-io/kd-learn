import { Result, Schema } from 'effect';
import { describe, expect, it } from 'vitest';
import { isPlanResolved, LessonPlan, nextStep, validatePlan } from './plan.ts';

const node = (id: string, dependsOn: Array<string> = []) => ({
  id,
  title: `Title ${id}`,
  goal: `Goal ${id}`,
  dependsOn,
});
const plan = (...nodes: Array<ReturnType<typeof node>>): LessonPlan => ({
  nodes: nodes as unknown as LessonPlan['nodes'],
});

const failureOf = (p: LessonPlan) => {
  const result = validatePlan(p);
  if (Result.isSuccess(result)) throw new Error('expected an invalid plan');
  return result.failure;
};

describe('validatePlan', () => {
  it('accepts a DAG, including a diamond', () => {
    const diamond = plan(node('a'), node('b', ['a']), node('c', ['a']), node('d', ['b', 'c']));
    expect(Result.isSuccess(validatePlan(diamond))).toBe(true);
  });

  it('rejects a cycle and reports its path', () => {
    const error = failureOf(plan(node('a', ['c']), node('b', ['a']), node('c', ['b'])));
    expect(error.reason).toBe('Cycle');
    expect(error.ids).toEqual(['a', 'c', 'b', 'a']);
    expect(error.message).toContain('a -> c -> b -> a');
  });

  it('rejects a self-dependency as a cycle', () => {
    const error = failureOf(plan(node('a'), node('b', ['b'])));
    expect(error.reason).toBe('Cycle');
    expect(error.ids).toEqual(['b', 'b']);
  });

  it('finds a cycle that is not reachable from the first node', () => {
    const error = failureOf(plan(node('a'), node('b', ['c']), node('c', ['b'])));
    expect(error.reason).toBe('Cycle');
  });

  it('rejects an unknown dependency', () => {
    const error = failureOf(plan(node('a', ['zzz'])));
    expect(error.reason).toBe('UnknownDependency');
    expect(error.ids).toEqual(['a', 'zzz']);
  });

  it('rejects a duplicate id', () => {
    const error = failureOf(plan(node('a'), node('a')));
    expect(error.reason).toBe('DuplicateId');
  });
});

describe('LessonPlan schema', () => {
  const decode = Schema.decodeUnknownSync(LessonPlan);
  it('requires at least one node and non-empty text', () => {
    expect(() => decode({ nodes: [] })).toThrow();
    expect(() => decode({ nodes: [{ ...node('a'), title: '' }] })).toThrow();
    expect(decode({ nodes: [node('a')] }).nodes).toHaveLength(1);
  });
});

describe('nextStep', () => {
  const p = plan(node('a'), node('b', ['a']), node('c'), node('d', ['b', 'c']));

  it('starts with the first node without dependencies', () => {
    expect(nextStep(p, new Set())?.id).toBe('a');
  });

  it('picks the first node whose dependencies are all resolved, in plan order', () => {
    expect(nextStep(p, new Set(['a']))?.id).toBe('b');
    expect(nextStep(p, new Set(['a', 'b']))?.id).toBe('c');
    expect(nextStep(p, new Set(['c']))?.id).toBe('a');
  });

  it('waits for every dependency', () => {
    expect(nextStep(p, new Set(['a', 'b', 'c']))?.id).toBe('d');
  });

  it('returns undefined when everything is resolved', () => {
    const all = new Set(['a', 'b', 'c', 'd']);
    expect(nextStep(p, all)).toBeUndefined();
    expect(isPlanResolved(p, all)).toBe(true);
    expect(isPlanResolved(p, new Set(['a']))).toBe(false);
  });
});
