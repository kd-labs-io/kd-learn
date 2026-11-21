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
});
