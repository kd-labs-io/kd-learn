import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import { openServerDatabase } from '@kd-learn/storage/sqlite-node';
import type { Endpoint } from '../config.ts';
import { makeAuth } from '../auth/service.ts';
import { makeSecretBox } from './secret-box.ts';
import { makeSettings } from './service.ts';

const KEY = 'sk-ant-account-SECRET-0123456789';

const setup = async (endpoints: Endpoint[] = []) => {
  const database = Effect.runSync(openServerDatabase({ path: ':memory:' }));
  const auth = makeAuth(database, { defaultRegistration: 'open' });
  const box = makeSecretBox(new Map([[1, Buffer.alloc(32, 1)]]), 1);
  const settings = makeSettings(database, box, () => endpoints);
  const user = async (email: string) => {
    const result = await auth.register({ email, password: 'password-1' });
    if (result._tag !== 'Ok') throw new Error(result._tag);
    return result.user.id;
  };
  return { database, settings, user };
};

describe('settings service', () => {
  it('keeps only ciphertext in the database', async () => {
    const { database, settings, user } = await setup();
    const id = await user('a@x.io');
    settings.createConnection(id, { label: 'A', provider: 'anthropic', apiKey: KEY });
    const dump = JSON.stringify(database.db.prepare('SELECT * FROM connections').all());
    expect(dump).not.toContain(KEY);
    expect(dump).not.toContain('SECRET');
  });

  it('resolves the model of each role with the decrypted key', async () => {
    const endpoint = {
      id: 'acme',
      label: 'Acme',
      baseURL: 'https://llm.acme.test/v1',
      images: false,
    };
    const { settings, user } = await setup([endpoint]);
    const id = await user('a@x.io');
    const result = settings.createConnection(id, {
      label: 'Acme',
      provider: 'openai-compatible',
      endpointId: 'acme',
      apiKey: KEY,
    });
    if (result._tag !== 'Ok') throw new Error(result._tag);
    expect(settings.resolveModel(id, 'teacher')).toEqual({
      _tag: 'RoleNotConfigured',
      role: 'teacher',
    });
    settings.setRoles(id, { teacher: { connectionId: result.connection.id, model: 'm1' } });
    expect(settings.resolveModel(id, 'teacher')).toEqual({
      _tag: 'Ok',
      model: { provider: 'openai-compatible', model: 'm1', apiKey: KEY, baseURL: endpoint.baseURL },
    });
    expect(settings.resolveModel(id, 'prober')._tag).toBe('RoleNotConfigured');
  });

  it('runs an unset phase 3 role on the teacher model, and reports the role asked for', async () => {
    const { settings, user } = await setup();
    const id = await user('a@x.io');
    const result = settings.createConnection(id, {
      label: 'A',
      provider: 'anthropic',
      apiKey: KEY,
    });
    if (result._tag !== 'Ok') throw new Error(result._tag);
    const connectionId = result.connection.id;
    // Neither the role nor the teacher is set: a practice route answers 409 RoleNotConfigured.
    expect(settings.resolveModel(id, 'practitioner')).toEqual({
      _tag: 'RoleNotConfigured',
      role: 'practitioner',
    });
    settings.setRoles(id, { teacher: { connectionId, model: 'teacher-model' } });
    for (const role of ['practitioner', 'extractor'] as const) {
      const resolved = settings.resolveModel(id, role);
      expect(resolved._tag === 'Ok' && resolved.model.model).toBe('teacher-model');
    }
    // The roles of phase 2 have no fallback.
    expect(settings.resolveModel(id, 'prober')._tag).toBe('RoleNotConfigured');
    settings.setRoles(id, {
      teacher: { connectionId, model: 'teacher-model' },
      extractor: { connectionId, model: 'cheap-model' },
    });
    const extractor = settings.resolveModel(id, 'extractor');
    expect(extractor._tag === 'Ok' && extractor.model.model).toBe('cheap-model');
    expect(settings.get(id).roles.extractor).toEqual({ connectionId, model: 'cheap-model' });
  });

  it('keeps every role, and lets only an image API be the illustrator, with no fallback', async () => {
    const endpoints: Endpoint[] = [
      { id: 'text', label: 'Text', baseURL: 'https://text.test/v1', images: false },
      { id: 'img', label: 'Img', baseURL: 'https://img.test/v1', images: true },
    ];
    const { settings, user } = await setup(endpoints);
    const id = await user('a@x.io');
    const connect = (input: Parameters<typeof settings.createConnection>[1]) => {
      const made = settings.createConnection(id, input);
      if (made._tag !== 'Ok') throw new Error(made._tag);
      return made.connection.id;
    };
    const anthropic = connect({ label: 'A', provider: 'anthropic', apiKey: KEY });
    const text = connect({
      label: 'T',
      provider: 'openai-compatible',
      endpointId: 'text',
      apiKey: KEY,
    });
    const img = connect({
      label: 'I',
      provider: 'openai-compatible',
      endpointId: 'img',
      apiKey: KEY,
    });
    const teacher = { connectionId: anthropic, model: 'claude-haiku-5-5' };
    expect(settings.setRoles(id, { teacher, researcher: teacher })).toEqual({ _tag: 'Ok' });
    expect(settings.get(id).roles.researcher).toEqual(teacher);
    // Unset: no images, even though the teacher is set.
    expect(settings.resolveImageModel(id)).toBeUndefined();
    for (const connectionId of [anthropic, text]) {
      expect(settings.setRoles(id, { teacher, illustrator: { connectionId, model: 'm' } })).toEqual(
        { _tag: 'RoleNotSupported', role: 'illustrator' },
      );
    }
    expect(settings.get(id).roles.researcher).toEqual(teacher);
    expect(
      settings.setRoles(id, { teacher, illustrator: { connectionId: img, model: 'gpt-image-2' } }),
    ).toEqual({ _tag: 'Ok' });
    expect(settings.resolveImageModel(id)).toEqual({
      provider: 'openai-compatible',
      model: 'gpt-image-2',
      apiKey: KEY,
      baseURL: 'https://img.test/v1',
    });
    // The operator takes images off the endpoint: no images from the next turn on.
    endpoints[1] = { ...endpoints[1]!, images: false };
    expect(settings.resolveImageModel(id)).toBeUndefined();
  });

  it('unsets the roles of a deleted connection', async () => {
    const { settings, user } = await setup();
    const id = await user('a@x.io');
    const result = settings.createConnection(id, { label: 'A', provider: 'gemini', apiKey: KEY });
    if (result._tag !== 'Ok') throw new Error(result._tag);
    settings.setRoles(id, { sideChat: { connectionId: result.connection.id, model: 'g' } });
    expect(settings.deleteConnection(id, result.connection.id)).toBe(true);
    expect(settings.get(id).roles).toEqual({});
  });

  it('reports an unreadable key when the master key changed', async () => {
    const { database, settings, user } = await setup();
    const id = await user('a@x.io');
    const result = settings.createConnection(id, {
      label: 'A',
      provider: 'anthropic',
      apiKey: KEY,
    });
    if (result._tag !== 'Ok') throw new Error(result._tag);
    settings.setRoles(id, { teacher: { connectionId: result.connection.id, model: 'm' } });
    const other = makeSettings(
      database,
      makeSecretBox(new Map([[1, Buffer.alloc(32, 9)]]), 1),
      () => [],
    );
    expect(other.resolveModel(id, 'teacher')).toEqual({ _tag: 'KeyUnreadable', role: 'teacher' });
  });

  it('does not decrypt a ciphertext moved to another user', async () => {
    const { database, settings, user } = await setup();
    const alice = await user('alice@x.io');
    const bob = await user('bob@x.io');
    const a = settings.createConnection(alice, { label: 'A', provider: 'anthropic', apiKey: KEY });
    const b = settings.createConnection(bob, {
      label: 'B',
      provider: 'anthropic',
      apiKey: 'sk-ant-bob-0000000000',
    });
    if (a._tag !== 'Ok' || b._tag !== 'Ok') throw new Error('setup');
    database.db
      .prepare(
        'UPDATE connections SET key_sealed = (SELECT key_sealed FROM connections WHERE id = ?) WHERE id = ?',
      )
      .run(a.connection.id, b.connection.id);
    settings.setRoles(bob, { teacher: { connectionId: b.connection.id, model: 'm' } });
    expect(settings.resolveModel(bob, 'teacher')._tag).toBe('KeyUnreadable');
  });
});
