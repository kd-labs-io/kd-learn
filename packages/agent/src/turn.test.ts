import { Effect, Exit, Result, Stream } from 'effect';
import { describe, expect, it } from 'vitest';
import { ProviderError, OutputInvalid } from '@kd-learn/ai/port';
import type { ModelRef } from '@kd-learn/ai/port';
import { projectSession } from '@kd-learn/core';
import type { DomainEvent, Session } from '@kd-learn/core';
import { NO_INPUT, defaultProfile, needsAgentTurn, runSideChat, runTurn } from './index.ts';
import type { AgentOutput } from './index.ts';
import { collect, counterIds, eventsOf, fakeAi } from './testing.ts';
import type { Action } from './testing.ts';

const KEY = 'sk-ant-very-secret-key';
const model: ModelRef = { provider: 'anthropic', model: 'fake-model', apiKey: KEY };

/** A session log plus helpers to play turns against it with a scripted fake model. */
const harness = (profile = { ...defaultProfile, maxProbeQuestions: 2, maxTurnsPerStep: 3 }) => {
  const newId = counterIds('x');
  const log: Array<DomainEvent> = [
    {
      _tag: 'SessionCreated',
      id: newId(),
      at: 1,
      sessionId: 's1',
      topic: 'Rust ownership',
      profile,
    },
  ];
  const session = (): Session => {
    const result = projectSession(log);
    if (Result.isFailure(result)) throw result.failure;
    return result.success;
  };
  /** Writes `TurnStarted` like the client, runs the turn, and appends the resulting events. */
  const play = async (input: string, script: ReadonlyArray<ReadonlyArray<Action>>) => {
    const fake = fakeAi(script);
    log.push({ _tag: 'TurnStarted', id: newId(), at: 2, turnId: newId(), input });
    const outputs = await collect(runTurn({ log, model, newId }), fake);
    log.push(...eventsOf(outputs));
    return { outputs, events: eventsOf(outputs), fake };
  };
  const side = async (
    content: string,
    threadId: string,
    script: ReadonlyArray<ReadonlyArray<Action>>,
  ) => {
    const fake = fakeAi(script);
    log.push({
      _tag: 'SideMessageAppended',
      id: newId(),
      at: 2,
      threadId,
      messageId: newId(),
      role: 'user',
      content,
    });
    const outputs = await collect(runSideChat({ log, threadId, model, newId }), fake);
    log.push(...eventsOf(outputs));
    return { outputs, events: eventsOf(outputs), fake };
  };
  return { log, newId, session, play, side };
};

const tags = (events: ReadonlyArray<DomainEvent>) => events.map((e) => e._tag);

const assessment = {
  level: 'beginner',
  summary: 'Knows what a variable is, unsure about moves.',
  strengths: ['variables'],
  gaps: ['moves', 'borrowing'],
};
const plan = {
  nodes: [
    { id: 'moves', title: 'Moves', goal: 'Explain what a move does', dependsOn: [] },
    { id: 'borrow', title: 'Borrowing', goal: 'Use & and &mut', dependsOn: ['moves'] },
  ],
};

describe('runTurn: a full session from probing to done', () => {
  it('runs probing, planning, teaching and completion with a scripted model', async () => {
    const h = harness();

    // Probing: the agent speaks first (no input), asks a question.
    const t1 = await h.play('', [[{ say: 'What is a variable?' }]]);
    expect(t1.fake.requests[0]?.messages).toEqual([{ role: 'user', content: NO_INPUT }]);
    expect(t1.fake.requests[0]?.tools?.map((t) => t.name)).toEqual(['submit_assessment']);
    expect(tags(t1.events)).toEqual(['MessageAppended', 'UsageRecorded', 'TurnCompleted']);
    expect(t1.events[0]).toMatchObject({ agent: 'prober', content: 'What is a variable?' });
    expect(h.session().state).toEqual({ _tag: 'Probing', turnsCompleted: 1 });

    // The learner answers; the Prober submits the assessment in the same turn as its closing text.
    const t2 = await h.play('A named box for a value.', [
      [
        { say: 'Thanks. ' },
        { call: 'submit_assessment', input: assessment },
        { say: 'Let me plan.' },
      ],
    ]);
    expect(tags(t2.events)).toEqual([
      'MessageAppended',
      'AssessmentRecorded',
      'UsageRecorded',
      'TurnCompleted',
    ]);
    expect(h.session().state).toEqual({ _tag: 'Planning' });
    expect(needsAgentTurn(h.session())).toBe(true);
    expect(h.session().assessment?.gaps).toEqual(['moves', 'borrowing']);

    // Planning turn started by the client with empty input; the Teacher creates the plan and greets.
    const t3 = await h.play('', [
      [{ call: 'create_plan', input: plan }, { say: 'Here is the path. First: moves.' }],
    ]);
    expect(t3.fake.requests[0]?.system).toContain('Phase: planning');
    expect(t3.fake.requests[0]?.system).toContain('Gaps: moves; borrowing');
    expect(t3.fake.requests[0]?.tools?.map((t) => t.name)).toEqual(['create_plan']);
    expect(tags(t3.events)).toEqual([
      'MessageAppended',
      'PlanCreated',
      'UsageRecorded',
      'TurnCompleted',
    ]);
    expect(t3.events[0]).toMatchObject({ agent: 'teacher' });
    expect(h.session().state).toMatchObject({ _tag: 'Teaching', stepId: 'moves' });
    expect(needsAgentTurn(h.session())).toBe(false);

    // Teaching: a turn without progress counts towards M; the next one completes the step.
    const t4 = await h.play('I think a move copies it?', [
      [{ say: 'Not quite, think of ownership.' }],
    ]);
    expect(t4.fake.requests[0]?.system).toContain('Current step: moves');
    expect(t4.fake.requests[0]?.tools?.map((t) => t.name)).toEqual(['complete_step']);
    expect(h.session().state).toMatchObject({ _tag: 'Teaching', stepId: 'moves', turnsInStep: 1 });

    const t5 = await h.play('A move transfers ownership; the old name is unusable.', [
      [
        { say: 'Exactly. ' },
        { call: 'complete_step', input: { stepId: 'moves' } },
        { say: 'Next: borrowing.' },
      ],
    ]);
    expect(tags(t5.events)).toEqual([
      'MessageAppended',
      'StepCompleted',
      'UsageRecorded',
      'TurnCompleted',
    ]);
    expect(h.session().state).toMatchObject({ _tag: 'Teaching', stepId: 'borrow', turnsInStep: 0 });

    // The last step: StepCompleted is followed by SessionCompleted in the same turn.
    const t6 = await h.play('& borrows without moving.', [
      [
        { say: 'Right!' },
        { call: 'complete_step', input: { stepId: 'borrow' } },
        { say: 'All done.' },
      ],
    ]);
    expect(tags(t6.events)).toEqual([
      'MessageAppended',
      'StepCompleted',
      'SessionCompleted',
      'UsageRecorded',
      'TurnCompleted',
    ]);
    const done = h.session();
    expect(done.state).toEqual({ _tag: 'Done' });
    expect(done.completedSteps).toEqual(['moves', 'borrow']);
    expect(done.turns.every((t) => t.status === 'completed')).toBe(true);
    expect(done.usage).toEqual({ inputTokens: 60, outputTokens: 30 });
    // A finished session accepts no more turns.
    expect(
      projectSession([
        ...h.log,
        { _tag: 'TurnStarted', id: 'z', at: 3, turnId: 'z', input: 'more' },
      ])._tag,
    ).toBe('Failure');
  });

  it('tells the Prober to submit once the question budget is used', async () => {
    const h = harness();
    await h.play('', [[{ say: 'Q1?' }]]);
    await h.play('a1', [[{ say: 'Q2?' }]]);
    const t = await h.play('a2', [
      [{ call: 'submit_assessment', input: assessment }, { say: 'ok' }],
    ]);
    expect(t.fake.requests[0]?.system).toContain('Questions asked so far: 2 of at most 2');
    expect(t.fake.requests[0]?.system).toContain('Call submit_assessment now');
    expect(h.session().state).toEqual({ _tag: 'Planning' });
  });
});

describe('runTurn: tool errors go back to the model and the turn continues', () => {
  it('rejects a plan with a cycle, lets the model fix it, and keeps only the valid plan', async () => {
    const h = harness();
    await h.play('', [[{ say: 'Q?' }]]);
    await h.play('a', [[{ call: 'submit_assessment', input: assessment }]]);
    const cyclic = {
      nodes: [
        { id: 'a', title: 'A', goal: 'g', dependsOn: ['b'] },
        { id: 'b', title: 'B', goal: 'g', dependsOn: ['a'] },
      ],
    };
    const unknownDep = { nodes: [{ id: 'a', title: 'A', goal: 'g', dependsOn: ['zzz'] }] };
    const t = await h.play('', [
      [
        { call: 'create_plan', input: cyclic },
        { call: 'create_plan', input: unknownDep },
        { call: 'create_plan', input: { nodes: [] } },
        { call: 'create_plan', input: plan },
        { say: 'Plan ready.' },
      ],
    ]);
    const results = t.fake.toolResults;
    expect(results[0]).toMatch(/^Error: The plan has a dependency cycle: a -> b -> a/);
    expect(results[1]).toMatch(/^Error: Step "a" depends on "zzz"/);
    expect(results[2]).toMatch(/^Error: /); // schema: at least one node
    expect(results[3]).toMatch(/^Plan saved with 2 steps/);
    expect(tags(t.events)).toEqual([
      'MessageAppended',
      'PlanCreated',
      'UsageRecorded',
      'TurnCompleted',
    ]);
    expect(h.session().plan).toEqual(plan);
  });

  it('rejects the wrong step and a second transition in one turn', async () => {
    const h = harness();
    await h.play('', [[{ say: 'Q?' }]]);
    await h.play('a', [[{ call: 'submit_assessment', input: assessment }]]);
    await h.play('', [[{ call: 'create_plan', input: plan }]]);
    const t = await h.play('done!', [
      [
        { call: 'complete_step', input: { stepId: 'borrow' } },
        { call: 'complete_step', input: { stepId: 'moves' } },
        { call: 'complete_step', input: { stepId: 'moves' } },
        { call: 'complete_step', input: { stepId: 'borrow' } },
      ],
    ]);
    expect(t.fake.toolResults[0]).toMatch(/^Error: The current step is "moves"/);
    expect(t.fake.toolResults[1]).toMatch(/^Step completed\. The next step is "borrow"/);
    expect(t.fake.toolResults[2]).toMatch(/^That step is already completed/);
    expect(t.fake.toolResults[3]).toMatch(/^Error: The lesson already moved forward/);
    expect(t.events.filter((e) => e._tag === 'StepCompleted')).toHaveLength(1);
    expect(h.session().state).toMatchObject({ stepId: 'borrow' });
  });

  it('does not offer a tool that does not belong to the state', async () => {
    const h = harness();
    const t = await h.play('', [[{ call: 'create_plan', input: plan }, { say: 'hm' }]]);
    expect(t.fake.toolResults[0]).toMatch(/^Error: unknown tool/);
    expect(tags(t.events)).toEqual(['MessageAppended', 'UsageRecorded', 'TurnCompleted']);
    expect(h.session().state).toEqual({ _tag: 'Probing', turnsCompleted: 1 });
  });
});

describe('runTurn: mapping TurnEvent to outputs and domain events (plan A2)', () => {
  it('streams deltas, merges text into one message, sums usage, maps Finish', async () => {
    const h = harness();
    const t = await h.play('hi', [
      [
        { say: 'Hello' },
        { call: 'submit_assessment', input: assessment },
        { usage: [7, 3] },
        { say: 'World' },
        { finish: 'length' },
      ],
    ]);
    const deltas = t.outputs.flatMap((o) => (o._tag === 'Delta' ? [o] : []));
    // Two provider messages are joined with a paragraph break, in the deltas as in the stored text.
    expect(deltas.map((d) => d.delta).join('')).toBe('Hello\n\nWorld');
    expect(new Set(deltas.map((d) => d.messageId)).size).toBe(1);
    const message = t.events.find((e) => e._tag === 'MessageAppended');
    expect(message).toMatchObject({ content: 'Hello\n\nWorld', messageId: deltas[0]?.messageId });
    expect(t.events.find((e) => e._tag === 'UsageRecorded')).toMatchObject({
      model: 'fake-model',
      inputTokens: 7,
      outputTokens: 3,
    });
    expect(t.events.at(-1)).toMatchObject({ _tag: 'TurnCompleted', reason: 'length' });
    expect(t.outputs.at(-1)).toEqual({ _tag: 'Done', outcome: 'completed' });
    // Tool calls and results are not stored raw.
    expect(tags(t.events)).not.toContain('ToolCall');
    // Deltas come before every event.
    const firstEvent = t.outputs.findIndex((o) => o._tag === 'Event');
    expect(t.outputs.slice(0, firstEvent).every((o) => o._tag === 'Delta')).toBe(true);
  });

  it('records TurnFailed, drops partial text and tool events, redacts the key', async () => {
    const h = harness();
    await h.play('', [[{ say: 'Q?' }]]);
    const t = await h.play('a', [
      [
        { say: 'partial' },
        { call: 'submit_assessment', input: assessment },
        {
          fail: new ProviderError({
            message: `rate limited for ${KEY}`,
            code: 'rate_limit',
            retryAfterMs: 500,
          }),
        },
      ],
    ]);
    expect(tags(t.events)).toEqual(['TurnFailed']);
    expect(t.events[0]).toMatchObject({
      code: 'rate_limit',
      message: 'rate limited for [redacted]',
      retryable: true,
    });
    expect(t.outputs.slice(-2)).toEqual([
      {
        _tag: 'Error',
        error: { code: 'rate_limit', message: 'rate limited for [redacted]', retryable: true },
      },
      { _tag: 'Done', outcome: 'failed' },
    ]);
    expect(JSON.stringify(t.outputs)).not.toContain(KEY);
    // The failed turn leaves no trace: still probing, and a retry with the same input works.
    const s = h.session();
    expect(s.state).toEqual({ _tag: 'Probing', turnsCompleted: 1 });
    expect(s.assessment).toBeUndefined();
    expect(s.turns.at(-1)?.status).toBe('failed');
    expect(s.history).toEqual([
      { role: 'user', content: '' },
      { role: 'assistant', content: 'Q?' },
    ]);
    const retry = await h.play('a', [
      [{ call: 'submit_assessment', input: assessment }, { say: 'ok' }],
    ]);
    expect(retry.fake.requests[0]?.messages.at(-1)).toEqual({ role: 'user', content: 'a' });
    expect(h.session().state).toEqual({ _tag: 'Planning' });
  });

  it('marks auth errors as not retryable and keeps spent tokens', async () => {
    const h = harness();
    const t = await h.play('', [
      [
        { usage: [5, 1] },
        { fail: new ProviderError({ message: 'invalid x-api-key', code: 'authentication_error' }) },
      ],
    ]);
    // Usage arrives with the final event of a model call, so a failure before it records none.
    expect(tags(t.events)).toEqual(['TurnFailed']);
    expect(t.events[0]).toMatchObject({ retryable: false });
  });

  it('maps OutputInvalid to a retryable failure', async () => {
    const h = harness();
    const t = await h.play('', [[{ fail: new OutputInvalid({ message: 'bad', raw: '{}' }) }]]);
    expect(t.events[0]).toMatchObject({
      _tag: 'TurnFailed',
      code: 'OutputInvalid',
      retryable: true,
    });
  });

  it('fails with InvalidTurn when the log has no open turn or is broken', async () => {
    const h = harness();
    const fake = fakeAi([]);
    const noTurn = await Effect.runPromiseExit(
      Stream.runCollect(runTurn({ log: h.log, model, newId: h.newId })).pipe(fake.layer),
    );
    expect(Exit.isFailure(noTurn)).toBe(true);
    const broken = await Effect.runPromiseExit(
      Stream.runCollect(runTurn({ log: [], model, newId: h.newId })).pipe(fake.layer),
    );
    expect(Exit.isFailure(broken)).toBe(true);
    expect(JSON.stringify(noTurn)).toContain('InvalidTurn');
  });

  it('adds nothing when the model says nothing', async () => {
    const h = harness();
    const t = await h.play('hi', [[]]);
    expect(tags(t.events)).toEqual(['UsageRecorded', 'TurnCompleted']);
  });
});

describe('runSideChat (plan A5)', () => {
  const started = async () => {
    const h = harness();
    await h.play('', [[{ say: 'Q?' }]]);
    await h.play('a', [[{ call: 'submit_assessment', input: assessment }]]);
    await h.play('', [[{ call: 'create_plan', input: plan }, { say: 'Path ready.' }]]);
    await h.play('my answer', [[{ say: 'Try again, think of ownership.' }]]);
    return h;
  };

  it('answers with plan, current step and recent main messages, and changes no state', async () => {
    const h = await started();
    const before = h.session();
    const t = await h.side('What does "move" mean here?', 'th1', [
      [{ say: 'It transfers ownership.' }],
    ]);
    const request = t.fake.requests[0]!;
    expect(request.tools).toBeUndefined();
    expect(request.system).toContain('moves [current] Moves');
    expect(request.system).toContain('Current step: moves');
    expect(request.system).toContain('Teacher: Try again, think of ownership.');
    expect(request.system).toContain('Learner: my answer');
    expect(request.messages).toEqual([{ role: 'user', content: 'What does "move" mean here?' }]);
    expect(tags(t.events)).toEqual(['SideMessageAppended']);
    expect(t.events[0]).toMatchObject({
      threadId: 'th1',
      role: 'assistant',
      content: 'It transfers ownership.',
      stepId: 'moves',
      usage: { model: 'fake-model', inputTokens: 10, outputTokens: 5 },
    });
    expect(t.outputs.at(-1)).toEqual({ _tag: 'Done', outcome: 'completed' });
    const after = h.session();
    expect(after.state).toEqual(before.state);
    expect(after.history).toEqual(before.history);
    expect(after.sideThreads['th1']).toHaveLength(2);

    // A follow-up sees the earlier side messages as conversation.
    const t2 = await h.side('And borrow?', 'th1', [[{ say: 'Next step.' }]]);
    expect(t2.fake.requests[0]?.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
  });

  it('records SideTurnFailed on a provider error and leaves the main thread alone', async () => {
    const h = await started();
    const before = h.session();
    const t = await h.side('q', 'th1', [[{ fail: new ProviderError({ message: `boom ${KEY}` }) }]]);
    expect(tags(t.events)).toEqual(['SideTurnFailed']);
    expect(t.events[0]).toMatchObject({
      code: 'ProviderError',
      message: 'boom [redacted]',
      retryable: true,
    });
    expect(t.outputs.map((o: AgentOutput) => o._tag)).toEqual(['Event', 'Error', 'Done']);
    expect(h.session().state).toEqual(before.state);
    expect(h.session().turns).toEqual(before.turns);
  });

  it('works before a plan exists and rejects a thread that does not end with the learner', async () => {
    const h = harness();
    const t = await h.side('hi?', 'th', [[{ say: 'hello' }]]);
    expect(t.fake.requests[0]?.system).toContain('No plan yet.');
    const exit = await Effect.runPromiseExit(
      Stream.runCollect(runSideChat({ log: h.log, threadId: 'th', model, newId: h.newId })).pipe(
        fakeAi([]).layer,
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });
});
