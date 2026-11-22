// `GET /api/account/figures/:id` (plan hinh-va-demo.md A7): the body of one figure of the user.
// Another user's figure answers 404, like one that does not exist. The body is never served as a
// document: text kinds as plain text, images as opaque bytes, under a sandbox CSP. The client knows
// the kind and mime type from `FigureAdded` and builds a typed blob itself.
import { Effect } from 'effect';
import { ErrorCode } from '@kd-learn/api';
import type { Handler, Logger } from '../handler.ts';
import { SECURITY_HEADERS } from '../http.ts';
import type { makeRouteKit } from '../routes.ts';

type Kit = ReturnType<typeof makeRouteKit>;

const ID = /^figures\/([A-Za-z0-9_-]{1,64})$/;

export const figureHeaders = {
  ...SECURITY_HEADERS,
  'content-security-policy': "sandbox; default-src 'none'",
  'cache-control': 'private, max-age=31536000, immutable',
} as const;

export const makeFiguresHandler = (kit: Kit, log: Logger) => {
  const { route, currentUser, unauthorized } = kit;

  const one = (figureId: string) =>
    route('account.figure', ['GET'], (ctx) => {
      const user = currentUser(ctx);
      if (user === undefined) return unauthorized(ctx);
      const figure = Effect.runSync(ctx.accounts.storage.forUser(user.id).readFigure(figureId));
      if (figure === undefined) return ctx.reject(404, ErrorCode.NotFound, 'Not found.');
      log({
        event: 'account.figure',
        fields: {
          bytes: typeof figure.body === 'string' ? figure.body.length : figure.body.length,
        },
      });
      return typeof figure.body === 'string'
        ? new Response(figure.body, {
            headers: { ...figureHeaders, 'content-type': 'text/plain; charset=utf-8', ...ctx.cors },
          })
        : new Response(figure.body as Uint8Array<ArrayBuffer>, {
            headers: { ...figureHeaders, 'content-type': 'application/octet-stream', ...ctx.cors },
          });
    });

  /** The handler for `path` (below `/api/account/`), or undefined when it is not a figure path. */
  return (path: string): Handler | undefined => {
    const match = ID.exec(path);
    return match?.[1] === undefined ? undefined : one(match[1]);
  };
};
