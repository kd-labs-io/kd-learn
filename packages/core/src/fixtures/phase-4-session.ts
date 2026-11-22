// A session log in the phase 4 shape (sources attached, a cited teacher message, `sourceRefs`), as
// stored: JSON of each event. Written by hand from the phase 4 step 2 spike. Test data only.
import { phase2Session } from './phase-2-session.ts';

const created = (phase2Session as ReadonlyArray<Record<string, unknown>>)[0]!;

export const phase4Session: unknown = [
  { ...created, sessionId: 'bayes-pdf' },
  {
    _tag: 'SourceAttached',
    id: 'p4-1',
    at: 1795271255640,
    sourceId: 'src-1',
    title: 'Bayes notes.pdf',
    kind: 'pdf',
  },
  { _tag: 'TurnStarted', id: 'p4-2', at: 1795271255641, turnId: 't1', input: '' },
  {
    _tag: 'MessageAppended',
    id: 'p4-3',
    at: 1795271255650,
    turnId: 't1',
    messageId: 'm1',
    agent: 'prober',
    content: 'Your notes define a prior first [S1]. What does a prior describe?',
    citations: [{ label: 1, sourceId: 'src-1', ordinal: 0 }],
  },
  {
    _tag: 'UsageRecorded',
    id: 'p4-4',
    at: 1795271255651,
    turnId: 't1',
    model: 'claude-haiku-5-5',
    inputTokens: 900,
    outputTokens: 40,
  },
  {
    _tag: 'TurnCompleted',
    id: 'p4-5',
    at: 1795271255652,
    turnId: 't1',
    reason: 'stop',
    sourceRefs: [{ sourceId: 'src-1', ordinal: 0 }],
  },
  { _tag: 'SourceDetached', id: 'p4-6', at: 1795271255660, sourceId: 'src-1' },
];
