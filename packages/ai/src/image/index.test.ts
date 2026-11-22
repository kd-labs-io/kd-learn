import { Effect, Exit } from 'effect';
import { describe, expect, it } from 'vitest';
import type { ImageRequest } from '../port/index.ts';
import { MAX_IMAGE_BYTES, imageMime, makeImageService } from './index.ts';

const KEY = 'AIza-SECRET-image-key-0123456789';
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

type Seen = { url: string; init: RequestInit };
const fakeFetch = (status: number, body: unknown, seen: Array<Seen> = []) =>
  (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  }) as unknown as typeof fetch;

const gemini: ImageRequest = {
  model: { provider: 'gemini', model: 'gemini-3.1-flash-lite-image', apiKey: KEY },
  prompt: 'A cat',
  aspect: 'landscape',
};
const openai: ImageRequest = {
  model: {
    provider: 'openai-compatible',
    model: 'gpt-image-2',
    apiKey: KEY,
    baseURL: 'https://img.test/v1/',
  },
  prompt: 'A cat',
  aspect: 'square',
};
const geminiOk = {
  usage: { total_input_tokens: 31, total_output_tokens: 1477 },
  steps: [
    { type: 'thought', signature: 'x' },
    {
      type: 'model_output',
      content: [{ type: 'image', mime_type: 'image/jpeg', data: b64(JPEG) }],
    },
  ],
};

const run = (request: ImageRequest, f: typeof fetch, timeoutMs?: number) =>
  Effect.runPromiseExit(
    makeImageService({ fetch: f, ...(timeoutMs ? { timeoutMs } : {}) }).generate(request),
  );

describe('image adapters', () => {
  it('Gemini: asks for JPEG with the key in a header, returns bytes, mime and usage', async () => {
    const seen: Array<Seen> = [];
    const exit = await run(gemini, fakeFetch(200, geminiOk, seen));
    expect(exit).toEqual(
      Exit.succeed({
        mime: 'image/jpeg',
        bytes: JPEG,
        usage: { inputTokens: 31, outputTokens: 1477 },
      }),
    );
    expect(seen[0]!.url).toBe('https://generativelanguage.googleapis.com/v1beta/interactions');
    expect(seen[0]!.url).not.toContain(KEY);
    expect((seen[0]!.init.headers as Record<string, string>)['x-goog-api-key']).toBe(KEY);
    const sent = JSON.parse(String(seen[0]!.init.body)) as {
      response_format: Record<string, string>;
    };
    expect(sent.response_format).toMatchObject({ mime_type: 'image/jpeg', aspect_ratio: '16:9' });
  });

  it('Gemini: a 200 with only text is a refusal that keeps the usage', async () => {
    const exit = await run(
      gemini,
      fakeFetch(200, {
        usage: { total_input_tokens: 22, total_output_tokens: 15 },
        steps: [{ type: 'model_output', content: [{ type: 'text', text: "I can't draw that." }] }],
      }),
    );
    expect(exit).toMatchObject({
      _tag: 'Failure',
    });
    const error = Exit.isFailure(exit)
      ? (exit.cause.reasons[0] as { error?: unknown }).error
      : undefined;
    expect(error).toMatchObject({
      _tag: 'ImageRefused',
      message: "I can't draw that.",
      usage: { inputTokens: 22, outputTokens: 15 },
    });
  });

  it('never passes the provider body on: a key echoed in an error stays out', async () => {
    for (const status of [400, 401, 429, 500]) {
      const exit = await run(openai, fakeFetch(status, { error: { message: `bad key ${KEY}` } }));
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).not.toContain(KEY);
    }
  });

  it('OpenAI-compatible: posts to {base}/images/generations, Bearer key, JPEG', async () => {
    const seen: Array<Seen> = [];
    const exit = await run(
      openai,
      fakeFetch(
        200,
        {
          data: [{ b64_json: b64(JPEG), media_type: 'image/png' }],
          usage: { input_tokens: 5, output_tokens: 9 },
        },
        seen,
      ),
    );
    // The bytes decide the type, not the declared one.
    expect(exit).toEqual(
      Exit.succeed({ mime: 'image/jpeg', bytes: JPEG, usage: { inputTokens: 5, outputTokens: 9 } }),
    );
    expect(seen[0]!.url).toBe('https://img.test/v1/images/generations');
    expect((seen[0]!.init.headers as Record<string, string>)['authorization']).toBe(
      `Bearer ${KEY}`,
    );
    expect(JSON.parse(String(seen[0]!.init.body))).toMatchObject({
      output_format: 'jpeg',
      size: '1024x1024',
    });
  });

  it('refuses an image over 2 MiB, a response far over it, and bytes that are not an image', async () => {
    const big = new Uint8Array(MAX_IMAGE_BYTES + 1);
    big.set(JPEG);
    let binary = '';
    for (const byte of big) binary += String.fromCharCode(byte);
    const overCap = await run(openai, fakeFetch(200, { data: [{ b64_json: btoa(binary) }] }));
    expect(JSON.stringify(overCap)).toContain('ImageTooLarge');
    const huge = await run(openai, fakeFetch(200, { data: [{ b64_json: 'A'.repeat(4_000_000) }] }));
    expect(JSON.stringify(huge)).toContain('ImageTooLarge');
    const text = await run(
      openai,
      fakeFetch(200, { data: [{ b64_json: b64(new TextEncoder().encode('<html>')) }] }),
    );
    expect(Exit.isFailure(text)).toBe(true);
  });

  it('times out', async () => {
    const never = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) =>
        init.signal?.addEventListener('abort', () => reject(new Error('aborted'))),
      )) as unknown as typeof fetch;
    const exit = await run(gemini, never, 50);
    expect(JSON.stringify(exit)).toContain('ProviderTimeout');
  });

  it('sniffs JPEG, PNG and WebP only', () => {
    expect(imageMime(JPEG)).toBe('image/jpeg');
    expect(imageMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe('image/png');
    expect(imageMime(new TextEncoder().encode('RIFF\0\0\0\0WEBP'))).toBe('image/webp');
    expect(imageMime(new TextEncoder().encode('<svg'))).toBeUndefined();
  });
});
