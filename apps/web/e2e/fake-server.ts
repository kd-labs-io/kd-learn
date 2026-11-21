// A stand-in for `POST /api/turns` in browser tests: answers like the real server would for the
// log in the request (it decides from the projection, so auto-started turns do not shift a counter),
// without a model. The page under test runs for real; only the network is replaced.
import type { Page, Route } from '@playwright/test';
import { Result } from 'effect';
import { projectSession, type DomainEvent } from '@kd-learn/core';

type Json = Record<string, unknown>;

interface Request {
  readonly model: { provider: string; model: string; apiKey: string; endpointId?: string };
  readonly turn: { kind: 'main' } | { kind: 'side'; threadId: string };
  readonly log: ReadonlyArray<DomainEvent>;
}

let counter = 0;
const id = () => `fake-${Date.now().toString(36)}-${++counter}`;

export const sse = (frames: ReadonlyArray<Json>) =>
  frames.map((frame) => `event: ${frame['_tag']}\ndata: ${JSON.stringify(frame)}\n\n`).join('');

const eventFrame = (event: Json): Json => ({ _tag: 'event', event });
const doneFrame: Json = { _tag: 'done', outcome: 'completed' };

/** What the tutor says. Contains a formula, an image that must not load, and links. */
export const TUTOR_RICH_TEXT = [
  'Energy is $E = mc^2$, and in display form:',
  '',
  '$$\\int_0^1 x\\,dx = \\tfrac{1}{2}$$',
  '',
  '![tracking pixel](https://tracker.invalid/pixel.png)',
  '',
  '[docs](https://docs.invalid/guide) and [mail](mailto:a@b.invalid)',
].join('\n');

/** The frames of a successful turn for the open turn / the side thread of `request`. */
export function replyFor(request: Request): Json[] {
  const projected = projectSession(request.log);
  if (Result.isFailure(projected)) throw new Error('fake server: the log does not project');
  const session = projected.success;

  if (request.turn.kind === 'side') {
    const threadId = request.turn.threadId;
    return [
      { _tag: 'delta', messageId: 'side', delta: 'Short side ' },
      { _tag: 'delta', messageId: 'side', delta: 'answer.' },
      eventFrame({
        _tag: 'SideMessageAppended',
        id: id(),
        at: Date.now(),
        threadId,
        messageId: id(),
        role: 'assistant',
        content: 'Short side answer.',
      }),
      doneFrame,
    ];
  }

  const turn = session.turns.at(-1)!;
  const stamp = { id: id(), at: Date.now(), turnId: turn.turnId };
  const message = (content: string, agent = 'teacher') =>
    eventFrame({ _tag: 'MessageAppended', ...stamp, id: id(), messageId: id(), agent, content });
  const completed = () => eventFrame({ _tag: 'TurnCompleted', ...stamp, id: id(), reason: 'stop' });
  const say = (text: string): Json => ({ _tag: 'delta', messageId: 'live', delta: text });

  switch (session.state._tag) {
    case 'Probing': {
      // The first question comes unprompted; the first answer is enough for the assessment.
      if (session.state.turnsCompleted >= 1) {
        return [
          say('Thanks, I know where to start.'),
          message('Thanks, I know where to start.', 'prober'),
          eventFrame({
            _tag: 'AssessmentRecorded',
            ...stamp,
            id: id(),
            level: 'beginner',
            summary: 'Knows little.',
            strengths: [],
            gaps: ['basics'],
          }),
          completed(),
          doneFrame,
        ];
      }
      return [
        say('What do you already know?'),
        message('What do you already know?', 'prober'),
        completed(),
        doneFrame,
      ];
    }
    case 'Planning':
      return [
        say('Here is your plan. '),
        eventFrame({
          _tag: 'PlanCreated',
          ...stamp,
          id: id(),
          plan: {
            nodes: [
              { id: 'one', title: 'First idea', goal: 'Grasp the first idea', dependsOn: [] },
              { id: 'two', title: 'Second idea', goal: 'Grasp the second idea', dependsOn: ['one'] },
            ],
          },
        }),
        message(TUTOR_RICH_TEXT),
        completed(),
        doneFrame,
      ];
    case 'Teaching': {
      const stepId = session.state.stepId!;
      if (turn.input !== 'ok') {
        return [say('Not quite, try again.'), message('Not quite, try again.'), completed(), doneFrame];
      }
      const last = session.plan!.nodes.at(-1)!.id === stepId;
      return [
        say('Well done.'),
        message('Well done.'),
        eventFrame({ _tag: 'StepCompleted', ...stamp, id: id(), stepId }),
        ...(last ? [eventFrame({ _tag: 'SessionCompleted', ...stamp, id: id() })] : []),
        completed(),
        doneFrame,
      ];
    }
    default:
      throw new Error(`fake server: no reply in state ${session.state._tag}`);
  }
}

export interface TurnRoute {
  /** Bodies of the requests seen so far. */
  readonly requests: Array<Request>;
}

/**
 * Serves `/api/turns` with `replyFor`. `override` may answer a request itself (return a Route
 * action) and falls back to the default reply when it returns undefined.
 */
export async function mockTurns(
  page: Page,
  override?: (request: Request, route: Route) => Promise<'handled' | undefined> | 'handled' | undefined,
): Promise<TurnRoute> {
  const seen: Array<Request> = [];
  await page.route('**/api/turns', async (route) => {
    const request = route.request().postDataJSON() as Request;
    seen.push(request);
    if ((await override?.(request, route)) === 'handled') return;
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: sse(replyFor(request)),
    });
  });
  return { requests: seen };
}
