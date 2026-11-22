import { Result, Schema } from 'effect';
import { describe, expect, it } from 'vitest';
import { EventLog, type DomainEvent } from './event.ts';
import {
  DemoLibraryId,
  demoLibraries,
  describeFigureMarkers,
  figureBodyBytes,
  figureMarker,
  keepKnownFigureMarkers,
  splitFigureMarkers,
} from './figure.ts';
import { phase2Session } from './fixtures/phase-2-session.ts';
import { phase4Session } from './fixtures/phase-4-session.ts';
import { projectSession } from './session.ts';

const decode = Schema.decodeUnknownSync(EventLog);
const base = decode(phase2Session).slice(0, 1);
let n = 0;
const meta = () => ({ id: `f${++n}`, at: n });
const started = (turnId: string): DomainEvent => ({
  _tag: 'TurnStarted',
  ...meta(),
  turnId,
  input: '',
});
const figure = (turnId: string, figureId: string): DomainEvent => ({
  _tag: 'FigureAdded',
  ...meta(),
  turnId,
  figureId,
  kind: 'svg',
  title: 'A triangle',
  mime: 'image/svg+xml',
  bytes: 40,
});
const completed = (turnId: string): DomainEvent => ({
  _tag: 'TurnCompleted',
  ...meta(),
  turnId,
  reason: 'stop',
});
const failed = (turnId: string): DomainEvent => ({
  _tag: 'TurnFailed',
  ...meta(),
  turnId,
  code: 'ProviderError',
  message: 'boom',
  retryable: true,
});

describe('FigureAdded in the projection', () => {
  it('keeps the figures of completed turns only', () => {
    const session = Result.getOrThrow(
      projectSession([
        ...base,
        started('t1'),
        figure('t1', 'a'),
        completed('t1'),
        started('t2'),
        figure('t2', 'b'),
        failed('t2'),
        started('t3'),
        figure('t3', 'c'),
      ]),
    );
    expect(session.figures.map((f) => [f.turnId, f.figureId])).toEqual([['t1', 'a']]);
  });

  it('rejects a figure outside an open turn and a duplicate id', () => {
    expect(Result.isFailure(projectSession([...base, figure('nope', 'a')]))).toBe(true);
    expect(
      Result.isFailure(
        projectSession([...base, started('t1'), figure('t1', 'a'), figure('t1', 'a')]),
      ),
    ).toBe(true);
    expect(
      Result.isFailure(
        projectSession([...base, started('t1'), completed('t1'), figure('t1', 'a')]),
      ),
    ).toBe(true);
  });

  it('still projects the logs of earlier phases', () => {
    for (const log of [phase2Session, phase4Session]) {
      const session = Result.getOrThrow(projectSession(decode(log)));
      expect(session.figures).toEqual([]);
    }
  });
});

describe('figure markers', () => {
  const text = `Look:\n\n${figureMarker('a')}\n\nand ${figureMarker('zz')} done`;

  it('drops markers of unknown figures', () => {
    expect(keepKnownFigureMarkers(text, new Set(['a']))).toBe(
      `Look:\n\n${figureMarker('a')}\n\nand  done`,
    );
  });

  it('splits text and figures in order', () => {
    expect(splitFigureMarkers(keepKnownFigureMarkers(text, new Set(['a'])))).toEqual([
      { _tag: 'text', text: 'Look:\n\n' },
      { _tag: 'figure', figureId: 'a' },
      { _tag: 'text', text: '\n\nand  done' },
    ]);
  });

  it('describes figures for the model without their code', () => {
    const figures = new Map([['a', { kind: 'mermaid' as const, title: 'Flow' }]]);
    expect(describeFigureMarkers(text, figures)).toBe(
      'Look:\n\n[figure: mermaid "Flow"]\n\nand  done',
    );
  });

  it('counts UTF-8 bytes', () => {
    expect(figureBodyBytes('đ')).toBe(2);
    expect(figureBodyBytes(new Uint8Array(5))).toBe(5);
  });
});

it('keeps the library id schema in step with the list', () => {
  expect(DemoLibraryId.literals).toEqual(demoLibraries.map((library) => library.id));
});
