// The HTTP contract between the client (browser, Capacitor) and the server (plan A1, A6).
// Plain data, no IO: the server decodes requests and encodes frames with these schemas, the
// client does the opposite, and neither side hand-writes JSON shapes.
import { Schema } from 'effect';
import { DomainEvent, EventLog } from '@kd-learn/core';

export const TURNS_PATH = '/api/turns';
export const ENDPOINTS_PATH = '/api/endpoints';
export const REGISTER_PATH = '/api/auth/register';
export const LOGIN_PATH = '/api/auth/login';
export const LOGOUT_PATH = '/api/auth/logout';
export const ME_PATH = '/api/auth/me';
export const INVITES_PATH = '/api/admin/invites';
export const ACCOUNT_SETTINGS_PATH = '/api/account/settings';
export const CONNECTIONS_PATH = '/api/account/connections';
export const ROLES_PATH = '/api/account/roles';

const Secret = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512));
const ModelName = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));

/** Id of an OpenAI-compatible endpoint the server admin allows (plan A6, risk 6). */
export const EndpointId = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9_-]{0,63}$/));
export type EndpointId = typeof EndpointId.Type;

/**
 * Which model serves the turn, chosen by the guest: provider, model and the guest's own key.
 * An OpenAI-compatible endpoint is chosen by id only. There is deliberately no `baseURL` field,
 * and the server rejects a request that carries one (risk 6: SSRF). ACP is account mode only.
 */
export const ModelChoice = Schema.Union([
  Schema.Struct({
    provider: Schema.Literal('anthropic'),
    model: ModelName,
    apiKey: Secret,
  }),
  Schema.Struct({
    provider: Schema.Literal('gemini'),
    model: ModelName,
    apiKey: Secret,
  }),
  Schema.Struct({
    provider: Schema.Literal('openai-compatible'),
    endpointId: EndpointId,
    model: ModelName,
    apiKey: Secret,
  }),
]);
export type ModelChoice = typeof ModelChoice.Type;

/** The main thread, or a side chat thread (plan A5). */
export const TurnSelector = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('main') }),
  Schema.Struct({ kind: Schema.Literal('side'), threadId: Schema.NonEmptyString }),
]);
export type TurnSelector = typeof TurnSelector.Type;

/**
 * `POST /api/turns`. The log ends with the open `TurnStarted` (main) or the learner's
 * `SideMessageAppended` (side), written by the client before the request (plan A3).
 * Decode with `onExcessProperty: 'error'` so unknown fields are rejected, not dropped.
 */
export const TurnRequest = Schema.Struct({
  model: ModelChoice,
  turn: TurnSelector,
  log: EventLog,
});
export type TurnRequest = typeof TurnRequest.Type;

/** A failure the client can show. Never contains a key (plan A7). */
export const Failure = Schema.Struct({
  code: Schema.NonEmptyString,
  message: Schema.String,
  retryable: Schema.Boolean,
});
export type Failure = typeof Failure.Type;

/**
 * Codes the server itself produces. Provider failures carry the provider's own code
 * (or `ProviderError`), so `Failure.code` stays a plain string.
 */
export const ErrorCode = {
  InvalidRequest: 'InvalidRequest',
  HistoryTooLarge: 'HistoryTooLarge',
  UnknownEndpoint: 'UnknownEndpoint',
  InvalidTurn: 'InvalidTurn',
  MethodNotAllowed: 'MethodNotAllowed',
  /** No valid `Authorization: Bearer` token (missing, unknown, expired, revoked, account disabled). */
  Unauthorized: 'Unauthorized',
  /** Signed in, but not allowed (not an admin). */
  Forbidden: 'Forbidden',
  /** Wrong email or password. Same answer for an unknown email (risk 23). */
  InvalidCredentials: 'InvalidCredentials',
  /** Too many attempts for this email or from this address. `retryable`: try again later. */
  TooManyAttempts: 'TooManyAttempts',
  /** Right password, but an admin disabled the account. */
  AccountDisabled: 'AccountDisabled',
  RegistrationClosed: 'RegistrationClosed',
  /** Registration needs an invite, and the code is missing, used, expired or unknown. */
  InvalidInvite: 'InvalidInvite',
  EmailTaken: 'EmailTaken',
  /** The resource does not exist, or belongs to another account (same answer, plan A3). */
  NotFound: 'NotFound',
  /** No connection and model set for this role yet (account settings). */
  RoleNotConfigured: 'RoleNotConfigured',
  /** A stored key cannot be decrypted (the master key changed). Enter the key again. */
  KeyUnreadable: 'KeyUnreadable',
  Misconfigured: 'ServerMisconfigured',
  Internal: 'InternalError',
} as const;

/** Body of a response that is not a stream (HTTP 4xx and 5xx). */
export const ErrorBody = Schema.Struct({ error: Failure });
export type ErrorBody = typeof ErrorBody.Type;

/** Live text of the assistant message `messageId`. Display only; the client does not store it. */
export const DeltaFrame = Schema.TaggedStruct('delta', {
  messageId: Schema.NonEmptyString,
  delta: Schema.String,
});

/** One complete domain event. The client appends it to its local log, in order. */
export const EventFrame = Schema.TaggedStruct('event', { event: DomainEvent });

/** The turn failed. Follows the `TurnFailed` / `SideTurnFailed` event when the model call failed. */
export const ErrorFrame = Schema.TaggedStruct('error', { error: Failure });

/** Always the last frame of a stream. */
export const DoneFrame = Schema.TaggedStruct('done', {
  outcome: Schema.Literals(['completed', 'failed']),
});

export const Frame = Schema.Union([DeltaFrame, EventFrame, ErrorFrame, DoneFrame]);
export type Frame = typeof Frame.Type;

/** An OpenAI-compatible endpoint the guest may pick. The base URL stays on the server. */
export const EndpointInfo = Schema.Struct({ id: EndpointId, label: Schema.NonEmptyString });
export type EndpointInfo = typeof EndpointInfo.Type;

/** `GET /api/endpoints`. */
export const EndpointsResponse = Schema.Struct({ endpoints: Schema.Array(EndpointInfo) });
export type EndpointsResponse = typeof EndpointsResponse.Type;

// Accounts (plan tai-khoan.md A4). The token is opaque; send it as `Authorization: Bearer <token>`
// on every account request, from the web app and from Capacitor alike (plan step 0, C2).

const Email = Schema.String.check(
  Schema.isMaxLength(254),
  Schema.isPattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/),
);
/** Length in UTF-16 units; the server bounds it before hashing. */
const Password = Schema.String.check(Schema.isMinLength(8), Schema.isMaxLength(256));
const Token = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128));

export const Role = Schema.Literals(['admin', 'user']);
export type Role = typeof Role.Type;

export const User = Schema.Struct({ id: Schema.NonEmptyString, email: Schema.String, role: Role });
export type User = typeof User.Type;

/** `POST /api/auth/register`. `inviteCode` is required when registration is invite-only. */
export const RegisterRequest = Schema.Struct({
  email: Email,
  password: Password,
  inviteCode: Schema.optionalKey(Token),
});
export type RegisterRequest = typeof RegisterRequest.Type;

/** `POST /api/auth/login`. The password is not length-checked beyond the hashing bound. */
export const LoginRequest = Schema.Struct({
  email: Schema.String.check(Schema.isMaxLength(254)),
  password: Schema.String.check(Schema.isMaxLength(256)),
});
export type LoginRequest = typeof LoginRequest.Type;

/** Answer of register and login. `expiresAt` is epoch ms. */
export const AuthResponse = Schema.Struct({
  token: Token,
  expiresAt: Schema.Number,
  user: User,
});
export type AuthResponse = typeof AuthResponse.Type;

/** `GET /api/auth/me`. */
export const MeResponse = Schema.Struct({ user: User });
export type MeResponse = typeof MeResponse.Type;

/** `POST /api/admin/invites`. Default 72 hours, at most 30 days. */
export const CreateInviteRequest = Schema.Struct({
  expiresInHours: Schema.optionalKey(
    Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 720 })),
  ),
});
export type CreateInviteRequest = typeof CreateInviteRequest.Type;

/** The code is shown once; the server keeps only its hash. */
export const InviteResponse = Schema.Struct({ code: Token, expiresAt: Schema.Number });
export type InviteResponse = typeof InviteResponse.Type;

// Account settings (plan tai-khoan.md A5, A6). A key goes in once and never comes back out:
// responses carry only `hasKey` and the last 4 characters.

/** Roles that pick their own model. Phase 3 adds more keys without changing the shape. */
export const ModelRole = Schema.Literals(['prober', 'teacher', 'sideChat']);
export type ModelRole = typeof ModelRole.Type;

const Label = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80));

/** `POST /api/account/connections`. ACP connections come with step 7. */
export const CreateConnectionRequest = Schema.Union([
  Schema.Struct({ label: Label, provider: Schema.Literal('anthropic'), apiKey: Secret }),
  Schema.Struct({ label: Label, provider: Schema.Literal('gemini'), apiKey: Secret }),
  Schema.Struct({
    label: Label,
    provider: Schema.Literal('openai-compatible'),
    endpointId: EndpointId,
    apiKey: Secret,
  }),
]);
export type CreateConnectionRequest = typeof CreateConnectionRequest.Type;

export const ConnectionInfo = Schema.Struct({
  id: Schema.NonEmptyString,
  label: Schema.String,
  provider: Schema.Literals(['anthropic', 'gemini', 'openai-compatible']),
  endpointId: Schema.optionalKey(EndpointId),
  hasKey: Schema.Boolean,
  /** Last 4 characters of the key, to tell keys apart. */
  keyLast4: Schema.optionalKey(Schema.String),
  createdAt: Schema.Number,
});
export type ConnectionInfo = typeof ConnectionInfo.Type;

export const RoleModel = Schema.Struct({ connectionId: Schema.NonEmptyString, model: ModelName });
export type RoleModel = typeof RoleModel.Type;

/** Role → connection and model. A missing role is not configured. */
export const RoleModels = Schema.Struct({
  prober: Schema.optionalKey(RoleModel),
  teacher: Schema.optionalKey(RoleModel),
  sideChat: Schema.optionalKey(RoleModel),
});
export type RoleModels = typeof RoleModels.Type;

/** `PUT /api/account/roles`: replaces the whole map. */
export const SetRolesRequest = Schema.Struct({ roles: RoleModels });
export type SetRolesRequest = typeof SetRolesRequest.Type;

/** `GET /api/account/settings`. */
export const AccountSettings = Schema.Struct({
  connections: Schema.Array(ConnectionInfo),
  roles: RoleModels,
});
export type AccountSettings = typeof AccountSettings.Type;
