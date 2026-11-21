// `/api/account/profile` (phase 3 A2): get, save, reset, validation, and users kept apart.
import { describe, expect, it } from 'vitest';
import { defaultProfile } from '@kd-learn/agent';
import { MAX_PROMPT_LENGTH } from '@kd-learn/core';
import type { Handlers } from '../index.ts';
import { make } from '../auth/test-support.ts';

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
      ...(body === undefined
        ? {}
        : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    }),
  );

const signUp = async (handlers: Handlers, email: string) => {
  const response = await call(handlers.register, 'POST', '/api/auth/register', undefined, {
    email,
    password: 'password-123',
  });
  return ((await response.json()) as { token: string }).token;
};

/** A phase 2 shaped profile: no phase 3 prompts, so the server fills them in. */
const mine = {
  id: 'mine',
  name: 'Mine',
  language: 'vi',
  maxProbeQuestions: 2,
  maxTurnsPerStep: 3,
  prompts: { prober: 'My prober.', teacher: 'My teacher.', sideChat: 'My side chat.' },
};

interface ProfileBody {
  readonly saved: boolean;
  readonly profile: { readonly id: string; readonly prompts: Record<string, string> };
}

const profileOf = async (response: Response) => (await response.json()) as ProfileBody;

describe('account profile routes', () => {
  it('answers the default profile until one is saved, then the saved one with defaults filled in', async () => {
    const { handlers } = make();
    const token = await signUp(handlers, 'a@kd.test');

    const first = await profileOf(
      await call(handlers.account, 'GET', '/api/account/profile', token),
    );
    expect(first).toMatchObject({ saved: false, profile: { id: defaultProfile.id } });

    const put = await call(handlers.account, 'PUT', '/api/account/profile', token, {
      profile: mine,
    });
    expect(put.status).toBe(200);
    const saved = await profileOf(put);
    expect(saved.saved).toBe(true);
    expect(saved.profile.id).toBe('mine');
    expect(saved.profile.prompts.teacher).toBe('My teacher.');
    expect(saved.profile.prompts.extractor).toBe(defaultProfile.prompts.extractor);

    const reset = await profileOf(
      await call(handlers.account, 'DELETE', '/api/account/profile', token),
    );
    expect(reset).toMatchObject({ saved: false, profile: { id: defaultProfile.id } });
  });

  it('rejects a profile outside the limits and keeps the old one', async () => {
    const { handlers } = make();
    const token = await signUp(handlers, 'a@kd.test');
    await call(handlers.account, 'PUT', '/api/account/profile', token, { profile: mine });

    const bad = (profile: unknown) =>
      call(handlers.account, 'PUT', '/api/account/profile', token, { profile });
    expect((await bad({ ...mine, maxTurnsPerStep: 0 })).status).toBe(400);
    expect((await bad({ ...mine, prompts: { ...mine.prompts, teacher: '' } })).status).toBe(400);
    expect((await bad({ ...mine, extra: true })).status).toBe(400);
    const long = await bad({
      ...mine,
      prompts: { ...mine.prompts, teacher: 'x'.repeat(MAX_PROMPT_LENGTH + 1) },
    });
    expect(long.status).toBe(400);
    // Above the body limit of the route: refused before decoding.
    const huge = await call(
      handlers.account,
      'PUT',
      '/api/account/profile',
      token,
      JSON.stringify({ profile: mine, pad: 'x'.repeat(600 * 1024) }),
    );
    expect(huge.status).toBe(413);

    const after = await profileOf(
      await call(handlers.account, 'GET', '/api/account/profile', token),
    );
    expect(after.profile.prompts.teacher).toBe('My teacher.');
  });

  it("keeps users apart: one user's profile is never another's", async () => {
    const { handlers } = make();
    const alice = await signUp(handlers, 'alice@kd.test');
    const bob = await signUp(handlers, 'bob@kd.test');
    await call(handlers.account, 'PUT', '/api/account/profile', alice, { profile: mine });

    const bobs = await profileOf(await call(handlers.account, 'GET', '/api/account/profile', bob));
    expect(bobs).toMatchObject({ saved: false, profile: { id: defaultProfile.id } });
    // Bob's reset touches only Bob's row.
    await call(handlers.account, 'DELETE', '/api/account/profile', bob);
    const alices = await profileOf(
      await call(handlers.account, 'GET', '/api/account/profile', alice),
    );
    expect(alices).toMatchObject({ saved: true, profile: { id: 'mine' } });
  });

  it('snapshots the saved profile into a new session', async () => {
    const { handlers } = make();
    const token = await signUp(handlers, 'a@kd.test');
    await call(handlers.account, 'PUT', '/api/account/profile', token, { profile: mine });
    const created = await call(handlers.account, 'POST', '/api/account/sessions', token, {
      topic: 'Fractions',
      language: 'en',
    });
    expect(created.status).toBe(201);
    const { sessionId } = (await created.json()) as { sessionId: string };
    const snapshot = (await (
      await call(handlers.account, 'GET', `/api/account/sessions/${sessionId}`, token)
    ).json()) as {
      events: Array<{
        event: { _tag: string; profile?: ProfileBody['profile'] & { language: string } };
      }>;
    };
    const first = snapshot.events[0]?.event;
    expect(first?._tag).toBe('SessionCreated');
    expect(first?.profile?.id).toBe('mine');
    expect(first?.profile?.prompts.teacher).toBe('My teacher.');
    // The lesson language comes from the request, as before.
    expect(first?.profile?.language).toBe('en');
  });

  it('requires a token', async () => {
    const { handlers } = make();
    expect((await call(handlers.account, 'GET', '/api/account/profile')).status).toBe(401);
    expect(
      (await call(handlers.account, 'PUT', '/api/account/profile', undefined, { profile: mine }))
        .status,
    ).toBe(401);
  });
});
