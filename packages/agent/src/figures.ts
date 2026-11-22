// Figure tools of the Teacher (plan hinh-va-demo.md A1, A3-A5). A figure tool queues a
// `FigureAdded` event (metadata), its body and a marker; the turn loop puts the marker into the
// text where the tool ran and releases events and bodies only when the turn completes.
import { Clock, Effect, Schema } from 'effect';
import { tool, ToolError } from '@kd-learn/ai/port';
import {
  DemoLibraryId,
  FigureTitle,
  demoLibraries,
  figureBodyBytes,
  figureCaps,
  figureColorList,
  figureMaxBytes,
  projectSession,
  textFigureMime,
} from '@kd-learn/core';
import type { DomainEvent, FigureBody, FigureInfo, ResolvedProfile } from '@kd-learn/core';
import type { ToolContext } from './tools.ts';

/** What the server allows for this turn (plan A5, A6). Absent: no figure tools at all. */
export interface FigureOptions {
  /** Demos may declare CDN libraries (admin switch). */
  readonly cdn: boolean;
}

/** Queued by the figure tools during a turn. */
export interface FigureQueue {
  readonly bodies: Array<FigureBody>;
  /** Figure ids whose marker the loop has not put into the text yet. */
  readonly markers: Array<string>;
}

export const makeFigureQueue = (): FigureQueue => ({ bodies: [], markers: [] });

const fail = (message: string) => Effect.fail(new ToolError({ message }));

const figuresInTurn = (ctx: ToolContext) =>
  ctx.pending.filter((event) => event._tag === 'FigureAdded').length;

/** Checks the caps, queues the event, the body and the marker. Returns the figure id. */
const addFigure = (
  ctx: ToolContext,
  queue: FigureQueue,
  info: Omit<FigureInfo, 'figureId' | 'bytes'>,
  body: string | Uint8Array,
) =>
  Effect.gen(function* () {
    if (figuresInTurn(ctx) >= figureCaps.perTurn) {
      return yield* fail(
        `This message already has ${figureCaps.perTurn} figures, the most allowed. Continue in text.`,
      );
    }
    const bytes = figureBodyBytes(body);
    if (bytes === 0) return yield* fail('The figure is empty.');
    const max = figureMaxBytes[info.kind];
    if (bytes > max) {
      return yield* fail(
        `The ${info.kind} code is ${bytes} bytes; the limit is ${max}. Make it smaller and call the tool again.`,
      );
    }
    const figureId = ctx.newId();
    const at = yield* Clock.currentTimeMillis;
    const event: DomainEvent = {
      _tag: 'FigureAdded',
      id: ctx.newId(),
      at,
      turnId: ctx.turnId,
      figureId,
      bytes,
      ...info,
    };
    // The projection checks the turn is open and the id is new.
    if (projectSession([...ctx.log, ...ctx.pending, event])._tag === 'Failure') {
      return yield* fail('The figure could not be added to this turn.');
    }
    ctx.pending.push(event);
    queue.bodies.push({ figureId, body });
    queue.markers.push(figureId);
    return figureId;
  });

/** Strips a Markdown code fence the model may wrap the code in. */
const unfence = (code: string) => {
  const fenced = /^\s*```[\w-]*\s*\n([\s\S]*?)\n\s*```\s*$/.exec(code);
  return (fenced?.[1] ?? code).trim();
};

const DiagramInput = Schema.Struct({
  kind: Schema.Literals(['svg', 'mermaid']),
  title: FigureTitle,
  source: Schema.String,
});

const showDiagram = (ctx: ToolContext, queue: FigureQueue) =>
  tool({
    name: 'show_diagram',
    description: `Show the learner a diagram at this point of your message. kind "mermaid": Mermaid source (flowchart, sequence, class, state, er, mindmap, pie, ...), no code fence; the app colors it. kind "svg": one complete <svg> element with a viewBox, no <script>, no external images or fonts; color it with var(--name) from ${figureColorList} or currentColor so it follows the app theme. title is a short caption in the learner's language. Use a diagram when a picture explains structure, flow or geometry better than words; not for decoration. Do not repeat the code in your text.`,
    input: DiagramInput,
    run: ({ kind, title, source }) =>
      Effect.gen(function* () {
        const code = unfence(source);
        if (kind === 'svg') {
          if (!/^(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(code) || !/<\/svg>\s*$/i.test(code)) {
            return yield* fail('source must be one complete <svg>...</svg> element.');
          }
          if (/<script[\s>]/i.test(code)) {
            return yield* fail('Scripts never run in a diagram. Remove the <script> element.');
          }
        } else if (code === '') {
          return yield* fail('source is empty.');
        }
        yield* addFigure(ctx, queue, { kind, title, mime: textFigureMime[kind] }, code);
        return 'The diagram is shown to the learner where you called the tool. Refer to it in your text; do not repeat its code.';
      }),
  });

const DemoInput = Schema.Struct({
  title: FigureTitle,
  html: Schema.String,
  libraries: Schema.optionalKey(Schema.Array(DemoLibraryId)),
});

const showDemo = (ctx: ToolContext, queue: FigureQueue, options: FigureOptions) =>
  tool({
    name: 'show_demo',
    description: [
      'Show the learner an interactive demo at this point of your message: HTML with inline <style> and <script>, run in an isolated frame after the learner presses Run.',
      'The frame has no network: no fetch, no external URLs, no forms, no popups, no storage. Scripts are allowed only as written in the HTML: no eval, no new Function, no scripts created at runtime; attach handlers with addEventListener or on* attributes written in the HTML.',
      `Use the CSS variables ${figureColorList} for colors so the demo follows the app theme. Keep it small and focused on the current step.`,
      options.cdn
        ? `libraries: ids of libraries to load before your code, from: ${demoLibraries.map((l) => `${l.id} (${l.name} ${l.version}, global ${l.global})`).join(', ')}. Never add <script src> yourself.`
        : 'No libraries are available: write plain JavaScript and SVG or canvas.',
      "title is a short caption in the learner's language.",
    ].join(' '),
    input: DemoInput,
    run: (input) =>
      Effect.gen(function* () {
        const html = unfence(input.html);
        if (html === '') return yield* fail('html is empty.');
        if (/<script[^>]*\ssrc\s*=/i.test(html)) {
          return yield* fail(
            'External scripts are blocked in the frame. Remove <script src> and declare libraries instead.',
          );
        }
        const libraries =
          input.libraries === undefined || input.libraries.length === 0
            ? undefined
            : [...new Set(input.libraries)];
        if (libraries !== undefined && !options.cdn) {
          return yield* fail(
            'No libraries are available. Remove libraries and use plain JavaScript.',
          );
        }
        yield* addFigure(
          ctx,
          queue,
          {
            kind: 'html',
            title: input.title,
            mime: textFigureMime.html,
            ...(libraries === undefined ? {} : { libraries }),
          },
          html,
        );
        return 'The demo is shown to the learner where you called the tool, with a Run button. Tell the learner what to try in it; do not repeat its code.';
      }),
  });

/** Figure tools of a teaching turn, as the profile and the server allow. */
export const figureTools = (
  ctx: ToolContext,
  queue: FigureQueue,
  profile: ResolvedProfile,
  options: FigureOptions | undefined,
) => {
  if (options === undefined) return [];
  return [
    ...(profile.figures.diagrams ? [showDiagram(ctx, queue)] : []),
    ...(profile.figures.demos ? [showDemo(ctx, queue, options)] : []),
  ];
};
