import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import { portContract } from '../testing/port-contract.ts';
import { makeMemoryStorage } from './index.ts';

portContract('memory', makeMemoryStorage);

describe('memory storage', () => {
  it('saves settings and deletes only the key', async () => {
    const storage = makeMemoryStorage();
    expect(await Effect.runPromise(storage.getSettings)).toBeUndefined();
    await Effect.runPromise(
      storage.saveSettings({ provider: 'anthropic', model: 'haiku', apiKey: 'secret' }),
    );
    await Effect.runPromise(storage.deleteApiKey);
    expect(await Effect.runPromise(storage.getSettings)).toEqual({
      provider: 'anthropic',
      model: 'haiku',
    });
  });

  it('keeps the image model with its own key, and deletes only that key', async () => {
    const storage = makeMemoryStorage();
    const image = { provider: 'gemini' as const, model: 'img', apiKey: 'image-secret' };
    await Effect.runPromise(
      storage.saveSettings({ provider: 'anthropic', model: 'haiku', apiKey: 'secret', image }),
    );
    await Effect.runPromise(storage.deleteImageApiKey);
    expect(await Effect.runPromise(storage.getSettings)).toEqual({
      provider: 'anthropic',
      model: 'haiku',
      apiKey: 'secret',
      image: { provider: 'gemini', model: 'img' },
    });
  });
});
