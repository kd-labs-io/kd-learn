// Manual check of plan A4 against a real model (not run in CI): in ONE turn the Teacher streams
// text and calls a state-transition tool. Runs exactly one turn per invocation.
// Run: node --env-file=../../.env scripts/agent-live.ts <teach|probe|plan>
//   teach: log fixture is at step "moves", learner gives a correct answer -> expect text + complete_step
//   probe: Prober with N=1 and one answer -> expect text + submit_assessment
//   plan:  Planning state -> expect create_plan + greeting text
// The script imports the agent by relative path on purpose: `ai` must not depend on `agent`.
import { Effect, Stream } from 'effect';
import { AiPort, type ModelRef } from '../src/port/index.ts';
import { runTurn as runAi } from '../src/tanstack/index.ts';
import { defaultProfile, runTurn } from '../../agent/src/index.ts';
import type { DomainEvent, LessonPlan } from '../../core/src/index.ts';

const apiKey = process.env.KD_LEARN_CLAUDE_API;
if (!apiKey) throw new Error('Missing KD_LEARN_CLAUDE_API');
const model: ModelRef = { provider: 'anthropic', model: 'claude-haiku-5-5', apiKey };
// Claude Haiku 5.5, USD per million tokens (prompts up to 100K tokens).
const PRICE = { input: 0.1, output: 0.5 };

let n = 0;
const newId = () => `e${++n}`;
const meta = () => ({ id: newId(), at: 1_000 + n });
const stage = process.argv[2] ?? 'teach';

const plan: LessonPlan = {
  nodes: [
    {
      id: 'moves',
      title: 'Moves',
      goal: 'Explain what happens to a value when it is assigned to another variable',
      dependsOn: [],
    },
    {
      id: 'borrow',
      title: 'Borrowing',
      goal: 'Use shared and mutable references',
      dependsOn: ['moves'],
    },
  ],
};
const assessment = {
  level: 'beginner' as const,
  summary: 'Knows basic syntax, has not met ownership yet.',
  strengths: ['variables', 'functions'],
  gaps: ['ownership', 'references'],
};

const created = (profile = defaultProfile): DomainEvent => ({
  _tag: 'SessionCreated',
  ...meta(),
  sessionId: 's1',
  topic: 'Rust ownership',
  profile,
});
const turn = (turnId: string, input: string): Array<DomainEvent> => [
  { _tag: 'TurnStarted', ...meta(), turnId, input },
];
const done = (turnId: string): DomainEvent => ({
  _tag: 'TurnCompleted',
  ...meta(),
  turnId,
  reason: 'stop',
});
const said = (turnId: string, content: string): DomainEvent => ({
  _tag: 'MessageAppended',
  ...meta(),
  turnId,
  messageId: newId(),
  agent: 'teacher',
  content,
});

/** A finished probing turn that recorded the assessment. */
const prepared: Array<DomainEvent> = [
  ...turn('a1', ''),
  { _tag: 'AssessmentRecorded', ...meta(), turnId: 'a1', ...assessment },
  done('a1'),
];

const logs: Record<string, () => Array<DomainEvent>> = {
  teach: () => [
    created(),
    ...prepared,
    ...turn('p1', ''),
    { _tag: 'PlanCreated', ...meta(), turnId: 'p1', plan },
    said(
      'p1',
      'Welcome! First step: moves. If I write `let a = String::from("x"); let b = a;`, what can you still do with `a`?',
    ),
    done('p1'),
    ...turn(
      't1',
      'Nothing. The value moved to b, so a is no longer valid and the compiler rejects using it. Only one owner at a time, which is how Rust frees memory without a GC.',
    ),
  ],
  probe: () => [
    created({ ...defaultProfile, maxProbeQuestions: 1 }),
    ...turn('q1', ''),
    said('q1', 'Hi! Have you written any Rust before, and what does `let x = 5;` do?'),
    done('q1'),
    ...turn(
      'q2',
      'A bit. It declares an immutable variable x holding 5. I have never heard of ownership though.',
    ),
  ],
  plan: () => [created(), ...prepared, ...turn('p1', '')],
};

const build = logs[stage];
if (!build) throw new Error(`Unknown stage ${stage}`);
const log = build().map((e) =>
  e._tag === 'MessageAppended' && e.turnId === 'q1' ? { ...e, agent: 'prober' as const } : e,
);

const order: Array<string> = [];
const traced = Effect.provideService(AiPort, {
  runTurn: (request) =>
    runAi()(request).pipe(
      Stream.tap((event) =>
        Effect.sync(() => {
          const label =
            event._tag === 'ToolCall'
              ? `ToolCall(${event.name})`
              : event._tag === 'ToolResult'
                ? `ToolResult(${event.output.slice(0, 60)})`
                : event._tag;
          if (order.at(-1) !== label) order.push(label);
        }),
      ),
    ),
});

const started = Date.now();
const program = Stream.runCollect(runTurn({ log, model, newId, maxSteps: 4 })).pipe(traced);
const outputs = await Effect.runPromise(program);
const events = outputs.flatMap((o) => (o._tag === 'Event' ? [o.event] : []));
const usage = events.find((e) => e._tag === 'UsageRecorded');
const cost = usage
  ? (usage.inputTokens * PRICE.input + usage.outputTokens * PRICE.output) / 1_000_000
  : 0;

console.log(`stage=${stage} model=${model.model} ms=${Date.now() - started}`);
console.log(`model event order: ${order.join(' > ')}`);
console.log(`domain events: ${events.map((e) => e._tag).join(', ')}`);
console.log(
  `usage: ${usage ? `${usage.inputTokens} in / ${usage.outputTokens} out` : 'none'}, cost ~ $${cost.toFixed(6)}`,
);
const message = events.find((e) => e._tag === 'MessageAppended');
console.log(`message: ${message?.content ?? '(none)'}`);
for (const e of events) {
  if (
    e._tag === 'AssessmentRecorded' ||
    e._tag === 'PlanCreated' ||
    e._tag === 'StepCompleted' ||
    e._tag === 'TurnFailed'
  ) {
    console.log(`${e._tag}: ${JSON.stringify(e)}`);
  }
}
const failure = outputs.find((o) => o._tag === 'Error');
if (failure) process.exitCode = 1;
