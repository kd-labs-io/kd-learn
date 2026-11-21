import { describe, expect, it } from 'vitest';
import { loadMasterKey, makeSecretBox } from './secret-box.ts';

const key = (byte: number) => Buffer.alloc(32, byte);

describe('secret box', () => {
  it('round-trips, with a fresh IV each time', () => {
    const box = makeSecretBox(new Map([[1, key(1)]]), 1);
    const a = box.seal('sk-secret', 'ctx');
    const b = box.seal('sk-secret', 'ctx');
    expect(a).not.toBe(b);
    expect(a).not.toContain('sk-secret');
    expect(box.open(a, 1, 'ctx')).toBe('sk-secret');
  });

  it('refuses another context, another key version, a wrong key, or a tampered record', () => {
    const box = makeSecretBox(new Map([[1, key(1)]]), 1);
    const sealed = box.seal('sk-secret', 'connection:u1:c1');
    expect(box.open(sealed, 1, 'connection:u2:c1')).toBeUndefined();
    expect(box.open(sealed, 2, 'connection:u1:c1')).toBeUndefined();
    expect(
      makeSecretBox(new Map([[1, key(2)]]), 1).open(sealed, 1, 'connection:u1:c1'),
    ).toBeUndefined();
    const [iv, body, tag] = sealed.split('.');
    const flipped = Buffer.from(body!, 'base64');
    flipped[0] = flipped[0]! ^ 1;
    expect(
      box.open([iv, flipped.toString('base64'), tag].join('.'), 1, 'connection:u1:c1'),
    ).toBeUndefined();
    expect(box.open('garbage', 1, 'connection:u1:c1')).toBeUndefined();
  });

  it('opens records of an older key version after a rotation', () => {
    const old = makeSecretBox(new Map([[1, key(1)]]), 1);
    const sealed = old.seal('sk-secret', 'ctx');
    const rotated = makeSecretBox(
      new Map([
        [1, key(1)],
        [2, key(2)],
      ]),
      2,
    );
    expect(rotated.open(sealed, 1, 'ctx')).toBe('sk-secret');
    expect(rotated.version).toBe(2);
  });

  it('requires a 32-byte base64 master key and never echoes it', () => {
    expect(() => loadMasterKey({})).toThrow(/KD_LEARN_SECRET_KEY is missing/);
    const short = Buffer.alloc(16, 1).toString('base64');
    expect(() => loadMasterKey({ KD_LEARN_SECRET_KEY: short })).toThrow(/32 bytes/);
    try {
      loadMasterKey({ KD_LEARN_SECRET_KEY: 'not base64 !!' });
    } catch (error) {
      expect(String(error)).not.toContain('not base64');
    }
    expect(loadMasterKey({ KD_LEARN_SECRET_KEY: key(3).toString('base64') })).toEqual(key(3));
  });
});
