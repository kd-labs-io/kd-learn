// `/api/account/sources/*` (plan nguon-hoc.md A2, A4). See the path table in @kd-learn/api
// (`sources.ts`). Another user's source answers 404, like one that does not exist.
import { Schema } from 'effect';
import {
  CreateNoteSourceRequest,
  CreateResearchRequest,
  ErrorCode,
  MAX_PDF_BYTES,
  SourceDetail,
  SourceList,
  SourceResponse,
} from '@kd-learn/api';
import { maxSourceTextBytes } from '@kd-learn/core';
import type { Handler, Logger } from '../handler.ts';
import { readLimitedBytes } from '../http.ts';
import type { Ctx, makeRouteKit } from '../routes.ts';
import type { CurrentUser } from '../auth/service.ts';

type Kit = ReturnType<typeof makeRouteKit>;

const ID = '[A-Za-z0-9_-]{1,64}';
/** Multipart framing around the file. */
const FORM_OVERHEAD = 64 * 1024;
/** A note's chunks as JSON: the text cap plus escaping and framing. */
const NOTE_BODY_BYTES = maxSourceTextBytes + 512 * 1024;

const isPdf = (bytes: Uint8Array) =>
  bytes.byteLength >= 5 && new TextDecoder().decode(bytes.subarray(0, 5)) === '%PDF-';

export const makeSourcesHandler = (kit: Kit, log: Logger) => {
  const { route, json, decode, currentUser, unauthorized } = kit;

  const signedIn = (ctx: Ctx, run: (user: CurrentUser) => Promise<Response> | Response) => {
    const user = currentUser(ctx);
    return user === undefined ? unauthorized(ctx) : run(user);
  };
  const notFound = (ctx: Ctx) => ctx.reject(404, ErrorCode.NotFound, 'Not found.');
  const tooLarge = (ctx: Ctx) =>
    ctx.reject(413, ErrorCode.InvalidRequest, 'The file is too large (20 MiB at most).');
  const encodeSource = Schema.encodeSync(SourceResponse);

  const uploadPdf = async (ctx: Ctx, user: CurrentUser) => {
    const body = await readLimitedBytes(ctx.request, MAX_PDF_BYTES + FORM_OVERHEAD);
    if (body === 'too-large') return tooLarge(ctx);
    if (body === 'unreadable') {
      return ctx.reject(400, ErrorCode.InvalidRequest, 'The upload is not readable.');
    }
    let form: FormData;
    try {
      // The bytes are already bounded: parsing them here cannot grow past the limit.
      form = await new Response(body as Uint8Array<ArrayBuffer>, {
        headers: { 'content-type': ctx.request.headers.get('content-type') ?? '' },
      }).formData();
    } catch {
      return ctx.reject(400, ErrorCode.InvalidRequest, 'The upload is not valid multipart.');
    }
    const file = form.get('file');
    if (file === null || typeof file === 'string') {
      return ctx.reject(400, ErrorCode.InvalidRequest, 'The upload has no `file` field.');
    }
    if (file.size > MAX_PDF_BYTES) return tooLarge(ctx);
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!isPdf(bytes)) return ctx.reject(400, ErrorCode.InvalidRequest, 'The file is not a PDF.');
    const source = ctx.accounts.sources.createPdf(user.id, {
      fileName: file.name || 'document.pdf',
      file: bytes,
    });
    log({ event: 'account.sources.uploaded', fields: { bytes: bytes.byteLength } });
    return json(ctx, encodeSource({ source }), 202);
  };

  const root = route('sources.root', ['GET', 'POST'], (ctx) =>
    signedIn(ctx, async (user) => {
      const sources = ctx.accounts.sources;
      if (ctx.request.method === 'GET') {
        return json(ctx, Schema.encodeSync(SourceList)({ sources: sources.list(user.id) }));
      }
      const type = ctx.request.headers.get('content-type') ?? '';
      if (type.toLowerCase().startsWith('multipart/form-data')) return uploadPdf(ctx, user);
      const input = await decode(ctx, CreateNoteSourceRequest, NOTE_BODY_BYTES);
      if (input instanceof Response) return input;
      const created = sources.createNote(user.id, input);
      if (created._tag !== 'Ok') {
        return ctx.reject(
          413,
          ErrorCode.InvalidRequest,
          created._tag === 'Conflict' ? created.message : 'Not created.',
        );
      }
      return json(ctx, encodeSource({ source: created.value }), 201);
    }),
  );

  const one = (sourceId: string) =>
    route('sources.one', ['GET', 'DELETE'], (ctx) =>
      signedIn(ctx, (user) => {
        const sources = ctx.accounts.sources;
        if (ctx.request.method === 'DELETE') {
          sources.remove(user.id, sourceId);
          return new Response(null, { status: 204, headers: ctx.cors });
        }
        const detail = sources.get(user.id, sourceId);
        return detail === undefined
          ? notFound(ctx)
          : json(ctx, Schema.encodeSync(SourceDetail)(detail));
      }),
    );

  const retry = (sourceId: string) =>
    route('sources.retry', ['POST'], (ctx) =>
      signedIn(ctx, (user) => {
        const result = ctx.accounts.sources.retry(user.id, sourceId);
        switch (result._tag) {
          case 'Ok':
            return json(ctx, encodeSource({ source: result.value }), 202);
          case 'NotFound':
            return notFound(ctx);
          case 'Conflict':
            return ctx.reject(409, ErrorCode.Conflict, result.message);
        }
      }),
    );

  // Web research (phase 4 A5): a `pending` web source and a job.
  const research = route('research', ['POST'], (ctx) =>
    signedIn(ctx, async (user) => {
      const input = await decode(ctx, CreateResearchRequest);
      if (input instanceof Response) return input;
      const result = ctx.accounts.research.create(user.id, input);
      switch (result._tag) {
        case 'Ok':
          return json(ctx, encodeSource({ source: result.value }), 202);
        case 'NotFound':
          return notFound(ctx);
        case 'Conflict':
          return ctx.reject(403, ErrorCode.SearchUnavailable, result.message);
      }
    }),
  );

  /** The handler for `path` (below `/api/account/`), or undefined when it is not a source path. */
  return (path: string): Handler | undefined => {
    if (path === 'sources') return root;
    if (path === 'research') return research;
    const retried = new RegExp(`^sources/(${ID})/retry$`).exec(path);
    if (retried?.[1] !== undefined) return retry(retried[1]);
    const got = new RegExp(`^sources/(${ID})$`).exec(path);
    if (got?.[1] !== undefined) return one(got[1]);
    return undefined;
  };
};
