import { describe, expect, it } from 'vitest';
import { defaultProfile } from '@kd-learn/agent';
import { makeSseParser } from '@kd-learn/api';
import type { DomainEvent } from '@kd-learn/core';
import { ADMIN, make } from '../auth/test-support.ts';
import type { Handlers } from '../index.ts';
import { failWith, scriptedAi, structured } from '../sessions/fake-ai.ts';

const KEY = 'sk-ant-guest-SECRET-0123456789';
const DEMO_KEY = 'sk-ant-demo-SERVER-KEY-0123456789';
const demoEnv = (budget: number) => ({
  KD_LEARN_DEMO_MODE: 'on',
  KD_LEARN_DEMO_PROVIDER: 'anthropic',
  KD_LEARN_DEMO_MODEL: 'claude-haiku-5-5',
  KD_LEARN_DEMO_API_KEY: DEMO_KEY,
  KD_LEARN_DEMO_BUDGET: String(budget),
});

const log: DomainEvent[] = [
  {
    _tag: 'SessionCreated',
    id: 'e1',
    at: 1,
    sessionId: 's1',
    topic: 'Binary search',
    profile: { ...defaultProfile, language: 'vi' },
  },
  { _tag: 'TurnStarted', id: 'e2', at: 2, turnId: 't1', input: 'Hi' },
  {
    _tag: 'MessageAppended',
    id: 'e3',
    at: 3,
    turnId: 't1',
    messageId: 'm1',
    agent: 'teacher',
    content: 'Binary search needs a sorted array.',
  },
  { _tag: 'TurnCompleted', id: 'e4', at: 4, turnId: 't1', reason: 'stop' },
];

const slice = [
  { propositionId: 'old', text: 'Binary search only works on sorted arrays.', topic: 'Search' },
];

const answers = () => [
  structured({
    propositions: [{ key: 'p', text: 'Binary search needs a sorted array.' }],
    edges: [],
  }),
  structured({
    propositions: [{ key: 'p', verdict: 'keep', text: '', parts: [], reason: '' }],
    edges: [],
  }),
  structured({
    decisions: [{ key: 'p', action: 'same', existingId: 'old', reason: 'same' }],
    edges: [],
  }),
];

const post = (handler: Handlers['extract'], body: unknown) =>
  handler(
    new Request('http://kd.test/api/knowledge/extract', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );

const framesOf = async (response: Response) => {
  const parser = makeSseParser();
  return parser
    .push(`${await response.text()}\n\n`)
    .map((m) => JSON.parse(m.data) as { _tag: string } & Record<string, unknown>);
};

const guest = { provider: 'anthropic', model: 'claude-haiku-5-5', apiKey: KEY };

describe('POST /api/knowledge/extract', () => {
  it('returns the batch over SSE with the guest profile, merging only into the slice', async () => {
    const fake = scriptedAi(answers());
    const { handlers, logs } = make({}, { ai: fake.layer });
    const profile = {
      ...defaultProfile,
      id: 'mine',
      prompts: { ...defaultProfile.prompts, extractor: 'MY EXTRACTOR' },
    };
    const response = await post(handlers.extract, {
      model: guest,
      extractionId: 'x1',
      log,
      slice,
      profile,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const frames = await framesOf(response);
    expect(frames.map((f) => f._tag)).toEqual(['result', 'done']);
    const events = (frames[0] as unknown as { events: Array<{ _tag: string }> }).events;
    expect(events.map((e) => e._tag)).toEqual(['PropositionSourced', 'SessionExtracted']);
    expect(events[0]).toMatchObject({ propositionId: 'old' });
    expect(events.at(-1)).toMatchObject({ extractionId: 'x1', profileId: 'mine' });
    expect(fake.requests[0]!.system).toBe('MY EXTRACTOR');
    expect(fake.requests[1]!.system).toBe(defaultProfile.prompts.auditor);
    expect(JSON.stringify(logs)).not.toContain(KEY);
  });

  it('turns a provider failure into an error frame without the key', async () => {
    const fake = scriptedAi([failWith(`401 for ${KEY}`)]);
    const { handlers, logs } = make({}, { ai: fake.layer });
    const response = await post(handlers.extract, { model: guest, extractionId: 'x1', log, slice });
    const text = await response.text();
    expect(text).toContain('event: error');
    expect(text).toContain('event: done');
    expect(text).not.toContain(KEY);
    expect(JSON.stringify(logs)).not.toContain(KEY);
  });

  it('rejects a free base URL, unknown fields and a broken slice before any call', async () => {
    const fake = scriptedAi([]);
    const { handlers } = make({}, { ai: fake.layer });
    const bad = [
      { model: { ...guest, baseURL: 'http://evil' }, extractionId: 'x', log, slice },
      { model: guest, extractionId: 'x', log, slice, extra: 1 },
      { model: guest, extractionId: 'x', log, slice: [{ propositionId: '' }] },
    ];
    for (const body of bad) expect((await post(handlers.extract, body)).status).toBe(400);
    expect(fake.requests).toHaveLength(0);
  });

  it('demo: server profile and cap, budget charged by the calls made, refused when short', async () => {
    const fake = scriptedAi([...answers(), ...answers()]);
    const { handlers } = make(demoEnv(5), { ai: fake.layer });
    const response = await post(handlers.extract, {
      model: { provider: 'demo' },
      extractionId: 'x1',
      log,
      slice,
      profile: {
        ...defaultProfile,
        id: 'mine',
        prompts: { ...defaultProfile.prompts, extractor: 'INJECTED' },
      },
    });
    const frames = await framesOf(response);
    expect(frames.map((f) => f._tag)).toEqual(['result', 'done']);
    expect(fake.requests.map((r) => r.system)).toEqual([
      defaultProfile.prompts.extractor,
      defaultProfile.prompts.auditor,
      defaultProfile.prompts.merge,
    ]);
    expect(fake.requests.every((r) => r.maxOutputTokens === 16_384)).toBe(true);
    expect(JSON.stringify(frames)).not.toContain(DEMO_KEY);

    // 3 of 5 used: the next extraction may need 3, so it is refused without a provider call.
    const refused = await post(handlers.extract, {
      model: { provider: 'demo' },
      extractionId: 'x2',
      log,
      slice,
    });
    expect(refused.status).toBe(429);
    expect(fake.requests).toHaveLength(3);

    const admin = (
      (await (
        await handlers.login(
          new Request('http://kd.test/api/auth/login', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(ADMIN),
          }),
        )
      ).json()) as { token: string }
    ).token;
    const config = (await (
      await handlers.admin(
        new Request('http://kd.test/api/admin/config', {
          headers: { authorization: `Bearer ${admin}` },
        }),
      )
    ).json()) as { demoBudget: { used: number } };
    expect(config.demoBudget.used).toBe(3);
  });

  it('demo: an extraction that needs two calls is charged two', async () => {
    const fake = scriptedAi(answers().slice(0, 2));
    const { handlers } = make(demoEnv(10), { ai: fake.layer });
    const response = await post(handlers.extract, {
      model: { provider: 'demo' },
      extractionId: 'x1',
      log,
      slice: [],
    });
    expect((await framesOf(response)).map((f) => f._tag)).toEqual(['result', 'done']);
    expect(fake.requests).toHaveLength(2);
    const second = await post(handlers.extract, {
      model: { provider: 'demo' },
      extractionId: 'x2',
      log,
      slice: [],
    });
    // 8 left after settling 2: still enough for a full extraction.
    expect(second.status).toBe(200);
    await second.text();
  });
});

describe('extraction with documents (phase 4 A3)', () => {
  const chunk = (text: string, ordinal: number) => ({
    sourceId: 'pdf1',
    ordinal,
    title: 'Notes',
    text,
    locator: { page: 1 },
  });
  const body = (documentSlice: unknown, model: unknown) => ({
    model,
    extractionId: 'x1',
    log,
    slice,
    documentSlice,
  });
  const guestModel = { provider: 'anthropic', model: 'claude-haiku-5-5', apiKey: KEY };

  it('sends the documents to the extractor, and refuses a slice over the limit', async () => {
    const fake = scriptedAi(answers());
    const { handlers } = make({}, { ai: fake.layer });
    const ok = await post(handlers.extract, body([chunk('Arrays must be sorted.', 0)], guestModel));
    expect(ok.status).toBe(200);
    const text = await ok.text();
    expect(fake.requests[0]!.messages[0]!.content).toContain('[D1] Notes, page 1:');
    expect(text).not.toContain(KEY);

    const big = Array.from({ length: 20 }, (_, i) => chunk('x'.repeat(3900), i));
    expect((await post(handlers.extract, body(big, guestModel))).status).toBe(413);
  });

  it('counts the documents in the 256 KiB demo cap', async () => {
    const fake = scriptedAi([]);
    const { handlers } = make(demoEnv(10), { ai: fake.layer });
    // Under the document limit (64 KiB) but, with a long log, over the demo request cap.
    const longLog = [
      ...log,
      ...Array.from({ length: 60 }, (_, i) => ({
        _tag: 'MessageAppended',
        id: `x${i}`,
        at: 5,
        turnId: 't1',
        messageId: `m${i}`,
        agent: 'teacher',
        content: 'y'.repeat(3500),
      })),
    ];
    const response = await post(handlers.extract, {
      ...body(
        Array.from({ length: 15 }, (_, i) => chunk('x'.repeat(3900), i)),
        { provider: 'demo' },
      ),
      log: longLog,
    });
    expect(response.status).toBe(413);
    expect(fake.requests).toHaveLength(0);
  });
});
