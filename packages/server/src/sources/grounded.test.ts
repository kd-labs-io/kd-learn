// Teaching from sources (phase 4 A3) through the account routes and the guest route.
import { describe, expect, it } from 'vitest';
import { defaultProfile } from '@kd-learn/agent';
import type { SourceInfo } from '@kd-learn/core';
import { make } from '../auth/test-support.ts';
import type { Handlers } from '../index.ts';
import { say, scriptedAi } from '../sessions/fake-ai.ts';

const KEY = 'sk-ant-grounded-SECRET-0123456789';
type Json = Record<string, unknown>;

const request = (
  handler: Handlers[keyof Handlers],
  method: string,
  path: string,
  token: string | undefined,
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
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
const until = async (check: () => Promise<boolean>) => {
  for (let i = 0; i < 400; i++) {
    if (await check()) return;
    await tick();
  }
  throw new Error('timed out waiting');
};

const note = (title: string, texts: string[]) => ({
  kind: 'note',
  title,
  origin: `${title}.md`,
  chunks: texts.map((text, ordinal) => ({ ordinal, text, locator: { heading: 'Mục' } })),
});

describe('account lessons with sources', () => {
  const setup = async (programs: Parameters<typeof scriptedAi>[0]) => {
    const fake = scriptedAi(programs);
    const { handlers } = make({}, { ai: fake.layer });
    const signUp = async (email: string) =>
      (
        (await (
          await request(handlers.register, 'POST', '/api/auth/register', undefined, {
            email,
            password: 'password-123',
          })
        ).json()) as { token: string }
      ).token;
    const token = await signUp('a@kd.test');
    const other = await signUp('b@kd.test');
    const account = (method: string, path: string, body?: unknown, as = token) =>
      request(handlers.account, method, `/api/account/${path}`, as, body);
    const { id } = (await (
      await account('POST', 'connections', { label: 'A', provider: 'anthropic', apiKey: KEY })
    ).json()) as { id: string };
    const role = { connectionId: id, model: 'claude-haiku-5-5' };
    await account('PUT', 'roles', { roles: { prober: role, teacher: role, sideChat: role } });
    const source = async (body: unknown, as = token) =>
      ((await (await account('POST', 'sources', body, as)).json()) as { source: SourceInfo })
        .source;
    const events = async (sessionId: string) =>
      (
        (await (await account('GET', `sessions/${sessionId}`)).json()) as {
          events: Array<{ event: Json & { _tag: string } }>;
          running: unknown[];
        }
      ).events.map((e) => e.event);
    return { fake, account, token, other, source, events };
  };

  it('attaches sources at creation, teaches from their chunks and stores citations', async () => {
    const t = await setup([say('Mảng phải được sắp xếp [S1]; không phải [S4].')]);
    const searching = await t.source(
      note('Tìm kiếm', ['Tìm kiếm nhị phân cần mảng đã sắp xếp.', 'Chia đôi khoảng mỗi bước.']),
    );
    const theirs = await t.source(note('Riêng', ['Của người khác.']), t.other);

    // Another account's source cannot be attached: same answer as an unknown one.
    expect(
      (
        await t.account('POST', 'sessions', {
          topic: 'Tìm kiếm nhị phân',
          language: 'vi',
          sourceIds: [theirs.sourceId],
        })
      ).status,
    ).toBe(404);
    const created = (await (
      await t.account('POST', 'sessions', {
        topic: 'Tìm kiếm nhị phân',
        language: 'vi',
        sourceIds: [searching.sourceId],
      })
    ).json()) as { sessionId: string };
    expect((await t.events(created.sessionId)).map((e) => e._tag)).toEqual([
      'SessionCreated',
      'SourceAttached',
    ]);

    await t.account('POST', `sessions/${created.sessionId}/turns`, { kind: 'auto' });
    await until(async () =>
      (await t.events(created.sessionId)).some((e) => e._tag === 'TurnCompleted'),
    );
    const system = t.fake.requests[0]!.system;
    expect(system).toContain('<source label="S1" title="Tìm kiếm" section="Mục">');
    expect(system).toContain('Tìm kiếm nhị phân cần mảng đã sắp xếp.');
    const log = await t.events(created.sessionId);
    expect(log.find((e) => e._tag === 'MessageAppended')).toMatchObject({
      content: 'Mảng phải được sắp xếp [S1]; không phải.',
      citations: [{ label: 1, sourceId: searching.sourceId }],
    });
    expect(
      (log.find((e) => e._tag === 'TurnCompleted') as { sourceRefs?: unknown[] }).sourceRefs,
    ).toHaveLength(2);
    expect(system).not.toContain('Của người khác');
  });

  it('attaches and detaches mid-lesson; another account gets 404', async () => {
    const t = await setup([]);
    const a = await t.source(note('A', ['Một.']));
    const theirs = await t.source(note('B', ['Hai.']), t.other);
    const { sessionId } = (await (
      await t.account('POST', 'sessions', { topic: 'X', language: 'vi' })
    ).json()) as { sessionId: string };
    const change = (body: unknown, as?: string) =>
      t.account('POST', `sessions/${sessionId}/sources`, body, as);

    expect((await change({ attach: [a.sourceId], detach: [] })).status).toBe(204);
    expect((await change({ attach: [a.sourceId], detach: [] })).status).toBe(204);
    expect((await change({ attach: [theirs.sourceId], detach: [] })).status).toBe(404);
    expect((await change({ attach: [], detach: [a.sourceId] }, t.other)).status).toBe(404);
    expect((await change({ attach: [], detach: [a.sourceId] })).status).toBe(204);
    expect((await t.events(sessionId)).map((e) => e._tag)).toEqual([
      'SessionCreated',
      'SourceAttached',
      'SourceDetached',
    ]);
  });
});

describe('guest turns with a source slice', () => {
  const log = [
    {
      _tag: 'SessionCreated',
      id: 'e1',
      at: 1,
      sessionId: 's1',
      topic: 'Binary search',
      profile: { ...defaultProfile, language: 'en' },
    },
    { _tag: 'TurnStarted', id: 'e2', at: 2, turnId: 't1', input: 'Hi' },
  ];
  const turn = (handlers: Handlers, sourceSlice: unknown) =>
    request(handlers.turns, 'POST', '/api/turns', undefined, {
      model: { provider: 'anthropic', model: 'claude-haiku-5-5', apiKey: KEY },
      turn: { kind: 'main' },
      log,
      sourceSlice,
    });
  const chunk = (text: string, ordinal = 0) => ({
    sourceId: 'pdf1',
    ordinal,
    title: 'Notes',
    text,
    locator: { page: 1 },
  });

  it('puts the slice in the prompt and refuses one over the byte limit', async () => {
    const fake = scriptedAi([say('Sorted first [S1].')]);
    const { handlers } = make({}, { ai: fake.layer });
    const response = await turn(handlers, [chunk('Binary search needs a sorted array.')]);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(fake.requests[0]!.system).toContain('<source label="S1" title="Notes" page="1">');
    expect(body).toContain('"citations":[{"label":1,"sourceId":"pdf1","ordinal":0}]');
    expect(body).not.toContain(KEY);

    const big = Array.from({ length: 12 }, (_, i) => chunk('x'.repeat(3900), i));
    expect((await turn(handlers, big)).status).toBe(413);
  });
});
