// Browser tests of the local DB (plan step 5, risk 20): the real wa-sqlite driver in a real
// Worker on OPFS, reached through the harness route `/dev/storage`.
import { expect, test, type Page } from '@playwright/test';
import type { DomainEvent, KnowledgeEvent } from '@kd-learn/core';

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

test('the saved teaching profile persists, rejects one out of bounds, and resets', async ({
  page,
}) => {
  await openHarness(page);
  expect(await page.evaluate(() => window.__kdStorage!.getProfile())).toBeUndefined();

  const profile = {
    id: 'mine',
    language: 'vi',
    maxProbeQuestions: 2,
    maxTurnsPerStep: 3,
    prompts: { prober: 'p', teacher: 't', sideChat: 's', merge: 'm' },
  };
  await page.evaluate((p) => window.__kdStorage!.saveProfile(p), profile);
  await page.reload();
  await expect(page.locator('#storage-state')).toHaveText('ready');
  expect(await page.evaluate(() => window.__kdStorage!.getProfile())).toEqual(profile);

  const rejected = await page.evaluate(
    (p) => window.__kdStorage!.saveProfile({ ...p, maxTurnsPerStep: 0 }),
    profile,
  );
  expect(rejected).toMatchObject({ error: 'StorageFailure' });
  expect(await page.evaluate(() => window.__kdStorage!.getProfile())).toEqual(profile);

  await page.evaluate(() => window.__kdStorage!.saveProfile(undefined));
  expect(await page.evaluate(() => window.__kdStorage!.getProfile())).toBeUndefined();
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

test('overlapping calls in one tab run one at a time: a failing batch cannot damage the others', async ({
  page,
}) => {
  await openHarness(page);
  const outcome = await page.evaluate(async () => {
    const api = window.__kdStorage!;
    const batch = (i: number, lastId = `b${i}-2`) =>
      [`b${i}-0`, `b${i}-1`, lastId].map((id) => ({
        _tag: 'TurnStarted' as const,
        id,
        at: i,
        turnId: `t${i}`,
        input: 'x',
      }));
    // Sent in the same tick, like a side chat message during a turn plus a settings save.
    const calls: Promise<unknown>[] = [];
    for (let i = 0; i < 12; i++) {
      // Batch 5 ends with the id of an event of batch 1: it must fail as a whole.
      calls.push(api.append('s1', batch(i, i === 5 ? 'b1-0' : undefined)));
      if (i % 3 === 0) calls.push(api.read('s1'));
      if (i === 4) calls.push(api.saveSettings({ provider: 'gemini', model: 'flash' }));
    }
    const results = await Promise.all(calls);
    return {
      errors: results.filter((r) => r && typeof r === 'object' && 'error' in r),
      readSizes: results.filter(Array.isArray).map((log) => log.length),
      log: (await api.read('s1')) as unknown as { id: string }[],
      settings: await api.getSettings(),
    };
  });

  expect(outcome.errors).toHaveLength(1);
  expect(outcome.errors[0]).toMatchObject({ error: 'StorageFailure' });
  // A read never sees half a batch.
  for (const size of outcome.readSizes) expect(size % 3).toBe(0);
  expect(outcome.log).toHaveLength(11 * 3);
  expect(outcome.log.some((event) => event.id.startsWith('b5-'))).toBe(false);
  for (let i = 0; i < outcome.log.length; i += 3) {
    const prefix = outcome.log[i]!.id.split('-')[0];
    expect(outcome.log.slice(i, i + 3).map((event) => event.id)).toEqual([
      `${prefix}-0`,
      `${prefix}-1`,
      `${prefix}-2`,
    ]);
  }
  expect(outcome.settings).toEqual({ provider: 'gemini', model: 'flash' });
});

const proposition = (id: string): KnowledgeEvent => ({
  _tag: 'PropositionAdded',
  id,
  at: 1000 + counter++,
  propositionId: `p-${id}`,
  text: `Claim ${id}.`,
  topic: 'Search',
  source: { sessionId: 's1' },
});

test('the knowledge log persists, rejects a batch with a used id, and checks the expected seq', async ({
  page,
}) => {
  await openHarness(page);
  const api = (events: KnowledgeEvent[], expectedLastSeq: number) =>
    page.evaluate(([e, seq]) => window.__kdStorage!.appendKnowledge(e, seq), [
      events,
      expectedLastSeq,
    ] as const);

  expect(await api([proposition('k1'), proposition('k2')], -1)).toEqual({ lastSeq: 1 });
  // A second writer that read the empty log is refused, and writes nothing.
  expect(await api([proposition('k3')], -1)).toMatchObject({ error: 'KnowledgeConflict' });
  expect(await api([proposition('k3'), proposition('k1')], 1)).toMatchObject({
    error: 'StorageFailure',
  });
  // The session log is separate: the same ids are free there.
  expect(await append(page, 'k', [turnStarted('k1')])).toEqual({ lastSeq: 0 });

  await page.reload();
  await expect(page.locator('#storage-state')).toHaveText('ready');
  const log = (await page.evaluate(() => window.__kdStorage!.readKnowledge())) as KnowledgeEvent[];
  expect(log.map((event) => event.id)).toEqual(['k1', 'k2']);
  expect(await page.evaluate(() => window.__kdStorage!.knowledgeState())).toEqual(['p-k1', 'p-k2']);
  await expect(page.locator('#knowledge-events')).toHaveText('knowledge events: 2');
});

test('a knowledge commit in one tab refreshes the other tab', async ({ context }) => {
  const writer = await context.newPage();
  const viewer = await context.newPage();
  await openHarness(writer);
  await openHarness(viewer);
  await expect(viewer.locator('#knowledge-events')).toHaveText('knowledge events: 0');
  await writer.evaluate((e) => window.__kdStorage!.appendKnowledge(e, -1), [proposition('t1')]);
  await expect(viewer.locator('#knowledge-events')).toHaveText('knowledge events: 1');
});
