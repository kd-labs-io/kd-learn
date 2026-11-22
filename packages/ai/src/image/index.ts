// Image adapters (phase 5 A6, spike C4): plain HTTP, not TanStack AI's `generateImage` (it cannot
// ask Gemini for JPEG and drops the mime type). Errors carry fixed messages and an HTTP status only:
// provider bodies can echo part of the key (risk 19). The key goes in a header, never in the URL.
import { Effect, Layer } from 'effect';
import {
  ImagePort,
  ImageRefused,
  ProviderError,
  type GeneratedImage,
  type ImageAspect,
  type ImageMime,
  type ImageRequest,
  type ImageUsage,
} from '../port/index.ts';

/** Largest image accepted (plan A1), and so the largest response read. */
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_BYTES = Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 256 * 1024;
export const IMAGE_TIMEOUT_MS = 90_000;
const GEMINI_BASE = 'https://generativelanguage.googleapis.com';

export interface ImageAdapterOptions {
  readonly fetch?: typeof fetch;
  readonly geminiBaseURL?: string;
  readonly timeoutMs?: number;
}

const providerError = (message: string, code: string) => new ProviderError({ message, code });

const statusError = (status: number) =>
  status === 401 || status === 403
    ? providerError(`The image provider refused the key (HTTP ${status}).`, 'ProviderAuth')
    : status === 429
      ? providerError('The image provider is rate limiting (HTTP 429).', 'RateLimited')
      : status === 400
        ? providerError('The image provider rejected the request (HTTP 400).', 'ProviderError')
        : providerError(`The image provider failed (HTTP ${status}).`, 'ProviderError');

/**
 * The image type, from the magic bytes only: a declared type that does not match the bytes is not
 * trusted, and anything that is not JPEG, PNG or WebP is refused.
 */
export const imageMime = (bytes: Uint8Array): ImageMime | undefined =>
  bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    ? 'image/jpeg'
    : bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
      ? 'image/png'
      : bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57 && bytes[9] === 0x45
        ? 'image/webp'
        : undefined;

const decodeBase64 = (text: string): Uint8Array | undefined => {
  if (text.length > MAX_RESPONSE_BYTES) return undefined;
  try {
    return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
  } catch {
    return undefined;
  }
};

/** POSTs JSON and reads at most `MAX_RESPONSE_BYTES` of the answer. */
const postJson = (
  options: ImageAdapterOptions,
  url: string,
  headers: Record<string, string>,
  body: unknown,
) =>
  Effect.tryPromise({
    try: async (signal) => {
      const response = await (options.fetch ?? fetch)(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal,
        redirect: 'error',
      });
      const reader = response.body?.getReader();
      const chunks: Array<Uint8Array> = [];
      let size = 0;
      if (reader !== undefined) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_RESPONSE_BYTES) {
            await reader.cancel();
            return { status: response.status, json: undefined, tooLarge: true };
          }
          chunks.push(value);
        }
      }
      const all = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        all.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const text = new TextDecoder().decode(all);
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
      return { status: response.status, json, tooLarge: false };
    },
    catch: () => providerError('The image provider could not be reached.', 'ProviderUnreachable'),
  }).pipe(
    Effect.timeoutOrElse({
      duration: options.timeoutMs ?? IMAGE_TIMEOUT_MS,
      orElse: () =>
        Effect.fail(providerError('The image provider took too long.', 'ProviderTimeout')),
    }),
    Effect.flatMap((answer) =>
      answer.tooLarge
        ? Effect.fail(providerError('The image is larger than 2 MiB.', 'ImageTooLarge'))
        : answer.status >= 200 && answer.status < 300
          ? Effect.succeed(answer.json)
          : Effect.fail(statusError(answer.status)),
    ),
  );

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const count = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;

const finish = (
  bytes: Uint8Array | undefined,
  usage: ImageUsage,
  refusal: string,
): Effect.Effect<GeneratedImage, ProviderError | ImageRefused> => {
  if (bytes === undefined) {
    return Effect.fail(new ImageRefused({ message: refusal.slice(0, 300), usage }));
  }
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    return Effect.fail(providerError('The image is larger than 2 MiB.', 'ImageTooLarge'));
  }
  const mime = imageMime(bytes);
  if (mime === undefined) {
    return Effect.fail(
      providerError('The provider sent something that is not an image.', 'ProviderError'),
    );
  }
  return Effect.succeed({ mime, bytes, usage });
};

const geminiAspect: Record<ImageAspect, string> = {
  square: '1:1',
  landscape: '16:9',
  portrait: '9:16',
};

/** Gemini Interactions API (spike C4): JPEG only, 1K. A 200 without an image is a refusal. */
const gemini = (
  options: ImageAdapterOptions,
  request: ImageRequest & { model: { provider: 'gemini' } },
) =>
  postJson(
    options,
    `${options.geminiBaseURL ?? GEMINI_BASE}/v1beta/interactions`,
    { 'x-goog-api-key': request.model.apiKey, 'Api-Revision': '2026-05-20' },
    {
      model: request.model.model,
      input: request.prompt,
      stream: false,
      store: false,
      response_format: {
        type: 'image',
        aspect_ratio: geminiAspect[request.aspect],
        image_size: '1K',
        mime_type: 'image/jpeg',
      },
    },
  ).pipe(
    Effect.flatMap((json) => {
      const body = record(json);
      const usage = record(body['usage']);
      const used = {
        inputTokens: count(usage['total_input_tokens']),
        outputTokens: count(usage['total_output_tokens']),
      };
      const contents = (Array.isArray(body['steps']) ? body['steps'] : [])
        .map(record)
        .filter((step) => step['type'] === 'model_output')
        .flatMap((step) => (Array.isArray(step['content']) ? step['content'] : []))
        .map(record);
      const image = contents.find((c) => c['type'] === 'image' && typeof c['data'] === 'string');
      const said = contents.find((c) => c['type'] === 'text' && typeof c['text'] === 'string');
      return finish(
        image === undefined ? undefined : decodeBase64(String(image['data'])),
        used,
        said === undefined ? 'The image provider declined this prompt.' : String(said['text']),
      );
    }),
  );

const openaiSize: Record<ImageAspect, string> = {
  square: '1024x1024',
  landscape: '1536x1024',
  portrait: '1024x1536',
};

/** OpenAI-compatible `POST {base}/images/generations` (OpenAI, OpenRouter): JPEG, compressed. */
const openaiCompatible = (
  options: ImageAdapterOptions,
  request: ImageRequest & { model: { provider: 'openai-compatible' } },
) =>
  postJson(
    options,
    `${request.model.baseURL.replace(/\/+$/, '')}/images/generations`,
    { authorization: `Bearer ${request.model.apiKey}` },
    {
      model: request.model.model,
      prompt: request.prompt,
      n: 1,
      size: openaiSize[request.aspect],
      quality: 'medium',
      output_format: 'jpeg',
      output_compression: 75,
      // No `response_format`: gpt-image models always answer in base64 and may reject it, and
      // OpenRouter does not list it (checked 2026-11-22).
    },
  ).pipe(
    Effect.flatMap((json) => {
      const body = record(json);
      const usage = record(body['usage']);
      const used = {
        inputTokens: count(usage['input_tokens'] ?? usage['prompt_tokens']),
        outputTokens: count(usage['output_tokens'] ?? usage['completion_tokens']),
      };
      const first = record(Array.isArray(body['data']) ? body['data'][0] : undefined);
      return finish(
        typeof first['b64_json'] === 'string' ? decodeBase64(first['b64_json']) : undefined,
        used,
        'The image provider declined this prompt.',
      );
    }),
  );

export const makeImageService = (options: ImageAdapterOptions = {}): ImagePort['Service'] => ({
  generate: (request) =>
    request.model.provider === 'gemini'
      ? gemini(options, request as ImageRequest & { model: { provider: 'gemini' } })
      : openaiCompatible(
          options,
          request as ImageRequest & { model: { provider: 'openai-compatible' } },
        ),
});

export const imageLayer = (options: ImageAdapterOptions = {}) =>
  Layer.succeed(ImagePort, makeImageService(options));
