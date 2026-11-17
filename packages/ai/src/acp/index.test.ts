import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Effect, Exit, Schema, Stream } from 'effect';
import { describe, expect, it } from 'vitest';
import { tool, type ModelRef } from '../port/index.ts';
import { runTurn, type Launch } from './index.ts';

const fakeAgent = fileURLToPath(new URL('../../test/fake-agent.ts', import.meta.url));
const model: ModelRef = { provider: 'acp', agent: 'claude-code' };
const withFake =
  (env: Record<string, string>): (() => Launch) =>
  () => ({ command: process.execPath, args: [fakeAgent], env: { ...process.env, ...env } });

const add = tool({
  name: 'add',
  description: 'Add two numbers.',
  input: Schema.Struct({ a: Schema.Finite, b: Schema.Finite }),
  run: ({ a, b }) => Effect.succeed({ result: a + b }),
});
const Answer = Schema.Struct({ sum: Schema.Finite });

const run = (env: Record<string, string>) =>
  Effect.runPromiseExit(
    runTurn({ launch: withFake(env) })({
      model,
      messages: [{ role: 'user', content: 'add' }],
      tools: [add],
      output: Answer,
    }).pipe(Stream.runCollect),
  );

describe('runTurn (ACP)', () => {
  it('runs kd-learn tools in-process and returns the submitted result', async () => {
    const exit = await run({
      FAKE_CALLS: JSON.stringify([
        ['add', { a: 2, b: 3 }],
        ['submit_result', { sum: 5 }],
      ]),
    });
    expect(Exit.isSuccess(exit)).toBe(true);
    const events = Exit.isSuccess(exit) ? exit.value : [];
    expect(events.filter((e) => e._tag !== 'TextDelta')).toEqual([
      { _tag: 'ToolCall', id: 'kd-1', name: 'add', input: { a: 2, b: 3 } },
      { _tag: 'ToolResult', id: 'kd-1', output: '{"result":5}' },
      { _tag: 'StructuredResult', value: { sum: 5 } },
      { _tag: 'Finish', reason: 'stop' },
    ]);
  }, 20_000);

  it('accepts a result fixed after one rejection', async () => {
    const exit = await run({
      FAKE_CALLS: JSON.stringify([
        ['submit_result', { sum: 'five' }],
        ['submit_result', { sum: 5 }],
      ]),
    });
    const events = Exit.isSuccess(exit) ? exit.value : [];
    expect(events).toContainEqual({ _tag: 'StructuredResult', value: { sum: 5 } });
  }, 20_000);

  it('fails with OutputInvalid after a second rejected result', async () => {
    const exit = await run({
      FAKE_CALLS: JSON.stringify([
        ['submit_result', { sum: 'five' }],
        ['submit_result', { sum: 'still five' }],
      ]),
    });
    const reason = Exit.isFailure(exit) ? exit.cause.reasons[0] : undefined;
    expect(reason).toMatchObject({ _tag: 'Fail', error: { _tag: 'OutputInvalid' } });
  }, 20_000);

  it('fails with OutputInvalid when the agent never submits', async () => {
    const exit = await run({ FAKE_CALLS: JSON.stringify([['add', { a: 1, b: 1 }]]) });
    const reason = Exit.isFailure(exit) ? exit.cause.reasons[0] : undefined;
    expect(reason).toMatchObject({ _tag: 'Fail', error: { _tag: 'OutputInvalid' } });
  }, 20_000);

  it('sends session/cancel when the stream is interrupted', async () => {
    const marker = join(await mkdtemp(join(tmpdir(), 'kd-acp-test-')), 'cancelled');
    const events = await Effect.runPromise(
      runTurn({ launch: withFake({ FAKE_HANG: '1', FAKE_MARKER: marker }) })({
        model,
        messages: [{ role: 'user', content: 'talk' }],
      }).pipe(Stream.take(3), Stream.runCollect),
    );
    expect(events.map((e) => e._tag)).toEqual(['TextDelta', 'TextDelta', 'TextDelta']);
    expect(existsSync(marker)).toBe(true);
  }, 20_000);
});
