// The guest extraction flow against a scripted `/api/knowledge/extract` and the memory storage.
import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import { defaultProfile } from '@kd-learn/agent/client';
import type { ExtractFrame, ExtractRequest } from '@kd-learn/api';
import type { DomainEvent, KnowledgeEvent } from '@kd-learn/core';
import { makeMemoryStorage } from '@kd-learn/storage/memory';
import type { StorageService } from '@kd-learn/storage/port';
import { makeGuestExtractor } from './guest-extractor';

const sessionLog = (sessionId: string): DomainEvent[] => [
  {
    _tag: 'SessionCreated',
    id: `${sessionId}-1`,
    at: 1,
    sessionId,
    topic: 'Binary search',
    profile: defaultProfile,
  },
  { _tag: 'TurnStarted', id: `${sessionId}-2`, at: 2, turnId: `${sessionId}-t`, input: 'Hi' },
  { _tag: 'TurnCompleted', id: `${sessionId}-3`, at: 3, turnId: `${sessionId}-t`, reason: 'stop' },
];

const sse = (frames: ReadonlyArray<ExtractFrame>) =>
  new Response(frames.map((f) => `event: ${f._tag}\ndata: ${JSON.stringify(f)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });

/** A server that adds one proposition per session; `answer` may replace the frames. */
const server = (answer?: (request: ExtractRequest) => Response | Promise<Response>) => {
  const requests: ExtractRequest[] = [];
  const fetch = (async (_url: string, init: RequestInit) => {
    const request = JSON.parse(String(init.body)) as ExtractRequest;
    requests.push(request);
    if (answer) return answer(request);
    const sessionId = (request.log[0] as { sessionId: string }).sessionId;
    return sse([
      {
        _tag: 'result',
        events: [
          {
            _tag: 'PropositionAdded',
            id: `${request.extractionId}-p`,
            at: 5,
            propositionId: `${sessionId}-prop`,
            text: `A claim from ${sessionId}.`,
            topic: 'Binary search',
            source: { sessionId },
          },
          {
            _tag: 'SessionExtracted',
            id: `${request.extractionId}-x`,
            at: 6,
            sessionId,
            extractionId: request.extractionId,
            profileId: 'default',
          },
        ],
      },
      { _tag: 'done', outcome: 'completed' },
    ]);
  }) as typeof globalThis.fetch;
  return { fetch, requests };
};

const setup = async (
  fetch: typeof globalThis.fetch,
  options: { key?: boolean; demo?: boolean } = {},
) => {
  const storage: StorageService = makeMemoryStorage();
  if (options.key !== false) {
    await Effect.runPromise(
      storage.saveSettings({ provider: 'anthropic', model: 'claude-test', apiKey: 'sk-test-key' }),
    );
  }
  let n = 0;
  const extractor = makeGuestExtractor({
    storage: async () => storage,
    fetch,
    newId: () => `g${++n}`,
    demo: () => options.demo === true,
  });
  const seed = (sessionId: string) =>
    Effect.runPromise(storage.appendEvents(sessionId, sessionLog(sessionId)));
  const tags = async () =>
    ((await Effect.runPromise(storage.readKnowledge)) as ReadonlyArray<KnowledgeEvent>).map(
      (e) => e._tag,
    );
  return { storage, extractor, seed, tags };
};

describe('guest extraction', () => {
  it('runs once by itself, then never again by itself', async () => {
    const s = server();
    const t = await setup(s.fetch);
    await t.seed('s1');
    expect(await t.extractor.sessionCompleted('s1')).toEqual({ _tag: 'Extracted' });
    expect(await t.tags()).toEqual(['ExtractionStarted', 'PropositionAdded', 'SessionExtracted']);
    expect(await t.extractor.sessionCompleted('s1')).toMatchObject({ _tag: 'Skipped' });
    expect(s.requests).toHaveLength(1);
    expect(s.requests[0]).toMatchObject({ extractionId: 'g1', slice: [] });
    expect(s.requests[0]!.model).toMatchObject({ provider: 'anthropic' });
  });

  it('after a failure, only the retry runs it', async () => {
    let fail = true;
    const ok = server();
    const s = server((request) =>
      fail
        ? sse([
            { _tag: 'error', error: { code: 'ProviderError', message: 'down', retryable: true } },
            { _tag: 'done', outcome: 'failed' },
          ])
        : ok.fetch('', { body: JSON.stringify(request) }),
    );
    const t = await setup(s.fetch);
    await t.seed('s1');
    expect(await t.extractor.sessionCompleted('s1')).toMatchObject({
      _tag: 'Failed',
      failure: { code: 'ProviderError' },
    });
    expect(await t.extractor.sessionCompleted('s1')).toMatchObject({
      _tag: 'Skipped',
      reason: 'attempted',
    });
    fail = false;
    expect(await t.extractor.extract('s1')).toEqual({ _tag: 'Extracted' });
    expect(await t.tags()).toEqual([
      'ExtractionStarted',
      'ExtractionFailed',
      'ExtractionStarted',
      'PropositionAdded',
      'SessionExtracted',
    ]);
  });

  it('runs two sessions one after the other, and closes an interrupted attempt first', async () => {
    const s = server();
    const t = await setup(s.fetch);
    await t.seed('s1');
    await t.seed('s2');
    // A tab closed mid-extraction left an open attempt on s0.
    await Effect.runPromise(
      t.storage.appendKnowledge(
        [{ _tag: 'ExtractionStarted', id: 'old', at: 1, sessionId: 's0', extractionId: 'x0' }],
        { expectedLastSeq: -1 },
      ),
    );
    const [a, b] = await Promise.all([
      t.extractor.sessionCompleted('s1'),
      t.extractor.sessionCompleted('s2'),
    ]);
    expect([a, b]).toEqual([{ _tag: 'Extracted' }, { _tag: 'Extracted' }]);
    expect(await t.tags()).toEqual([
      'ExtractionStarted',
      'ExtractionFailed',
      'ExtractionStarted',
      'PropositionAdded',
      'SessionExtracted',
      'ExtractionStarted',
      'PropositionAdded',
      'SessionExtracted',
    ]);
  });

  it('writes nothing without a key; demo sends no key and no profile', async () => {
    const s = server();
    const t = await setup(s.fetch, { key: false });
    await t.seed('s1');
    expect(await t.extractor.sessionCompleted('s1')).toMatchObject({ reason: 'noKey' });
    expect(await t.tags()).toEqual([]);

    const demo = await setup(s.fetch, { key: false, demo: true });
    await demo.seed('s1');
    expect(await demo.extractor.sessionCompleted('s1')).toEqual({ _tag: 'Extracted' });
    expect(s.requests.at(-1)!.model).toEqual({ provider: 'demo' });
    expect(s.requests.at(-1)).not.toHaveProperty('profile');
  });

  it('a cut stream ends the attempt as a retryable network failure', async () => {
    const s = server(() => sse([]));
    const t = await setup(s.fetch);
    await t.seed('s1');
    expect(await t.extractor.sessionCompleted('s1')).toMatchObject({
      _tag: 'Failed',
      failure: { code: 'Network', retryable: true },
    });
    expect(await t.tags()).toEqual(['ExtractionStarted', 'ExtractionFailed']);
  });
});
