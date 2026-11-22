import { Result, Schema } from 'effect';
import { describe, expect, it } from 'vitest';
import { DomainEvent, EventLog } from './event.ts';
import { projectSession } from './session.ts';
import {
  chunkNote,
  chunkPages,
  chunkWeb,
  cleanNote,
  selectSourceSlice,
  type SliceChunk,
} from './source.ts';
import { maxChunkChars } from './source-schema.ts';

const profile = {
  id: 'default',
  language: 'vi',
  maxProbeQuestions: 3,
  maxTurnsPerStep: 2,
  prompts: { prober: 'p', teacher: 't', sideChat: 's' },
};

describe('chunking', () => {
  it('keeps chunks of a PDF inside one page and under the size', () => {
    const long = 'Một câu tiếng Việt có dấu đầy đủ. '.repeat(120);
    const chunks = chunkPages(
      [
        { page: 1, text: 'Tiêu đề\n\nĐoạn một ngắn.' },
        { page: 2, text: long },
      ],
      1000,
    );
    expect(chunks[0]).toEqual({
      ordinal: 0,
      text: 'Tiêu đề\n\nĐoạn một ngắn.',
      locator: { page: 1 },
    });
    expect(chunks.slice(1).every((c) => c.locator.page === 2)).toBe(true);
    expect(chunks.every((c) => c.text.length <= 1000)).toBe(true);
    expect(chunks.map((c) => c.ordinal)).toEqual(chunks.map((_, i) => i));
  });

  it('normalises to NFC', () => {
    const decomposed = 'Tiếng Việt';
    expect(chunkPages([{ page: 1, text: decomposed }])[0]!.text).toBe('Tiếng Việt');
  });

  it('cleans a note: front matter, images, HTML and link targets go', () => {
    const note = [
      '---',
      'tags: [x]',
      '---',
      '# Title',
      'See [[Other note|the other]] and [[Plain]].',
      '![tracker](https://evil.test/p.png) ![[img.png]]',
      'A [link](https://evil.test/x) and <b>bold</b><script>x</script>.',
    ].join('\n');
    const clean = cleanNote(note);
    expect(clean).not.toContain('evil.test');
    expect(clean).not.toContain('tags:');
    expect(clean).not.toContain('<');
    expect(clean).toContain('See the other and Plain.');
  });

  it('uses the heading above each part of a note as its locator', () => {
    const chunks = chunkNote('Intro text.\n\n# Part A\n\nText A.\n\n## Part B\nText B.');
    expect(chunks.map((c) => [c.text, c.locator])).toEqual([
      ['Intro text.', {}],
      ['Text A.', { heading: 'Part A' }],
      ['Text B.', { heading: 'Part B' }],
    ]);
  });

  it('never makes a chunk longer than the maximum', () => {
    const chunks = chunkNote('x'.repeat(20_000), 99_999);
    expect(chunks.every((c) => c.text.length <= maxChunkChars)).toBe(true);
    expect(chunks.map((c) => c.text).join('')).toBe('x'.repeat(20_000));
  });

  it('puts the research summary first and one locator per result', () => {
    const chunks = chunkWeb('Summary [1].', [
      { title: 'A', url: 'https://a.test', text: 'Text of A.' },
      { title: 'B', url: 'https://b.test', text: 'Text of B.' },
    ]);
    expect(chunks.map((c) => c.locator)).toEqual([
      {},
      { url: 'https://a.test' },
      { url: 'https://b.test' },
    ]);
  });
});

describe('source slice', () => {
  const chunk = (sourceId: string, ordinal: number, text: string): SliceChunk => ({
    sourceId,
    ordinal,
    title: sourceId,
    text,
    locator: {},
  });
  const chunks = [
    chunk('a', 0, 'Cooking pasta in salted water.'),
    chunk('a', 1, 'Binary search halves a sorted array each step.'),
    chunk('b', 0, 'Sorted arrays allow binary search.'),
    chunk('b', 1, 'Unrelated history of Rome.'),
  ];

  it('picks the closest chunks, in reading order', () => {
    const slice = selectSourceSlice(chunks, 'binary search sorted array', { count: 2 });
    expect(slice.map((c) => `${c.sourceId}${c.ordinal}`)).toEqual(['a1', 'b0']);
  });

  it('starts from the beginning when nothing matches, and respects the byte budget', () => {
    expect(selectSourceSlice(chunks, 'zzz', { count: 2 }).map((c) => c.ordinal)).toEqual([0, 1]);
    const one = selectSourceSlice(chunks, 'zzz', { maxBytes: 150 });
    expect(one).toHaveLength(1);
  });
});

describe('sources in the session log', () => {
  const created = {
    _tag: 'SessionCreated' as const,
    id: 'e1',
    at: 1,
    sessionId: 's1',
    topic: 'Topic',
    profile,
  };
  const attach = (id: string, sourceId: string) => ({
    _tag: 'SourceAttached' as const,
    id,
    at: 2,
    sourceId,
    title: 'Doc',
    kind: 'pdf' as const,
  });

  it('attaches and detaches; history keeps citations', () => {
    const log = Schema.decodeUnknownSync(EventLog)([
      created,
      attach('e2', 'src1'),
      attach('e3', 'src2'),
      { _tag: 'SourceDetached', id: 'e4', at: 3, sourceId: 'src1' },
      { _tag: 'TurnStarted', id: 'e5', at: 4, turnId: 't1', input: 'Hi' },
      {
        _tag: 'MessageAppended',
        id: 'e6',
        at: 5,
        turnId: 't1',
        messageId: 'm1',
        agent: 'prober',
        content: 'Per [S1].',
        citations: [{ label: 1, sourceId: 'src2', ordinal: 3 }],
      },
      {
        _tag: 'TurnCompleted',
        id: 'e7',
        at: 6,
        turnId: 't1',
        reason: 'stop',
        sourceRefs: [{ sourceId: 'src2', ordinal: 3 }],
      },
    ]);
    const session = projectSession(log);
    if (Result.isFailure(session)) throw session.failure;
    expect(session.success.sources).toEqual([{ sourceId: 'src2', title: 'Doc', kind: 'pdf' }]);
    expect(session.success.history[1]).toEqual({
      role: 'assistant',
      content: 'Per [S1].',
      citations: [{ label: 1, sourceId: 'src2', ordinal: 3 }],
    });
  });

  it('rejects attaching twice and detaching what is not attached', () => {
    const twice = [created, attach('e2', 'src1'), attach('e3', 'src1')];
    expect(Result.isFailure(projectSession(twice as DomainEvent[]))).toBe(true);
    const detach = [created, { _tag: 'SourceDetached', id: 'e2', at: 2, sourceId: 'x' }];
    expect(Result.isFailure(projectSession(detach as DomainEvent[]))).toBe(true);
  });
});
