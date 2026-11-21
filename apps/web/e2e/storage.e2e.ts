// Browser tests of the local DB (plan step 5, risk 20): the real wa-sqlite driver in a real
// Worker on OPFS, reached through the harness route `/dev/storage`.
import { expect, test, type Page } from '@playwright/test';
import type { DomainEvent } from '@kd-learn/core';

const profile = {
  id: 'default',
  language: 'en',
  maxProbeQuestions: 3,
  maxTurnsPerStep: 4,
  prompts: { prober: 'p', teacher: 't', sideChat: 's' },
};

type TurnStarted = Extract<DomainEvent, { _tag: 'TurnStarted' }>;
let counter = 0;
const turnStarted = (id: string, at = 1000 + counter++): TurnStarted => ({
  _tag: 'TurnStarted',
  id,
  at,
  turnId: `turn-${id}`,
  input: `input ${id}`,
});

/** Opens the harness and waits until the store is open. Skips when the browser context has no OPFS. */
async function openHarness(page: Page) {
  await page.goto('/dev/storage');
  await expect(page.locator('#storage-state')).toHaveText('ready');
  const persistent = await page.evaluate(() => window.__kdStorage!.persistent());
  // Chromium must have OPFS (a skip there would hide a broken driver). Playwright's WebKit uses a
  // temporary context without OPFS: storage falls back to memory, and these tests do not apply.
  if (test.info().project.name === 'chromium') expect(persistent).toBe(true);
  else test.skip(!persistent, 'No OPFS in this browser context: storage fell back to memory');
}

const append = (page: Page, sessionId: string, events: DomainEvent[]) =>
  page.evaluate(([s, e]) => window.__kdStorage!.append(s, e), [sessionId, events] as const);
const read = (page: Page, sessionId: string) =>
  page.evaluate((s) => window.__kdStorage!.read(s), sessionId);

test('events written in one page load are read back after a reload', async ({ page }) => {
  await openHarness(page);
  const log: DomainEvent[] = [
    { _tag: 'SessionCreated', id: 'e1', at: 1, sessionId: 's1', topic: 'Fractions', profile },
    turnStarted('e2', 2),
    {
      _tag: 'MessageAppended',
      id: 'e3',
      at: 3,
      turnId: 'turn-e2',
      messageId: 'm1',
      agent: 'prober',
      content: 'What is a fraction?',
    },
    { _tag: 'TurnCompleted', id: 'e4', at: 4, turnId: 'turn-e2', reason: 'stop' },
  ];
  expect(await append(page, 's1', log)).toEqual({ lastSeq: 3 });
  expect(await page.evaluate(() => window.__kdStorage!.state('s1'))).toBe('Probing');

  await page.reload();
  await expect(page.locator('#storage-state')).toHaveText('ready');

  expect(await read(page, 's1')).toEqual(log);
  expect(await page.evaluate(() => window.__kdStorage!.state('s1'))).toBe('Probing');
  expect(await page.evaluate(() => window.__kdStorage!.list())).toEqual([
    { sessionId: 's1', topic: 'Fractions', createdAt: 1, updatedAt: 4, eventCount: 4 },
  ]);
  // The store hooks show the same data without the test asking.
  await expect(page.locator('#session-count')).toHaveText('sessions: 1');
});

test('a turn batch is atomic: a failing batch leaves nothing behind', async ({ page }) => {
  await openHarness(page);
  await append(page, 's1', [turnStarted('a'), turnStarted('b')]);

  // The third event reuses an id, so the database rejects it after two valid inserts.
  const failed = await append(page, 's1', [turnStarted('c'), turnStarted('d'), turnStarted('a')]);
  expect(failed).toMatchObject({ error: 'StorageFailure' });
  expect((await read(page, 's1')) as DomainEvent[]).toHaveLength(2);

  // Nothing leaked into the sequence either: the next batch continues right after `b`.
  expect(await append(page, 's1', [turnStarted('e')])).toEqual({ lastSeq: 2 });

  await page.reload();
  await expect(page.locator('#storage-state')).toHaveText('ready');
  const ids = ((await read(page, 's1')) as DomainEvent[]).map((event) => event.id);
  expect(ids).toEqual(['a', 'b', 'e']);
});

test('an existing event id is rejected and the stored event stays unchanged', async ({ page }) => {
  await openHarness(page);
  await append(page, 's1', [turnStarted('a')]);
  // Reusing an id is the only way to try to overwrite an event through the port.
  expect(await append(page, 's1', [{ ...turnStarted('a'), input: 'changed' }])).toMatchObject({
    error: 'StorageFailure',
  });
  const [only] = (await read(page, 's1')) as Extract<DomainEvent, { _tag: 'TurnStarted' }>[];
  expect(only?.input).toMatch(/^input a/);
});

test('guest settings persist and the key can be deleted alone', async ({ page }) => {
  await openHarness(page);
  expect(await page.evaluate(() => window.__kdStorage!.getSettings())).toBeUndefined();

  const settings = { provider: 'anthropic', model: 'haiku', apiKey: 'sk-test-123' } as const;
  await page.evaluate((s) => window.__kdStorage!.saveSettings(s), settings);
  await page.reload();
  await expect(page.locator('#storage-state')).toHaveText('ready');
  expect(await page.evaluate(() => window.__kdStorage!.getSettings())).toEqual(settings);

  await page.evaluate(() => window.__kdStorage!.deleteApiKey());
  await page.reload();
  await expect(page.locator('#storage-state')).toHaveText('ready');
  expect(await page.evaluate(() => window.__kdStorage!.getSettings())).toEqual({
    provider: 'anthropic',
    model: 'haiku',
  });
});

test('two tabs write to one session at once without losing or duplicating events', async ({
  context,
}) => {
  const first = await context.newPage();
  const second = await context.newPage();
  await openHarness(first);
  await openHarness(second);

  const batches = 20;
  const writer = (tab: string) =>
    async function (page: Page) {
      await page.evaluate(
        async ([name, count]) => {
          for (let i = 0; i < count; i++) {
            const result = await window.__kdStorage!.append('shared', [
              {
                _tag: 'TurnStarted',
                id: `${name}-${i}-a`,
                at: i,
                turnId: `${name}-${i}`,
                input: 'x',
              },
              {
                _tag: 'TurnCompleted',
                id: `${name}-${i}-b`,
                at: i,
                turnId: `${name}-${i}`,
                reason: 'stop',
              },
            ]);
            if ('error' in result) throw new Error(result.message);
          }
        },
        [tab, batches] as const,
      );
    };
  await Promise.all([writer('one')(first), writer('two')(second)]);

  const log = (await read(first, 'shared')) as DomainEvent[];
  expect(log).toHaveLength(batches * 2 * 2);
  expect(new Set(log.map((event) => event.id)).size).toBe(log.length);
  // Each batch stays together: a turn's two events are neighbours, whichever tab wrote them.
  for (let i = 0; i < log.length; i += 2) {
    expect(log[i]?.id.endsWith('-a')).toBe(true);
    expect(log[i + 1]?.id).toBe(log[i]?.id.replace(/-a$/, '-b'));
  }
  expect(await read(second, 'shared')).toEqual(log);
});

test('a commit in one tab refreshes the other tab', async ({ context }) => {
  const writer = await context.newPage();
  const viewer = await context.newPage();
  await openHarness(writer);
  await openHarness(viewer);
  await expect(viewer.locator('#view-events')).toHaveText('view events: 0');

  await append(writer, 'view', [turnStarted('v1'), turnStarted('v2')]);
  await expect(viewer.locator('#view-events')).toHaveText('view events: 2');
  await expect(viewer.locator('#session-count')).toHaveText('sessions: 1');
});
