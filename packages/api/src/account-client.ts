// Typed client for the account, admin and public config routes (plan tai-khoan.md A2, A4-A7).
// Every request sends `Authorization: Bearer <token>` when a token is given; the web app and
// Capacitor use the same path (plan step 0, C2). Runs in the browser and in Node.
import { Data, Effect, Schema, Stream } from 'effect';
import {
  ACCOUNT_SETTINGS_PATH,
  ADMIN_CONFIG_PATH,
  ADMIN_USERS_PATH,
  AccountFrame,
  AccountSettings,
  AdminConfig,
  AdminUser,
  AdminUserList,
  AuthResponse,
  CONFIG_PATH,
  CONNECTIONS_PATH,
  ConnectionInfo,
  CreateConnectionRequest,
  CreateInviteRequest,
  CreateSessionRequest,
  CreateSessionResponse,
  ENDPOINTS_PATH,
  EndpointsResponse,
  ErrorBody,
  INVITES_PATH,
  InviteResponse,
  LOGIN_PATH,
  LOGOUT_PATH,
  LoginRequest,
  ME_PATH,
  MeResponse,
  PublicConfig,
  REGISTER_PATH,
  PROFILE_PATH,
  EXTRACTIONS_PATH,
  ExtractSessionRequest,
  ExtractionList,
  ProfileRequest,
  ProfileResponse,
  ROLES_PATH,
  RegisterRequest,
  SESSIONS_PATH,
  SessionList,
  SessionSnapshot,
  SetRolesRequest,
  SkipStepRequest,
  StartTurnRequest,
  StartTurnResponse,
  UpdateAdminConfigRequest,
  UpdateUserRequest,
} from './contract.ts';
import type { Failure, RoleModels } from './contract.ts';
import {
  ACCOUNT_PRACTICE_PATH,
  AnswerRequest,
  ExerciseView,
  GradeAnswerRequest,
  GradeAnswerResponse,
  IssueExercisesRequest,
  IssueExercisesResponse,
  PRACTICE_GRADE_PATH,
  PRACTICE_ISSUE_PATH,
  PracticeList,
  PracticeView,
  StartPracticeRequest,
} from './practice.ts';
import type { ExerciseAnswer, SavedProfile } from '@kd-learn/core';
import { makeSseParser } from './sse.ts';

/** Client-side codes of `ApiError` (status 0): the server never sends these. */
export const TransportCode = {
  /** The request did not reach the server, or the connection dropped. */
  Network: 'Network',
  /** The response does not match the contract. */
  Protocol: 'Protocol',
} as const;

/**
 * A request that did not succeed. `status` is the HTTP status, or 0 when the server was not
 * reached (`failure.code` is then a `TransportCode`). `failure` is the server's `ErrorBody`.
 */
export class ApiError extends Data.TaggedError('ApiError')<{
  readonly status: number;
  readonly failure: Failure;
}> {
  override get message(): string {
    return this.failure.message;
  }
}

export interface AccountClientOptions {
  /** Origin of the server. Empty means same origin (web build). */
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
  /** The session token, when signed in. */
  readonly token?: string;
}

const urlOf = (options: AccountClientOptions, path: string) =>
  `${(options.baseUrl ?? '').replace(/\/+$/, '')}${path}`;

const transport = (code: string, message: string, retryable = true) =>
  new ApiError({ status: 0, failure: { code, message, retryable } });

const networkError = (error: unknown) =>
  transport(
    TransportCode.Network,
    error instanceof Error ? error.message : 'The request did not reach the server.',
  );

const headersOf = (options: AccountClientOptions, json: boolean): Record<string, string> => ({
  ...(json ? { 'content-type': 'application/json' } : {}),
  ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
});

/** The failure in an error response, or a generic one when the body is not an `ErrorBody`. */
const failureOf = (response: Response): Effect.Effect<ApiError> =>
  Effect.tryPromise(() => response.json() as Promise<unknown>).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(ErrorBody)),
    Effect.map(({ error }) => new ApiError({ status: response.status, failure: error })),
    Effect.catch(() =>
      Effect.succeed(
        new ApiError({
          status: response.status,
          failure: {
            code: 'InternalError',
            message: `Unexpected response (HTTP ${response.status}).`,
            retryable: response.status >= 500,
          },
        }),
      ),
    ),
  );

interface Call<A> {
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly path: string;
  /** Encoded with `schema` before sending. */
  readonly body?: { readonly schema: Schema.Codec<unknown, unknown>; readonly value: unknown };
  /** Decodes the answer. Absent: the answer has no body (204). */
  readonly response?: Schema.Codec<A, unknown>;
}

const request = <A>(options: AccountClientOptions, call: Call<A>): Effect.Effect<A, ApiError> =>
  Effect.gen(function* () {
    const doFetch = options.fetch ?? globalThis.fetch;
    const body =
      call.body === undefined
        ? undefined
        : JSON.stringify(Schema.encodeSync(call.body.schema)(call.body.value));
    const response = yield* Effect.tryPromise({
      try: (signal) =>
        doFetch(urlOf(options, call.path), {
          method: call.method,
          headers: headersOf(options, body !== undefined),
          ...(body === undefined ? {} : { body }),
          signal,
        }),
      catch: networkError,
    });
    if (!response.ok) return yield* Effect.fail(yield* failureOf(response));
    if (call.response === undefined) return undefined as A;
    const json = yield* Effect.tryPromise({
      try: () => response.json() as Promise<unknown>,
      catch: networkError,
    });
    return yield* Schema.decodeUnknownEffect(call.response)(json).pipe(
      Effect.mapError(() =>
        transport(TransportCode.Protocol, 'The response does not match the contract.', false),
      ),
    );
  });

const codec = <S extends Schema.Top>(schema: S) =>
  schema as unknown as Schema.Codec<S['Type'], unknown>;
const bodyOf = <S extends Schema.Top>(schema: S, value: S['Type']) => ({
  schema: schema as unknown as Schema.Codec<unknown, unknown>,
  value,
});

const practicePath = (practiceId: string) =>
  `${ACCOUNT_PRACTICE_PATH}/${encodeURIComponent(practiceId)}`;
const exercisePath = (exerciseId: string) =>
  `${ACCOUNT_PRACTICE_PATH}/exercises/${encodeURIComponent(exerciseId)}`;

const sessionPath = (sessionId: string) => `${SESSIONS_PATH}/${encodeURIComponent(sessionId)}`;

/** The account API as Effects. Build one per token. */
export const accountClient = (options: AccountClientOptions = {}) => {
  const go = <A>(call: Call<A>) => request(options, call);
  return {
    config: () => go({ method: 'GET', path: CONFIG_PATH, response: codec(PublicConfig) }),
    endpoints: () =>
      go({ method: 'GET', path: ENDPOINTS_PATH, response: codec(EndpointsResponse) }).pipe(
        Effect.map((answer) => answer.endpoints),
      ),

    register: (input: RegisterRequest) =>
      go({
        method: 'POST',
        path: REGISTER_PATH,
        body: bodyOf(RegisterRequest, input),
        response: codec(AuthResponse),
      }),
    login: (input: LoginRequest) =>
      go({
        method: 'POST',
        path: LOGIN_PATH,
        body: bodyOf(LoginRequest, input),
        response: codec(AuthResponse),
      }),
    logout: () => go<void>({ method: 'POST', path: LOGOUT_PATH }),
    me: () => go({ method: 'GET', path: ME_PATH, response: codec(MeResponse) }),

    settings: () =>
      go({ method: 'GET', path: ACCOUNT_SETTINGS_PATH, response: codec(AccountSettings) }),
    createConnection: (input: CreateConnectionRequest) =>
      go({
        method: 'POST',
        path: CONNECTIONS_PATH,
        body: bodyOf(CreateConnectionRequest, input),
        response: codec(ConnectionInfo),
      }),
    deleteConnection: (connectionId: string) =>
      go<void>({
        method: 'DELETE',
        path: `${CONNECTIONS_PATH}/${encodeURIComponent(connectionId)}`,
      }),
    setRoles: (roles: RoleModels) =>
      go({
        method: 'PUT',
        path: ROLES_PATH,
        body: bodyOf(SetRolesRequest, { roles }),
        response: codec(AccountSettings),
      }),

    profile: () => go({ method: 'GET', path: PROFILE_PATH, response: codec(ProfileResponse) }),
    saveProfile: (profile: SavedProfile) =>
      go({
        method: 'PUT',
        path: PROFILE_PATH,
        body: bodyOf(ProfileRequest, { profile }),
        response: codec(ProfileResponse),
      }),
    resetProfile: () =>
      go({ method: 'DELETE', path: PROFILE_PATH, response: codec(ProfileResponse) }),
    /** Extraction state of every session (phase 3 A3). */
    extractions: () =>
      go({ method: 'GET', path: EXTRACTIONS_PATH, response: codec(ExtractionList) }),
    /** Extract a session now, or retry a failed one. The job runs on the server. */
    extractSession: (sessionId: string) =>
      go({
        method: 'POST',
        path: EXTRACTIONS_PATH,
        body: bodyOf(ExtractSessionRequest, { sessionId }),
        response: codec(ExtractionList),
      }),

    sessions: () => go({ method: 'GET', path: SESSIONS_PATH, response: codec(SessionList) }),
    createSession: (input: CreateSessionRequest) =>
      go({
        method: 'POST',
        path: SESSIONS_PATH,
        body: bodyOf(CreateSessionRequest, input),
        response: codec(CreateSessionResponse),
      }),
    snapshot: (sessionId: string) =>
      go({ method: 'GET', path: sessionPath(sessionId), response: codec(SessionSnapshot) }),
    startTurn: (sessionId: string, input: StartTurnRequest) =>
      go({
        method: 'POST',
        path: `${sessionPath(sessionId)}/turns`,
        body: bodyOf(StartTurnRequest, input),
        response: codec(StartTurnResponse),
      }),
    cancelTurn: (sessionId: string, turnId: string) =>
      go<void>({
        method: 'POST',
        path: `${sessionPath(sessionId)}/turns/${encodeURIComponent(turnId)}/cancel`,
      }),
    skipStep: (sessionId: string, stepId: string) =>
      go<void>({
        method: 'POST',
        path: `${sessionPath(sessionId)}/skip`,
        body: bodyOf(SkipStepRequest, { stepId }),
      }),

    // Guest and demo practice (no token needed): the answer is the batch to append locally.
    issueExercises: (input: IssueExercisesRequest) =>
      go({
        method: 'POST',
        path: PRACTICE_ISSUE_PATH,
        body: bodyOf(IssueExercisesRequest, input),
        response: codec(IssueExercisesResponse),
      }),
    gradeAnswer: (input: GradeAnswerRequest) =>
      go({
        method: 'POST',
        path: PRACTICE_GRADE_PATH,
        body: bodyOf(GradeAnswerRequest, input),
        response: codec(GradeAnswerResponse),
      }),

    // Account practice: the server writes the knowledge log.
    practices: () =>
      go({ method: 'GET', path: ACCOUNT_PRACTICE_PATH, response: codec(PracticeList) }),
    practice: (practiceId: string) =>
      go({ method: 'GET', path: practicePath(practiceId), response: codec(PracticeView) }),
    startPractice: (input: StartPracticeRequest = {}) =>
      go({
        method: 'POST',
        path: ACCOUNT_PRACTICE_PATH,
        body: bodyOf(StartPracticeRequest, input),
        response: codec(PracticeView),
      }),
    endPractice: (practiceId: string) =>
      go({
        method: 'POST',
        path: `${practicePath(practiceId)}/end`,
        response: codec(PracticeView),
      }),
    answerExercise: (exerciseId: string, answer: ExerciseAnswer) =>
      go({
        method: 'POST',
        path: `${exercisePath(exerciseId)}/answer`,
        body: bodyOf(AnswerRequest, { answer }),
        response: codec(ExerciseView),
      }),
    gradeExercise: (exerciseId: string) =>
      go({
        method: 'POST',
        path: `${exercisePath(exerciseId)}/grade`,
        response: codec(ExerciseView),
      }),

    adminConfig: () => go({ method: 'GET', path: ADMIN_CONFIG_PATH, response: codec(AdminConfig) }),
    updateAdminConfig: (change: UpdateAdminConfigRequest) =>
      go({
        method: 'PUT',
        path: ADMIN_CONFIG_PATH,
        body: bodyOf(UpdateAdminConfigRequest, change),
        response: codec(AdminConfig),
      }),
    adminUsers: () => go({ method: 'GET', path: ADMIN_USERS_PATH, response: codec(AdminUserList) }),
    updateUser: (userId: string, change: UpdateUserRequest) =>
      go({
        method: 'PATCH',
        path: `${ADMIN_USERS_PATH}/${encodeURIComponent(userId)}`,
        body: bodyOf(UpdateUserRequest, change),
        response: codec(AdminUser),
      }),
    createInvite: (input: CreateInviteRequest = {}) =>
      go({
        method: 'POST',
        path: INVITES_PATH,
        body: bodyOf(CreateInviteRequest, input),
        response: codec(InviteResponse),
      }),
  };
};
export type AccountClient = ReturnType<typeof accountClient>;

const decodeAccountFrame = Schema.decodeUnknownEffect(AccountFrame);

/**
 * Follows a session: the `running` frame, then every event after `after` (`-1` for the whole
 * log), live text and turn status. Completes when the server closes the stream; the caller
 * reconnects with the last `seq` it saw. Interrupting the stream aborts the request; the
 * server's turns keep running (plan A2).
 */
export const streamSession = (
  sessionId: string,
  after: number,
  options: AccountClientOptions = {},
): Stream.Stream<AccountFrame, ApiError> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const controller = yield* Effect.acquireRelease(
        Effect.sync(() => new AbortController()),
        (c) => Effect.sync(() => c.abort()),
      );
      const doFetch = options.fetch ?? globalThis.fetch;
      const response = yield* Effect.tryPromise({
        try: () =>
          doFetch(urlOf(options, `${sessionPath(sessionId)}/stream?after=${after}`), {
            headers: { ...headersOf(options, false), accept: 'text/event-stream' },
            signal: controller.signal,
          }),
        catch: networkError,
      });
      if (!response.ok) return Stream.fail(yield* failureOf(response));
      if (response.body === null) {
        return Stream.fail(transport(TransportCode.Protocol, 'The response has no body.'));
      }
      const body = response.body;
      async function* messages() {
        const reader = body.getReader();
        const decoder = new TextDecoder();
        const parser = makeSseParser();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            yield* parser.push(decoder.decode(value, { stream: true }));
          }
          yield* parser.push(`${decoder.decode()}\n\n`);
        } finally {
          await reader.cancel().catch(() => undefined);
        }
      }
      return Stream.fromAsyncIterable(messages(), networkError).pipe(
        Stream.mapEffect((message) =>
          Effect.try({
            try: () => JSON.parse(message.data) as unknown,
            catch: () => transport(TransportCode.Protocol, 'Frame is not JSON.'),
          }).pipe(
            Effect.flatMap((json) =>
              decodeAccountFrame(json).pipe(
                Effect.mapError(() =>
                  transport(TransportCode.Protocol, 'Frame does not match the contract.'),
                ),
              ),
            ),
          ),
        ),
      );
    }),
  );
