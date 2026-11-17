// Manual spike check against real providers (not run in CI).
// Run: node --env-file=../../.env scripts/live.ts <anthropic|gemini|openrouter> [runs]
import { Effect, Schema, Stream } from 'effect';
import { tool, ToolError, type ModelRef } from '../src/port/index.ts';
import { runTurn } from '../src/tanstack/index.ts';

const env = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};

const models: Record<string, () => ModelRef> = {
  anthropic: () => ({
    provider: 'anthropic',
    model: 'claude-haiku-5-5',
    apiKey: env('KD_LEARN_CLAUDE_API'),
  }),
  gemini: () => ({
    provider: 'gemini',
    model: 'gemini-3.5-flash',
    apiKey: env('KD_LEARN_GEMINI_API'),
  }),
  openrouter: () => ({
    provider: 'openai-compatible',
    model: 'openai/gpt-5-mini',
    apiKey: env('KD_LEARN_OPENROUTER'),
    baseURL: 'https://openrouter.ai/api/v1',
  }),
};

const add = tool({
  name: 'add',
  description: 'Add two numbers. Always use this tool for arithmetic.',
  input: Schema.Struct({ a: Schema.Finite, b: Schema.Finite }),
  run: ({ a, b }) =>
    Number.isFinite(a + b)
      ? Effect.succeed({ result: a + b })
      : Effect.fail(new ToolError({ message: 'overflow' })),
});

const Answer = Schema.Struct({
  sum: Schema.Finite,
  confidence: Schema.Literals(['low', 'medium', 'high']),
  explanation: Schema.String,
});

const which = process.argv[2] ?? 'anthropic';
const runs = Number(process.argv[3] ?? 1);
const model = models[which]!();

const once = (i: number) =>
  runTurn()({
    model,
    system: 'You are a terse assistant.',
    messages: [
      { role: 'user', content: `What is ${1000 + i} + ${2345 * (i + 1)}? Use the add tool.` },
    ],
    tools: [add],
    output: Answer,
  }).pipe(
    Stream.runCollect,
    Effect.map((events) => {
      const tags = events.map((e) => e._tag);
      const result = events.find((e) => e._tag === 'StructuredResult');
      const ok =
        result?._tag === 'StructuredResult' && result.value.sum === 1000 + i + 2345 * (i + 1);
      return {
        ok,
        tags: [...new Set(tags)].join(','),
        value: result?._tag === 'StructuredResult' ? result.value : undefined,
      };
    }),
    Effect.catch((error) =>
      Effect.succeed({
        ok: false,
        tags: `error ${error._tag}: ${error.message}`,
        value: undefined,
      }),
    ),
  );

// Interrupt: stop after the first text delta of a long answer; time from that delta to stream end.
const interrupt = Effect.gen(function* () {
  let firstDeltaAt = 0;
  yield* runTurn()({
    model,
    messages: [{ role: 'user', content: 'Write a 600-word story about a lighthouse.' }],
  }).pipe(
    Stream.filter((e) => e._tag === 'TextDelta'),
    Stream.take(1),
    Stream.tap(() => Effect.sync(() => (firstDeltaAt = Date.now()))),
    Stream.runDrain,
  );
  return `interrupt: stream closed ${Date.now() - firstDeltaAt} ms after the first delta`;
});

const program = Effect.gen(function* () {
  let passed = 0;
  for (let i = 0; i < runs; i++) {
    const r = yield* once(i);
    if (r.ok) passed++;
    console.log(i, r.ok ? 'ok' : 'FAIL', r.tags, JSON.stringify(r.value ?? ''));
  }
  console.log(`${which}: ${passed}/${runs} valid`);
  console.log(yield* interrupt);
});

Effect.runPromise(program).catch((e) => {
  console.error(e);
  process.exit(1);
});
