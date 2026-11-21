// `/api/account/practice/*` (plan luyen-tap-graph.md A7). See the path table in @kd-learn/api
// (`practice.ts`). Another user's practice or exercise answers 404, like one that does not exist.
import { Schema } from 'effect';
import {
  AnswerRequest,
  ErrorCode,
  ExerciseView,
  PracticeList,
  PracticeView,
  StartPracticeRequest,
} from '@kd-learn/api';
import type { Handler, Logger } from '../handler.ts';
import type { Ctx, makeRouteKit } from '../routes.ts';
import type { CurrentUser } from '../auth/service.ts';
import { modelUnavailable } from '../sessions/http.ts';
import type { PracticeResult } from './account.ts';

type Kit = ReturnType<typeof makeRouteKit>;

const ID = '[A-Za-z0-9_-]{1,64}';

export const makePracticeAccountHandler = (kit: Kit, _log: Logger) => {
  const { route, json, decode, currentUser, unauthorized } = kit;

  const signedIn = (ctx: Ctx, run: (user: CurrentUser) => Promise<Response> | Response) => {
    const user = currentUser(ctx);
    return user === undefined ? unauthorized(ctx) : run(user);
  };
  const notFound = (ctx: Ctx) => ctx.reject(404, ErrorCode.NotFound, 'Not found.');

  const answerWith = <A>(
    ctx: Ctx,
    result: PracticeResult<A>,
    encode: (value: A) => unknown,
    status = 200,
  ): Response => {
    switch (result._tag) {
      case 'Ok':
        return json(ctx, encode(result.value), status);
      case 'NotFound':
        return notFound(ctx);
      case 'NothingToPractice':
        return ctx.reject(409, ErrorCode.NothingToRun, 'There is nothing to practice yet.');
      case 'InProgress':
        return ctx.reject(
          409,
          ErrorCode.TurnInProgress,
          'A practice is already being written.',
          true,
        );
      case 'Closed':
        return ctx.reject(409, ErrorCode.NothingToRun, result.message);
      case 'InvalidAnswer':
        return ctx.reject(400, ErrorCode.InvalidRequest, result.message);
      case 'ModelUnavailable':
        return modelUnavailable(ctx, result.result);
      case 'ModelFailed':
        return ctx.reject(
          502,
          result.failure.code,
          result.failure.message,
          result.failure.retryable,
        );
      case 'Timeout':
        return ctx.reject(504, ErrorCode.TurnTimeout, 'The model took too long. Try again.', true);
    }
  };

  const encodePractice = Schema.encodeSync(PracticeView);
  const encodeExercise = Schema.encodeSync(ExerciseView);

  const root = route('practice.root', ['GET', 'POST'], (ctx) =>
    signedIn(ctx, async (user) => {
      const practice = ctx.accounts.practice;
      if (ctx.request.method === 'GET') {
        const practices = await practice.list(user.id);
        return json(ctx, Schema.encodeSync(PracticeList)({ practices }));
      }
      const input = await decode(ctx, StartPracticeRequest);
      if (input instanceof Response) return input;
      return answerWith(ctx, await practice.start(user.id, input), encodePractice, 201);
    }),
  );

  const one = (practiceId: string) =>
    route('practice.get', ['GET'], (ctx) =>
      signedIn(ctx, async (user) => {
        const view = await ctx.accounts.practice.get(user.id, practiceId);
        return view === undefined ? notFound(ctx) : json(ctx, encodePractice(view));
      }),
    );

  const end = (practiceId: string) =>
    route('practice.end', ['POST'], (ctx) =>
      signedIn(ctx, async (user) =>
        answerWith(ctx, await ctx.accounts.practice.end(user.id, practiceId), encodePractice),
      ),
    );

  const answer = (exerciseId: string) =>
    route('practice.answer', ['POST'], (ctx) =>
      signedIn(ctx, async (user) => {
        const input = await decode(ctx, AnswerRequest);
        if (input instanceof Response) return input;
        return answerWith(
          ctx,
          await ctx.accounts.practice.answer(user.id, exerciseId, input.answer),
          encodeExercise,
        );
      }),
    );

  const grade = (exerciseId: string) =>
    route('practice.grade', ['POST'], (ctx) =>
      signedIn(ctx, async (user) =>
        answerWith(ctx, await ctx.accounts.practice.grade(user.id, exerciseId), encodeExercise),
      ),
    );

  /** The handler for `path` (below `/api/account/`), or undefined when it is not a practice path. */
  return (path: string): Handler | undefined => {
    if (path === 'practice') return root;
    const exercise = new RegExp(`^practice/exercises/(${ID})/(answer|grade)$`).exec(path);
    if (exercise?.[1] !== undefined) {
      return exercise[2] === 'answer' ? answer(exercise[1]) : grade(exercise[1]);
    }
    const ended = new RegExp(`^practice/(${ID})/end$`).exec(path);
    if (ended?.[1] !== undefined) return end(ended[1]);
    const get = new RegExp(`^practice/(${ID})$`).exec(path);
    if (get?.[1] !== undefined) return one(get[1]);
    return undefined;
  };
};
