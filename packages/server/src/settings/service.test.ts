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
    const endpoint = { id: 'acme', label: 'Acme', baseURL: 'https://llm.acme.test/v1' };
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
