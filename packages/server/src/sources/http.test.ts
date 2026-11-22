import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect } from 'effect';
import { afterAll, describe, expect, it } from 'vitest';
import { MAX_PDF_BYTES } from '@kd-learn/api';
import type { SourceInfo } from '@kd-learn/core';
import { make, USER } from '../auth/test-support.ts';
import type { Handlers } from '../index.ts';
import { extractPdf, type PdfExtractor } from './pdf.ts';

const dir = mkdtempSync(join(tmpdir(), 'kd-sources-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const viPdf = readFileSync(new URL('../../test/fixtures/pdf/vi-5pages.pdf', import.meta.url));

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
const until = async (check: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 1000; i++) {
    if (await check()) return;
    await tick();
  }
  throw new Error('timed out waiting');
};

/** An extractor that never answers (a job cut by a restart). */
const hanging: PdfExtractor = () => Effect.never;

const setup = async (options: { dbPath?: string; extract?: PdfExtractor; register?: boolean }) => {
  const { handlers } = make(
    {},
    {
      ...(options.dbPath === undefined ? {} : { dbPath: options.dbPath }),
      extractPdf: options.extract ?? extractPdf,
    },
  );
  const call = (
    handler: Handlers[keyof Handlers],
    method: string,
    path: string,
    init: {
      token?: string;
      json?: unknown;
      body?: FormData | ReadableStream<Uint8Array>;
      type?: string;
    } = {},
  ) =>
    handler(
      new Request(`http://kd.test${path}`, {
        method,
        headers: {
          ...(init.json === undefined ? {} : { 'content-type': 'application/json' }),
          ...(init.type === undefined ? {} : { 'content-type': init.type }),
          ...(init.token === undefined ? {} : { authorization: `Bearer ${init.token}` }),
        },
        ...(init.json === undefined ? {} : { body: JSON.stringify(init.json) }),
        ...(init.body === undefined ? {} : { body: init.body }),
        ...(init.body instanceof ReadableStream ? { duplex: 'half' } : {}),
      } as RequestInit),
    );
  const signIn = async (email: string, password: string, register: boolean) => {
    const response = await call(
      register ? handlers.register : handlers.login,
      'POST',
      register ? '/api/auth/register' : '/api/auth/login',
      { json: { email, password } },
    );
    return ((await response.json()) as { token: string }).token;
  };
  const register = options.register ?? true;
  const token = await signIn(USER.email, USER.password, register);
  const other = await signIn('other@kd.test', 'other-password-1', register);
  const account = (method: string, path: string, init: Parameters<typeof call>[3] = {}) =>
    call(handlers.account, method, `/api/account/${path}`, { token, ...init });
  const upload = (bytes: Uint8Array, name = 'Giáo trình.pdf', as = token) => {
    const form = new FormData();
    form.set('file', new Blob([bytes as Uint8Array<ArrayBuffer>]), name);
    return call(handlers.account, 'POST', '/api/account/sources', { token: as, body: form });
  };
  const list = async (as = token) =>
    (
      (await (
        await call(handlers.account, 'GET', '/api/account/sources', { token: as })
      ).json()) as { sources: SourceInfo[] }
    ).sources;
  return { handlers, call, account, upload, list, token, other };
};

describe('account sources', () => {
  it('reads an uploaded PDF in a job: pending, then ready with page chunks', async () => {
    const app = await setup({});
    const response = await app.upload(viPdf);
    expect(response.status).toBe(202);
    const { source } = (await response.json()) as { source: SourceInfo };
    expect(source).toMatchObject({ kind: 'pdf', title: 'Giáo trình', state: 'pending' });
    await until(async () => (await app.list())[0]?.state === 'ready');
    const detail = (await (await app.account('GET', `sources/${source.sourceId}`)).json()) as {
      source: SourceInfo;
      chunks: Array<{ text: string; locator: { page?: number } }>;
    };
    expect(detail.source.chunkCount).toBe(detail.chunks.length);
    expect(detail.chunks[0]!.text).toContain('Tìm kiếm nhị phân');
    expect(detail.chunks.at(-1)!.locator.page).toBe(5);
  });

  it('fails a scan with NoText, refuses a non-PDF and a file over the limit while reading', async () => {
    const app = await setup({
      extract: () => Effect.succeed({ ok: true, pages: [{ page: 1, items: [] }] }),
    });
    await app.upload(viPdf, 'scan.pdf');
    await until(async () => (await app.list())[0]?.state === 'failed');
    expect((await app.list())[0]!.failure?.code).toBe('NoText');

    expect((await app.upload(new TextEncoder().encode('hello'), 'x.pdf')).status).toBe(400);

    // A body that never ends: the server stops reading past the limit.
    let sent = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += 1024 * 1024;
        controller.enqueue(new Uint8Array(1024 * 1024));
      },
    });
    const big = await app.call(app.handlers.account, 'POST', '/api/account/sources', {
      token: app.token,
      body: endless,
      type: 'multipart/form-data; boundary=x',
    });
    expect(big.status).toBe(413);
    expect(sent).toBeLessThan(MAX_PDF_BYTES + 4 * 1024 * 1024);
  });

  it('creates a note from chunks, and keeps sources per account', async () => {
    const app = await setup({});
    const created = await app.account('POST', 'sources', {
      json: {
        kind: 'note',
        title: 'Ghi chú',
        origin: 'notes.md',
        chunks: [{ ordinal: 0, text: 'Một đoạn.', locator: { heading: 'Mở đầu' } }],
      },
    });
    expect(created.status).toBe(201);
    const { source } = (await created.json()) as { source: SourceInfo };
    expect(source).toMatchObject({ kind: 'note', state: 'ready', chunkCount: 1 });

    // Another account sees nothing, cannot read, retry or delete it.
    expect(await app.list(app.other)).toEqual([]);
    const path = `/api/account/sources/${source.sourceId}`;
    const asOther = { token: app.other };
    expect((await app.call(app.handlers.account, 'GET', path, asOther)).status).toBe(404);
    expect((await app.call(app.handlers.account, 'POST', `${path}/retry`, asOther)).status).toBe(
      404,
    );
    expect((await app.call(app.handlers.account, 'DELETE', path, asOther)).status).toBe(204);
    expect(await app.list()).toHaveLength(1);
    expect((await app.account('POST', `sources/${source.sourceId}/retry`)).status).toBe(409);

    expect((await app.account('DELETE', `sources/${source.sourceId}`)).status).toBe(204);
    expect(await app.list()).toEqual([]);
    expect((await app.call(app.handlers.account, 'GET', '/api/account/sources', {})).status).toBe(
      401,
    );
  });

  it('runs an ingest cut by a restart again, and it completes', async () => {
    const dbPath = join(dir, 'restart.db');
    const before = await setup({ dbPath, extract: hanging });
    await before.upload(viPdf);
    await tick();
    expect((await before.list())[0]!.state).toBe('pending');

    const after = await setup({ dbPath, register: false });
    await until(async () => (await after.list())[0]?.state === 'ready');
    expect((await after.list())[0]!.chunkCount).toBeGreaterThan(0);
  });

  it('retries a failed PDF from its kept file', async () => {
    let calls = 0;
    const app = await setup({
      extract: (data, options) => {
        calls += 1;
        return calls === 1
          ? Effect.succeed({ ok: false, code: 'Timeout' })
          : extractPdf(data, options);
      },
    });
    await app.upload(viPdf);
    await until(async () => (await app.list())[0]?.state === 'failed');
    const id = (await app.list())[0]!.sourceId;
    expect((await app.account('POST', `sources/${id}/retry`)).status).toBe(202);
    await until(async () => (await app.list())[0]?.state === 'ready');
  });
});
