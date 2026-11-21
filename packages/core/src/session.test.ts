import { Result, Schema } from 'effect';
import { describe, expect, it } from 'vitest';
import { DomainEvent, EventLog } from './event.ts';
import type { StepId } from './plan.ts';
import type { TeachingProfile } from './profile.ts';
import { canSkipStep, currentStep, findInterruptedTurn, projectSession } from './session.ts';
import type { Session } from './session.ts';

const profile: TeachingProfile = {
  id: 'default',
  language: 'vi',
  maxProbeQuestions: 3,
  maxTurnsPerStep: 2,
  prompts: { prober: 'p', teacher: 't', sideChat: 's' },
};

let counter = 0;
const meta = () => ({ id: `e${++counter}`, at: counter });

const created = (): DomainEvent => ({
  _tag: 'SessionCreated',
  ...meta(),
  sessionId: 's1',
  topic: 'Rust ownership',
  profile,
});
const started = (turnId: string, input = ''): DomainEvent => ({
  _tag: 'TurnStarted',
  ...meta(),
  turnId,
  input,
});
const message = (turnId: string, content: string): DomainEvent => ({
  _tag: 'MessageAppended',
  ...meta(),
  turnId,
  messageId: `m${counter}`,
  agent: 'teacher',
  content,
});
const done = (turnId: string): DomainEvent => ({
  _tag: 'TurnCompleted',
  ...meta(),
  turnId,
  reason: 'stop',
});
const failed = (turnId: string): DomainEvent => ({
  _tag: 'TurnFailed',
  ...meta(),
  turnId,
  code: 'ProviderError',
  message: 'rate limited',
  retryable: true,
});
const usage = (turnId: string, inputTokens: number, outputTokens: number): DomainEvent => ({
  _tag: 'UsageRecorded',
  ...meta(),
  turnId,
  model: 'test-model',
  inputTokens,
  outputTokens,
});
const assessed = (turnId: string): DomainEvent => ({
  _tag: 'AssessmentRecorded',
  ...meta(),
  turnId,
  level: 'beginner',
  summary: 'Knows basics',
  strengths: ['syntax'],
  gaps: ['borrowing'],
});
const planned = (turnId: string): DomainEvent => ({
  _tag: 'PlanCreated',
  ...meta(),
  turnId,
  plan: {
    nodes: [
      { id: 'a', title: 'A', goal: 'ga', dependsOn: [] },
      { id: 'b', title: 'B', goal: 'gb', dependsOn: ['a'] },
    ],
  },
});
const stepDone = (turnId: string, stepId: StepId): DomainEvent => ({
  _tag: 'StepCompleted',
  ...meta(),
  turnId,
  stepId,
});
const stepSkipped = (stepId: StepId): DomainEvent => ({ _tag: 'StepSkipped', ...meta(), stepId });
const sessionDone = (turnId: string): DomainEvent => ({
  _tag: 'SessionCompleted',
  ...meta(),
  turnId,
});
const side = (
  threadId: string,
  role: 'user' | 'assistant',
  content: string,
  usage?: { model: string; inputTokens: number; outputTokens: number },
): DomainEvent => ({
  _tag: 'SideMessageAppended',
  ...meta(),
  threadId,
  messageId: `sm${counter}`,
  role,
  content,
  ...(usage ? { usage } : {}),
});
const sideFailed = (threadId: string): DomainEvent => ({
  _tag: 'SideTurnFailed',
  ...meta(),
  threadId,
  code: 'ProviderError',
  message: 'rate limited',
  retryable: true,
});

const project = (...events: Array<DomainEvent>): Session => {
  const result = projectSession(events);
  if (Result.isFailure(result)) throw result.failure;
  return result.success;
};
const errorOf = (...events: Array<DomainEvent>) => {
  const result = projectSession(events);
  if (Result.isSuccess(result)) throw new Error('expected a projection error');
  return result.failure;
};

/** A log that reaches `teaching(a)`. */
const teachingLog = (): Array<DomainEvent> => [
  created(),
  started('t1', 'Rust ownership'),
  message('t1', 'What do you know?'),
  done('t1'),
  started('t2', 'a bit'),
  assessed('t2'),
  done('t2'),
  started('t3', ''),
  planned('t3'),
  message('t3', 'Step a: ...'),
  done('t3'),
];

describe('projectSession', () => {
  it('starts in probing', () => {
    const s = project(created());
    expect(s.state).toEqual({ _tag: 'Probing', turnsCompleted: 0 });
    expect(s.topic).toBe('Rust ownership');
    expect(s.history).toEqual([]);
  });

  it('walks probing -> planning -> teaching -> done', () => {
    const log = teachingLog();
    expect(project(...log.slice(0, 4)).state).toEqual({ _tag: 'Probing', turnsCompleted: 1 });

    const planning = project(...log.slice(0, 7));
    expect(planning.state).toEqual({ _tag: 'Planning' });
    expect(planning.assessment?.gaps).toEqual(['borrowing']);

    const teaching = project(...log);
    expect(teaching.state).toEqual({ _tag: 'Teaching', stepId: 'a', turnsInStep: 0 });
    expect(currentStep(teaching)?.title).toBe('A');

    const full = project(
      ...log,
      started('t4', 'ok'),
      stepDone('t4', 'a'),
      done('t4'),
      started('t5', 'ok'),
      stepDone('t5', 'b'),
      sessionDone('t5'),
      done('t5'),
    );
    expect(full.state).toEqual({ _tag: 'Done' });
    expect(full.completedSteps).toEqual(['a', 'b']);
    expect(currentStep(full)).toBeUndefined();
  });

  it('moves to the next step by the DAG and waits for SessionCompleted after the last one', () => {
    const afterA = project(...teachingLog(), started('t4'), stepDone('t4', 'a'), done('t4'));
    expect(afterA.state).toEqual({ _tag: 'Teaching', stepId: 'b', turnsInStep: 0 });

    const afterB = project(
      ...teachingLog(),
      started('t4'),
      stepDone('t4', 'a'),
      stepDone('t4', 'b'),
    );
    expect(afterB.state).toEqual({ _tag: 'Teaching', stepId: undefined, turnsInStep: 0 });
  });

  it('lets the learner skip the last step: SessionCompleted without a turn', () => {
    const noTurn = (): DomainEvent => ({ _tag: 'SessionCompleted', ...meta() });
    const full = project(...teachingLog(), stepSkipped('a'), stepSkipped('b'), noTurn());
    expect(full.state).toEqual({ _tag: 'Done' });
    expect(full.skippedSteps).toEqual(['a', 'b']);
    // Still checked: not valid while a step is left.
    expect(errorOf(...teachingLog(), stepSkipped('a'), noTurn()).index).toBe(
      teachingLog().length + 1,
    );
  });

  it('counts turns on a step and allows skipping after M of them', () => {
    const base = teachingLog();
    const one = project(...base, started('t4'), done('t4'));
    expect(one.state).toMatchObject({ turnsInStep: 1 });
    expect(canSkipStep(one)).toBe(false);

    const two = project(...base, started('t4'), done('t4'), started('t5'), done('t5'));
    expect(canSkipStep(two)).toBe(true);

    const skipped = project(
      ...base,
      started('t4'),
      done('t4'),
      started('t5'),
      done('t5'),
      stepSkipped('a'),
    );
    expect(skipped.skippedSteps).toEqual(['a']);
    expect(skipped.state).toEqual({ _tag: 'Teaching', stepId: 'b', turnsInStep: 0 });
    expect(canSkipStep(skipped)).toBe(false);
  });

  it('treats a skipped step as resolved for dependencies', () => {
    const s = project(
      ...teachingLog(),
      stepSkipped('a'),
      started('t4'),
      stepDone('t4', 'b'),
      sessionDone('t4'),
    );
    expect(s.state).toEqual({ _tag: 'Done' });
  });

  it('adds side chat usage to the total and ignores a side failure', () => {
    const before = project(created(), started('t1', 'hi'), usage('t1', 3, 4), done('t1'));
    const s = project(
      created(),
      started('t1', 'hi'),
      usage('t1', 3, 4),
      done('t1'),
      side('th', 'user', 'q'),
      sideFailed('th'),
      side('th', 'user', 'q'),
      side('th', 'assistant', 'a', { model: 'm', inputTokens: 5, outputTokens: 6 }),
    );
    expect(before.usage).toEqual({ inputTokens: 3, outputTokens: 4 });
    expect(s.usage).toEqual({ inputTokens: 8, outputTokens: 10 });
    expect(s.state).toEqual(before.state);
    expect(s.history).toEqual(before.history);
    expect(s.sideThreads['th']).toHaveLength(3);
  });

  it('builds history from completed turns only and sums usage', () => {
    const s = project(
      created(),
      started('t1', 'hello'),
      message('t1', 'hi'),
      usage('t1', 10, 5),
      usage('t1', 1, 2),
      done('t1'),
      started('t2', 'lost'),
      message('t2', 'partial'),
      failed('t2'),
      started('t3', 'lost'),
    );
    expect(s.history).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ]);
    expect(s.usage).toEqual({ inputTokens: 11, outputTokens: 7 });
    expect(s.turns.map((t) => t.status)).toEqual(['completed', 'failed', 'started']);
    expect(s.turns[1]?.failure).toEqual({
      code: 'ProviderError',
      message: 'rate limited',
      retryable: true,
    });
  });

  it('keeps side chat out of history and state', () => {
    const s = project(
      created(),
      side('x', 'user', 'what is a borrow?'),
      side('x', 'assistant', 'a reference'),
    );
    expect(s.sideThreads['x']).toHaveLength(2);
    expect(s.history).toEqual([]);
    expect(s.state._tag).toBe('Probing');
  });

  it('records the step on a side message when present', () => {
    const s = project(...teachingLog(), {
      ...side('x', 'user', 'q'),
      stepId: 'a',
    } as DomainEvent);
    expect(s.sideThreads['x']?.[0]?.stepId).toBe('a');
  });
});

describe('projectSession rejects bad logs', () => {
  it('empty log and wrong first event', () => {
    expect(errorOf().index).toBe(-1);
    expect(errorOf(started('t1')).index).toBe(0);
  });

  it('a second SessionCreated', () => {
    expect(errorOf(created(), created()).index).toBe(1);
  });

  it('events of an unknown or ended turn', () => {
    expect(errorOf(created(), message('nope', 'x')).message).toContain('unknown turn');
    expect(errorOf(created(), started('t1'), done('t1'), message('t1', 'x')).message).toContain(
      'already ended',
    );
  });

  it('a duplicate turn id', () => {
    expect(errorOf(created(), started('t1'), started('t1')).message).toContain('already exists');
  });

  it('state events out of order', () => {
    expect(errorOf(created(), started('t1'), planned('t1')).message).toContain('planning');
    expect(errorOf(created(), started('t1'), stepDone('t1', 'a')).message).toContain('step');
    const afterAssessment = [created(), started('t1'), assessed('t1'), started('t2')];
    expect(errorOf(...afterAssessment, assessed('t2')).message).toContain('probing');
  });

  it('a plan with a cycle', () => {
    const bad = {
      ...planned('t2'),
      plan: {
        nodes: [
          { id: 'a', title: 'A', goal: 'g', dependsOn: ['b'] },
          { id: 'b', title: 'B', goal: 'g', dependsOn: ['a'] },
        ],
      },
    } as DomainEvent;
    const error = errorOf(created(), started('t1'), assessed('t1'), started('t2'), bad);
    expect(error.index).toBe(4);
    expect(error.message).toContain('cycle');
  });

  it('completing a step that is not the current one', () => {
    expect(errorOf(...teachingLog(), started('t4'), stepDone('t4', 'b')).message).toContain(
      'current step is "a"',
    );
  });

  it('SessionCompleted while steps are left, and turns after done', () => {
    expect(errorOf(...teachingLog(), started('t4'), sessionDone('t4')).message).toContain(
      'every step',
    );
    const finished = [
      ...teachingLog(),
      started('t4'),
      stepDone('t4', 'a'),
      stepDone('t4', 'b'),
      sessionDone('t4'),
      done('t4'),
    ];
    expect(errorOf(...finished, started('t5')).message).toContain('done');
  });
});

describe('findInterruptedTurn', () => {
  it('is undefined when every turn ended', () => {
    expect(findInterruptedTurn(project(created(), started('t1'), done('t1')))).toBeUndefined();
    expect(findInterruptedTurn(project(created(), started('t1'), failed('t1')))).toBeUndefined();
    expect(findInterruptedTurn(project(created()))).toBeUndefined();
  });

  it('finds a turn with TurnStarted and no end, with its input for the retry', () => {
    const s = project(created(), started('t1', 'my answer'));
    expect(findInterruptedTurn(s)).toMatchObject({ turnId: 't1', input: 'my answer' });
  });

  it('ignores an older open turn once a later turn has run', () => {
    const s = project(created(), started('t1', 'x'), started('t2', 'x'), done('t2'));
    expect(findInterruptedTurn(s)).toBeUndefined();
  });

  it('still reports the open turn after the retry also dropped', () => {
    const s = project(created(), started('t1', 'x'), started('t2', 'x'));
    expect(findInterruptedTurn(s)?.turnId).toBe('t2');
  });
});

describe('event schemas', () => {
  it('round-trips a full log through JSON', () => {
    const log = [
      ...teachingLog(),
      usage('t3', 4, 2),
      started('t4'),
      stepSkipped('a'),
      { ...side('x', 'user', 'q'), stepId: 'b' } as DomainEvent,
      failed('t4'),
    ];
    const json = JSON.parse(JSON.stringify(log));
    const decoded = Schema.decodeUnknownSync(EventLog)(json);
    expect(decoded).toEqual(log);
    expect(Schema.encodeSync(EventLog)(decoded)).toEqual(log);
  });

  it('rejects an unknown tag and bad fields', () => {
    const decode = Schema.decodeUnknownSync(DomainEvent);
    expect(() => decode({ _tag: 'Nope', id: 'x', at: 1 })).toThrow();
    expect(() => decode({ ...started('t1'), at: -1 })).toThrow();
    expect(() => decode({ ...started('t1'), turnId: '' })).toThrow();
    expect(() => decode({ ...usage('t1', 1, 1), inputTokens: 1.5 })).toThrow();
  });
});
