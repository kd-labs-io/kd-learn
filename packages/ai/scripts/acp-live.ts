// Manual spike check for ACP agents (not run in CI): structured result reliability and cancel.
// Run: node --env-file=../../.env scripts/acp-live.ts <claude-code|antigravity|opencode> [runs]
import { Effect, Schema, Stream } from 'effect';
import { tool, type ModelRef } from '../src/port/index.ts';
import { runTurn } from '../src/acp/index.ts';

const agent = (process.argv[2] ?? 'claude-code') as 'claude-code' | 'antigravity' | 'opencode';
const runs = Number(process.argv[3] ?? 1);
const model: ModelRef = {
  provider: 'acp',
  agent,
  ...(agent === 'opencode' ? { model: 'opencode-go/claude-haiku-5-5' } : {}),
  ...(agent === 'antigravity' && process.env.KD_LEARN_GEMINI_API
    ? { apiKey: process.env.KD_LEARN_GEMINI_API }
    : {}),
};

const add = tool({
  name: 'add',
  description: 'Add two numbers. Always use this tool for arithmetic.',
  input: Schema.Struct({ a: Schema.Finite, b: Schema.Finite }),
  run: ({ a, b }) => Effect.succeed({ result: a + b }),
});

const Answer = Schema.Struct({
  sum: Schema.Finite,
  confidence: Schema.Literals(['low', 'medium', 'high']),
  explanation: Schema.String,
  steps: Schema.Array(
    Schema.Struct({ operation: Schema.Literals(['add']), result: Schema.Finite }),
  ),
});

const once = (i: number) => {
  const a = 1000 + i;
  const b = 2345 * (i + 1);
  return runTurn()({
    model,
    system: 'You are a terse assistant.',
    messages: [{ role: 'user', content: `What is ${a} + ${b}? Use the add tool.` }],
    tools: [add],
    output: Answer,
  }).pipe(
    Stream.runCollect,
    Effect.timed,
    Effect.map(([duration, events]) => {
      const result = events.find((e) => e._tag === 'StructuredResult');
      const value = result?._tag === 'StructuredResult' ? result.value : undefined;
      const toolCalls = events.filter((e) => e._tag === 'ToolCall').length;
      return {
        ok: value?.sum === a + b,
        detail: `tools=${toolCalls} ${JSON.stringify(value)}`,
        ms: Number(duration),
      };
    }),
    Effect.catch((error) =>
      Effect.succeed({ ok: false, detail: `${error._tag}: ${error.message.slice(0, 300)}`, ms: 0 }),
    ),
  );
};

const interrupt = Effect.gen(function* () {
  let at = 0;
  yield* runTurn()({
    model,
    messages: [{ role: 'user', content: 'Write a 600-word story about a lighthouse.' }],
  }).pipe(
    Stream.filter((e) => e._tag === 'TextDelta'),
    Stream.take(1),
    Stream.tap(() => Effect.sync(() => (at = Date.now()))),
    Stream.runDrain,
  );
  return `interrupt: stream closed ${Date.now() - at} ms after the first delta`;
});

const program = Effect.gen(function* () {
  let passed = 0;
  for (let i = 0; i < runs; i++) {
    const r = yield* once(i);
    if (r.ok) passed++;
    console.log(agent, i, r.ok ? 'ok' : 'FAIL', r.detail);
  }
  console.log(`${agent}: ${passed}/${runs} valid`);
  console.log(
    agent,
    yield* interrupt.pipe(Effect.catch((e) => Effect.succeed(`interrupt error ${e.message}`))),
  );
});

Effect.runPromise(program).then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
