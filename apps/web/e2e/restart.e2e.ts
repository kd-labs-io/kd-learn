// A background job survives a server restart (phase 4 A5): an account research is cut off by a
// SIGKILL while the model call is held, and the restarted server runs it again until it is
// `ready`. The test runs its own server (own port and database), so it can kill it; the fake model
// holds the first structured call of a key containing `slow-extract` and lets the next one through.
import { expect, test } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeModelPort, fakeSearchPort, restartPort } from './accounts-env';

const base = `http://localhost:${restartPort}`;
const appDir = fileURLToPath(new URL('..', import.meta.url));
const unique = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

const start = (dbDir: string): ChildProcess =>
  spawn('node', ['.output/server/index.mjs'], {
    cwd: appDir,
    stdio: 'ignore',
    env: {
      ...process.env,
      PORT: String(restartPort),
      KD_LEARN_DB_PATH: join(dbDir, 'accounts.db'),
      // A throwaway key for this test database only.
      KD_LEARN_SECRET_KEY: Buffer.alloc(32, 7).toString('base64'),
      KD_LEARN_REGISTRATION: 'open',
      KD_OPENAI_COMPATIBLE_ENDPOINTS: JSON.stringify([
        { id: 'fake', label: 'Fake model', baseURL: `http://localhost:${fakeModelPort}/v1` },
      ]),
      KD_SEARXNG_URL: `http://localhost:${fakeSearchPort}`,
    },
  });

const up = () =>
  expect
    .poll(async () => (await fetch(`${base}/api/config`).catch(() => undefined))?.status, {
      timeout: 20_000,
    })
    .toBe(200);

const stop = (server: ChildProcess) =>
  new Promise<void>((resolve) => {
    if (server.exitCode !== null || server.signalCode !== null) return resolve();
    server.once('exit', () => resolve());
    server.kill('SIGKILL');
  });

test('an account research cut off by a restart ends ready', async ({ request }, info) => {
  test.skip(info.project.name !== 'chromium', 'One server process: one browser is enough.');
  test.setTimeout(90_000);
  const dbDir = mkdtempSync(join(tmpdir(), 'kd-learn-restart-'));
  let server = start(dbDir);
  try {
    await up();
    const registered = await request.post(`${base}/api/auth/register`, {
      data: { email: `restart-${unique()}@e2e.test`, password: 'learner-password-1' },
    });
    expect(registered.status()).toBe(201);
    const { token } = (await registered.json()) as { token: string };
    const call = async (method: string, path: string, data?: unknown) => {
      const response = await request.fetch(`${base}/api/account/${path}`, {
        method,
        headers: { authorization: `Bearer ${token}` },
        ...(data === undefined ? {} : { data }),
      });
      return {
        status: response.status(),
        json: (await response.json().catch(() => ({}))) as never,
      };
    };
    const key = `slow-extract-restart-${unique()}-0123456789`;
    const connection = (await call('POST', 'connections', {
      label: 'Fake',
      provider: 'openai-compatible',
      endpointId: 'fake',
      apiKey: key,
    })) as { json: { id: string } };
    const role = { connectionId: connection.json.id, model: 'fake-model' };
    await call('PUT', 'roles', { roles: { prober: role, teacher: role, sideChat: role } });

    const created = (await call('POST', 'research', {
      question: `Tides ${unique()}`,
      language: 'en',
      provider: 'searxng',
    })) as { status: number; json: { source: { sourceId: string; state: string } } };
    expect(created.status).toBe(202);
    const { sourceId } = created.json.source;

    // The model call is held: the job is running when the server dies.
    await expect
      .poll(
        async () =>
          (
            (await (
              await fetch(`http://localhost:${fakeModelPort}/calls/${encodeURIComponent(key)}`)
            ).json()) as { calls: number }
          ).calls,
      )
      .toBeGreaterThan(0);
    const state = async () =>
      ((await call('GET', `sources/${sourceId}`)) as { json: { source?: { state: string } } }).json
        .source?.state;
    expect(await state()).toBe('pending');
    await stop(server);

    server = start(dbDir);
    await up();
    await expect.poll(state, { timeout: 30_000 }).toBe('ready');
  } finally {
    await stop(server);
    rmSync(dbDir, { recursive: true, force: true });
  }
});
