import { Result } from 'effect';
import { describe, expect, it } from 'vitest';
import type { ModelRef } from '@kd-learn/ai/port';
import { projectSession, splitFigureMarkers } from '@kd-learn/core';
import type { DomainEvent, Session } from '@kd-learn/core';
import { defaultProfile } from './profile.ts';
import { historyForModel } from './sources.ts';
import { collect, counterIds, eventsOf, fakeAi, type Action } from './testing.ts';
import { runTurn, type AgentOutput } from './turn.ts';
import type { FigureOptions, ImageGenerator } from './figures.ts';
import { Effect } from 'effect';
import { ImageRefused, ProviderError } from '@kd-learn/ai/port';

const model: ModelRef = {
  provider: 'anthropic',
  model: 'fake-model',
  apiKey: 'sk-ant-secret-0000',
};
const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle r="4" cx="5" cy="5"/></svg>';

/** A session in its teaching phase, step "a" of two. */
const teaching = (profile = defaultProfile) => {
  const newId = counterIds('x');
  const log: Array<DomainEvent> = [
    { _tag: 'SessionCreated', id: newId(), at: 1, sessionId: 's1', topic: 'Circles', profile },
    { _tag: 'TurnStarted', id: newId(), at: 1, turnId: 't0', input: '' },
    {
      _tag: 'AssessmentRecorded',
      id: newId(),
      at: 1,
      turnId: 't0',
      level: 'beginner',
      summary: 'New to it.',
      strengths: [],
      gaps: [],
    },
    { _tag: 'TurnCompleted', id: newId(), at: 1, turnId: 't0', reason: 'stop' },
    { _tag: 'TurnStarted', id: newId(), at: 1, turnId: 't1', input: '' },
    {
      _tag: 'PlanCreated',
      id: newId(),
      at: 1,
      turnId: 't1',
      plan: {
        nodes: [
          { id: 'a', title: 'Radius', goal: 'Say what a radius is', dependsOn: [] },
          { id: 'b', title: 'Area', goal: 'Compute an area', dependsOn: ['a'] },
        ],
      },
    },
    { _tag: 'TurnCompleted', id: newId(), at: 1, turnId: 't1', reason: 'stop' },
  ];
  const play = async (
    script: ReadonlyArray<ReadonlyArray<Action>>,
    figures: FigureOptions | null = { cdn: true },
  ) => {
    const fake = fakeAi(script);
    log.push({ _tag: 'TurnStarted', id: newId(), at: 2, turnId: newId(), input: 'go' });
    const outputs = await collect(
      runTurn({ log, model, newId, ...(figures === null ? {} : { figures }) }),
      fake,
    );
    const events = eventsOf(outputs);
    log.push(...events);
    return { outputs, events, fake };
  };
  const session = (): Session => Result.getOrThrow(projectSession(log));
  return { log, play, session };
};

const bodies = (outputs: ReadonlyArray<AgentOutput>) =>
  outputs.flatMap((o) => (o._tag === 'Figure' ? [o.figure] : []));

describe('figure tools', () => {
  it('puts the figure where the tool ran, then completes the step in the same turn', async () => {
    const t = teaching();
    const { outputs, events, fake } = await t.play([
      [
        { say: 'Look at this circle.' },
        { call: 'show_diagram', input: { kind: 'svg', title: 'A circle', source: svg } },
        { say: 'The line from the centre is the radius.' },
        { call: 'complete_step', input: { stepId: 'a' } },
      ],
    ]);
    expect(fake.toolResults.every((r) => !r.startsWith('Error'))).toBe(true);
    const message = events.find((e) => e._tag === 'MessageAppended');
    const segments = splitFigureMarkers(message?._tag === 'MessageAppended' ? message.content : '');
    expect(segments.map((s) => s._tag)).toEqual(['text', 'figure', 'text']);
    const figure = events.find((e) => e._tag === 'FigureAdded');
    expect(figure).toMatchObject({
      kind: 'svg',
      title: 'A circle',
      mime: 'image/svg+xml',
      bytes: svg.length,
    });
    expect(bodies(outputs)).toEqual([
      { figureId: figure?._tag === 'FigureAdded' ? figure.figureId : '', body: svg },
    ]);
    // Bodies come before the events, so the writer has them when it writes the batch.
    expect(outputs.findIndex((o) => o._tag === 'Figure')).toBeLessThan(
      outputs.findIndex((o) => o._tag === 'Event'),
    );
    expect(events.some((e) => e._tag === 'StepCompleted')).toBe(true);
    expect(t.session().figures).toHaveLength(1);
  });

  it('live deltas carry the marker, so the UI can hold the place', async () => {
    const t = teaching();
    const { outputs } = await t.play([
      [
        {
          call: 'show_diagram',
          input: { kind: 'mermaid', title: 'Flow', source: '```mermaid\nflowchart LR\nA-->B\n```' },
        },
      ],
    ]);
    const live = outputs.flatMap((o) => (o._tag === 'Delta' ? [o.delta] : [])).join('');
    expect(live).toMatch(/\[\[figure:x\d+\]\]/);
    expect(bodies(outputs)[0]?.body).toBe('flowchart LR\nA-->B');
  });

  it('drops a marker the model typed itself', async () => {
    const t = teaching();
    const { events } = await t.play([[{ say: 'Here [[figure:fake]] is nothing.' }]]);
    const message = events.find((e) => e._tag === 'MessageAppended');
    expect(message?._tag === 'MessageAppended' ? message.content : '').not.toContain('[[figure:');
  });

  it('rejects bad figures with a message the model can act on', async () => {
    const t = teaching();
    const { fake, outputs } = await t.play(
      [
        [
          { call: 'show_diagram', input: { kind: 'svg', title: 'x', source: '<div>no</div>' } },
          {
            call: 'show_diagram',
            input: { kind: 'svg', title: 'x', source: '<svg><script>alert(1)</script></svg>' },
          },
          {
            call: 'show_diagram',
            input: { kind: 'svg', title: 'x', source: `<svg>${'a'.repeat(70_000)}</svg>` },
          },
          {
            call: 'show_demo',
            input: { title: 'x', html: '<script src="https://evil.example/x.js"></script>' },
          },
          { call: 'show_demo', input: { title: 'x', html: '<p>hi</p>', libraries: ['d3'] } },
          { say: 'ok' },
        ],
      ],
      { cdn: false },
    );
    expect(fake.toolResults.filter((r) => r.startsWith('Error'))).toHaveLength(5);
    expect(bodies(outputs)).toEqual([]);
  });

  it('caps the figures of one turn', async () => {
    const t = teaching();
    const call = {
      call: 'show_diagram',
      input: { kind: 'mermaid', title: 'x', source: 'flowchart LR\nA-->B' },
    };
    const { fake, outputs } = await t.play([[call, call, call, call]]);
    expect(fake.toolResults.filter((r) => r.startsWith('Error'))).toHaveLength(1);
    expect(bodies(outputs)).toHaveLength(3);
  });

  it('keeps declared libraries on the demo', async () => {
    const t = teaching();
    const { events } = await t.play([
      [
        {
          call: 'show_demo',
          input: {
            title: 'Bars',
            html: '<div id="c"></div><script>d3.select("#c")</script>',
            libraries: ['d3', 'd3'],
          },
        },
      ],
    ]);
    expect(events.find((e) => e._tag === 'FigureAdded')).toMatchObject({
      kind: 'html',
      libraries: ['d3'],
    });
  });

  it('writes no figure when the turn fails', async () => {
    const t = teaching();
    const { outputs } = await t.play([
      [
        { call: 'show_diagram', input: { kind: 'svg', title: 'x', source: svg } },
        { fail: { _tag: 'ProviderError', message: 'boom' } as never },
      ],
    ]);
    expect(bodies(outputs)).toEqual([]);
    expect(eventsOf(outputs).some((e) => e._tag === 'FigureAdded')).toBe(false);
  });

  it('offers no figure tools without server options or when the profile turns them off', async () => {
    const off = teaching();
    const { fake } = await off.play([[{ say: 'hi' }]], null);
    expect(fake.requests[0]?.tools?.map((t) => t.name)).toEqual(['complete_step']);
    const noDemos = teaching({
      ...defaultProfile,
      figures: { diagrams: true, demos: false, images: true },
    });
    const second = await noDemos.play([[{ say: 'hi' }]]);
    expect(second.fake.requests[0]?.tools?.map((t) => t.name)).toEqual([
      'complete_step',
      'show_diagram',
    ]);
  });

  it('shows the model a figure by kind and title, never its code', async () => {
    const t = teaching();
    await t.play([
      [
        { say: 'See:' },
        { call: 'show_diagram', input: { kind: 'svg', title: 'A circle', source: svg } },
      ],
    ]);
    const history = historyForModel(t.session());
    const last = history.at(-1)?.content ?? '';
    expect(last).toContain('[figure: svg "A circle"]');
    expect(last).not.toContain('<svg');
  });
});

describe('generate_image', () => {
  const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 9]);
  const generator = (
    answer: 'ok' | 'refused' | 'failed' = 'ok',
    calls: Array<string> = [],
  ): ImageGenerator => ({
    model: 'image-model',
    generate: (prompt) => {
      calls.push(prompt);
      if (answer === 'refused') {
        return Effect.fail(
          new ImageRefused({ message: 'No.', usage: { inputTokens: 3, outputTokens: 2 } }),
        );
      }
      if (answer === 'failed') {
        return Effect.fail(
          new ProviderError({
            message: 'The image provider failed (HTTP 500).',
            code: 'ProviderError',
          }),
        );
      }
      return Effect.succeed({
        mime: 'image/jpeg',
        bytes: JPEG,
        usage: { inputTokens: 30, outputTokens: 1120 },
      });
    },
  });
  const call = {
    call: 'generate_image',
    input: { title: 'A cell', prompt: 'A plant cell, cutaway' },
  };

  it('is offered only with an image model and the profile allowing images', async () => {
    const offered = async (figures: FigureOptions | null, profile = defaultProfile) => {
      const t = teaching(profile);
      const { fake } = await t.play([[{ say: 'Hi.' }]], figures);
      return (fake.requests[0]?.tools ?? []).some((tool) => tool.name === 'generate_image');
    };
    expect(await offered({ cdn: true, image: generator() })).toBe(true);
    expect(await offered({ cdn: true })).toBe(false);
    expect(
      await offered(
        { cdn: true, image: generator() },
        { ...defaultProfile, figures: { diagrams: true, demos: true, images: false } },
      ),
    ).toBe(false);
  });

  it('stores the image as a figure with its bytes, and records the image usage', async () => {
    const t = teaching();
    const { outputs, events, fake } = await t.play([[call, { say: 'Here it is.' }]], {
      cdn: true,
      image: generator(),
    });
    expect(fake.toolResults.every((r) => !r.startsWith('Error'))).toBe(true);
    const figure = events.find((e) => e._tag === 'FigureAdded');
    expect(figure).toMatchObject({
      kind: 'image',
      mime: 'image/jpeg',
      bytes: JPEG.length,
      title: 'A cell',
    });
    expect(bodies(outputs)[0]?.body).toEqual(JPEG);
    expect(events).toContainEqual(
      expect.objectContaining({
        _tag: 'UsageRecorded',
        model: 'image-model',
        inputTokens: 30,
        outputTokens: 1120,
      }),
    );
  });

  it('allows one image per message, and calls the provider only once', async () => {
    const t = teaching();
    const calls: Array<string> = [];
    const { events, fake } = await t.play([[call, call, { say: 'Done.' }]], {
      cdn: true,
      image: generator('ok', calls),
    });
    expect(calls).toHaveLength(1);
    expect(events.filter((e) => e._tag === 'FigureAdded')).toHaveLength(1);
    expect(fake.toolResults.at(-1)).toContain('already has an image');
  });

  it('a refusal records usage and no figure; a provider failure tells the model to go on', async () => {
    for (const answer of ['refused', 'failed'] as const) {
      const t = teaching();
      const { events, fake } = await t.play([[call, { say: 'Without it, then.' }]], {
        cdn: true,
        image: generator(answer),
      });
      expect(events.some((e) => e._tag === 'FigureAdded')).toBe(false);
      expect(fake.toolResults.at(-1)).toContain('Continue without the image');
      expect(events.some((e) => e._tag === 'UsageRecorded' && e.model === 'image-model')).toBe(
        answer === 'refused',
      );
      expect(events.some((e) => e._tag === 'TurnCompleted')).toBe(true);
    }
  });
});
