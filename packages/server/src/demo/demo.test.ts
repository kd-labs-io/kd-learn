import { Effect, Layer, Stream } from 'effect';
import { describe, expect, it } from 'vitest';
import { defaultProfile } from '@kd-learn/agent';
import { AiPort } from '@kd-learn/ai/port';
import type { TurnEvent, TurnRequest } from '@kd-learn/ai/port';
import { makeSseParser } from '@kd-learn/api';
import { openServerDatabase } from '@kd-learn/storage/sqlite-node';
import type { Handlers } from '../index.ts';
import { ADMIN, make } from '../auth/test-support.ts';
import { die, failWith, gated, say, scriptedAi } from '../sessions/fake-ai.ts';
import { makeDemoBudget, periodKey } from './budget.ts';
import { meteredAi } from './metered.ts';

const DEMO_KEY = 'sk-ant-demo-SERVER-KEY-0123456789';
const demoEnv = (budget: number) => ({
  KD_LEARN_DEMO_MODE: 'on',
  KD_LEARN_DEMO_PROVIDER: 'anthropic',
  KD_LEARN_DEMO_MODEL: 'claude-haiku-5-5',
  KD_LEARN_DEMO_API_KEY: DEMO_KEY,
  KD_LEARN_DEMO_BUDGET: String(budget),
});

const log = [
  { _tag: 'SessionCreated', id: 'e1', at: 1, sessionId: 's1', topic: 'T', profile: defaultProfile },
  { _tag: 'TurnStarted', id: 'e2', at: 2, turnId: 't1', input: '' },
];

const call = (
  handler: Handlers[keyof Handlers],
  method: string,
  path: string,
  token?: string,
  body?: unknown,
) =>
  handler(
    new Request(`http://kd.test${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );

const codeOf = async (response: Response) =>
  ((await response.json()) as { error: { code: string } }).error.code;

const setup = async (programs: Parameters<typeof scriptedAi>[0], env: Record<string, string>) => {
  const fake = scriptedAi(programs);
  const { handlers, logs } = make(env, { ai: fake.layer });
  const demo = (model: unknown = { provider: 'demo' }, extra: Record<string, unknown> = {}) =>
    call(handlers.turns, 'POST', '/api/turns', undefined, {
      model,
      turn: { kind: 'main' },
      log,
      ...extra,
    });
  const admin = (
    (await (
      await call(handlers.login, 'POST', '/api/auth/login', undefined, {
        email: ADMIN.email,
        password: ADMIN.password,
      })
    ).json()) as { token: string }
  ).token;
  const config = async () =>
    (await (await call(handlers.admin, 'GET', '/api/admin/config', admin)).json()) as {
      demoBudget: { limit: number; used: number };
      demoModel?: string;
    };
  const setConfig = (change: unknown) =>
    call(handlers.admin, 'PUT', '/api/admin/config', admin, change);
  return { handlers, logs, fake, demo, config, setConfig };
};

describe('demo turns', () => {
  it('serves N calls from any client, then refuses without calling the provider', async () => {
    const t = await setup([say('1'), say('2'), say('3'), say('4')], demoEnv(3));
    for (let i = 0; i < 3; i++) {
      const response = await t.demo();
      expect(response.status).toBe(200);
      await response.text();
    }
    const refused = await t.demo();
    expect(refused.status).toBe(429);
    expect(await codeOf(refused)).toBe('DemoQuotaExceeded');
    expect(t.fake.requests).toHaveLength(3);
    // The server chose the model and the caps.
    expect(t.fake.requests[0]).toMatchObject({
      model: { provider: 'anthropic', model: 'claude-haiku-5-5' },
      maxOutputTokens: 2048,
    });
    expect((await t.config()).demoBudget).toMatchObject({ limit: 3, used: 3 });

    // Raising the limit opens demo again.
    await t.setConfig({ demoBudgetLimit: 4 });
    const again = await t.demo();
    expect(again.status).toBe(200);
    await again.text();
  });

  it('lets only one of two concurrent requests through at the edge of the budget', async () => {
    const first = gated('A', '.');
    const second = gated('B', '.');
    const t = await setup([say('warm-up'), first.program, second.program], demoEnv(2));
    await (await t.demo()).text();
    const [a, b] = await Promise.all([t.demo(), t.demo()]);
    expect([a.status, b.status].sort()).toEqual([200, 429]);
    first.release();
    second.release();
    await (a.status === 200 ? a : b).text();
    expect(t.fake.requests).toHaveLength(2);
    expect((await t.config()).demoBudget.used).toBe(2);
  });

  it('charges a failed turn and keeps the demo key out of frames and logs', async () => {
    const t = await setup([failWith(`bad key ${DEMO_KEY}`), die(`boom ${DEMO_KEY}`)], demoEnv(10));
    const bodies = [await (await t.demo()).text(), await (await t.demo()).text()];
    const parser = makeSseParser();
    const errors = bodies.flatMap((body) =>
      parser.push(body).map((m) => JSON.parse(m.data) as { _tag: string }),
    );
    expect(errors.some((frame) => frame._tag === 'error')).toBe(true);
    const everything = JSON.stringify([bodies, t.logs, await t.config()]);
    expect(everything).not.toContain(DEMO_KEY);
    expect((await t.config()).demoBudget.used).toBe(2);
  });

  it('gives back the unused reservation when the turn ends', async () => {
    const t = await setup([say('short')], demoEnv(10));
    await (await t.demo()).text();
    // A main turn reserves 4 calls; one was used.
    expect((await t.config()).demoBudget.used).toBe(1);
  });

  it('never counts fewer calls than were made when the client goes away', async () => {
    const gate = gated('Hi', ' there');
    const t = await setup([gate.program], demoEnv(10));
    const response = await t.demo();
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    gate.release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const used = (await t.config()).demoBudget.used;
    expect(used).toBeGreaterThanOrEqual(t.fake.requests.length);
    expect(used).toBeLessThanOrEqual(4);
  });

  it('refuses a model, a key or a large history from the client', async () => {
    const t = await setup([], demoEnv(10));
    expect((await t.demo({ provider: 'demo', model: 'claude-opus-5-5' })).status).toBe(400);
    expect((await t.demo({ provider: 'demo', apiKey: 'sk-ant-mine-0123456789' })).status).toBe(400);
    const big = await t.demo(undefined, {
      log: [...log.slice(0, 1), { ...log[0], id: 'x', topic: 'y'.repeat(300_000) }, log[1]],
    });
    expect(big.status).toBe(413);
    expect(t.fake.requests).toHaveLength(0);
    expect((await t.config()).demoBudget.used).toBe(0);
  });

  it('is closed when the switch is off, the limit is 0, or no model is set', async () => {
    const t = await setup([], demoEnv(10));
    await t.setConfig({ demoMode: false });
    expect(await codeOf(await t.demo())).toBe('DemoModeDisabled');
    await t.setConfig({ demoMode: true, demoBudgetLimit: 0 });
    expect(await codeOf(await t.demo())).toBe('DemoModeDisabled');
    expect(await (await call(t.handlers.config, 'GET', '/api/config')).json()).toMatchObject({
      demoMode: false,
    });

    const noModel = await setup([], { KD_LEARN_DEMO_MODE: 'on', KD_LEARN_DEMO_BUDGET: '10' });
    expect(await codeOf(await noModel.demo())).toBe('DemoModeDisabled');
    expect(noModel.fake.requests).toHaveLength(0);
  });

  it('keeps the guest and demo switches separate', async () => {
    const t = await setup([say('demo')], { ...demoEnv(10), KD_LEARN_GUEST_MODE: 'off' });
    expect(await (await call(t.handlers.config, 'GET', '/api/config')).json()).toMatchObject({
      guestMode: false,
      demoMode: true,
    });
    const demo = await t.demo();
    expect(demo.status).toBe(200);
    await demo.text();
    const guest = await t.demo({
      provider: 'anthropic',
      model: 'claude-haiku-5-5',
      apiKey: 'sk-ant-guest-0123456789',
    });
    expect(await codeOf(guest)).toBe('GuestModeDisabled');
    expect((await t.config()).demoModel).toBe('anthropic:claude-haiku-5-5');
  });

  it('rejects a bad demo variable, and accounts with it', async () => {
    const bad = make({ KD_LEARN_DEMO_PROVIDER: 'anthropic' });
    expect((await call(bad.handlers.login, 'POST', '/api/auth/login', undefined, {})).status).toBe(
      500,
    );
    const badBudget = make({ KD_LEARN_DEMO_BUDGET: 'lots' });
    expect(
      (await call(badBudget.handlers.login, 'POST', '/api/auth/login', undefined, {})).status,
    ).toBe(500);
  });
});

describe('demo budget', () => {
  it('starts a new count each period', () => {
    const database = Effect.runSync(openServerDatabase({ path: ':memory:' }));
    let at = Date.UTC(2026, 10, 21, 23, 0);
    const budget = makeDemoBudget(database, { limit: 1, period: 'day' }, () => at);
    expect(budget.reserve(4)).toMatchObject({ _tag: 'Ok', reservation: { calls: 1 } });
    expect(budget.reserve(4)).toEqual({ _tag: 'Exceeded' });
    at += 2 * 60 * 60 * 1000;
    expect(budget.reserve(4)._tag).toBe('Ok');
    expect(periodKey('month', at)).toBe('month:2026-11');
    expect(periodKey('none', at)).toBe('none');
  });
});

describe('metered AI', () => {
  const inner = (events: ReadonlyArray<TurnEvent<never>>) => {
    const seen: TurnRequest[] = [];
    const layer = Layer.succeed(AiPort, {
      runTurn: ((request: TurnRequest) => {
        seen.push(request);
        return Stream.fromIterable(events);
      }) as unknown as AiPort['Service']['runTurn'],
    });
    return { layer, seen };
  };
  const toolTurn: ReadonlyArray<TurnEvent<never>> = [
    { _tag: 'ToolCall', id: 'c1', name: 'x', input: {} },
    { _tag: 'ToolResult', id: 'c1', output: 'ok' },
    { _tag: 'TextDelta', messageId: 'm2', delta: 'done' },
    { _tag: 'Finish', reason: 'stop' },
  ];
  const run = (layer: Layer.Layer<AiPort>) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const port = yield* AiPort;
        return yield* Stream.runCollect(
          port.runTurn({
            model: { provider: 'anthropic', model: 'm', apiKey: 'k' },
            messages: [],
            maxSteps: 6,
          }),
        );
      }).pipe(Effect.provide(layer)),
    );

  it('counts a tool round as a second call and caps steps at the reservation', async () => {
    const fake = inner(toolTurn);
    const meter = { calls: 0 };
    await run(meteredAi(fake.layer, { calls: 4, maxOutputTokens: 100 }, meter));
    expect(meter.calls).toBe(2);
    expect(fake.seen[0]).toMatchObject({ maxSteps: 4, maxOutputTokens: 100 });

    const capped = inner(toolTurn);
    const one = { calls: 0 };
    await run(meteredAi(capped.layer, { calls: 1, maxOutputTokens: 100 }, one));
    expect(one.calls).toBe(1);
    expect(capped.seen[0]).toMatchObject({ maxSteps: 1 });
  });
});
