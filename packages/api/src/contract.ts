// The HTTP contract between the client (browser, Capacitor) and the server (plan A1, A6).
// Plain data, no IO: the server decodes requests and encodes frames with these schemas, the
// client does the opposite, and neither side hand-writes JSON shapes.
import { Schema } from 'effect';
import { DomainEvent, EventLog, SavedProfile, TeachingProfile } from '@kd-learn/core';

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
export const PROFILE_PATH = '/api/account/profile';
export const SESSIONS_PATH = '/api/account/sessions';
export const CONFIG_PATH = '/api/config';
export const ADMIN_CONFIG_PATH = '/api/admin/config';
export const ADMIN_USERS_PATH = '/api/admin/users';

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
  /** Demo mode (plan A8): the server picks provider, model and key, and counts the calls. */
  Schema.Struct({ provider: Schema.Literal('demo') }),
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
  /** The session already runs a turn of this kind (one main and one side turn at a time, A2). */
  TurnInProgress: 'TurnInProgress',
  /** The turn cannot start in this state (session done, nothing to retry, step not current). */
  NothingToRun: 'NothingToRun',
  /** The turn ran out of time on the server. */
  TurnTimeout: 'TurnTimeout',
  /** The admin turned guest mode off: `POST /api/turns` is closed (plan A7). */
  GuestModeDisabled: 'GuestModeDisabled',
  /** The change would lock the admin out (disabling their own account). */
  Conflict: 'Conflict',
  /** Demo mode is off, its budget is 0, or the server has no demo model (plan A8). */
  DemoModeDisabled: 'DemoModeDisabled',
  /** The shared demo budget of this period is used up (plan A8). */
  DemoQuotaExceeded: 'DemoQuotaExceeded',
  /** The admin has not enabled this ACP agent, or disabled it since (plan A9). */
  AcpAgentDisabled: 'AcpAgentDisabled',
  /** The model is not on the admin's list for this ACP agent (risk 30). */
  AcpModelNotAllowed: 'AcpModelNotAllowed',
  /** Every ACP agent slot of the server is in use (plan A9). Retryable. */
  AcpBusy: 'AcpBusy',
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

/** Roles that pick their own model. Phase 3 adds `practitioner` and `extractor` (phase 3 A5). */
export const ModelRole = Schema.Literals([
  'prober',
  'teacher',
  'sideChat',
  'practitioner',
  'extractor',
]);
export type ModelRole = typeof ModelRole.Type;

/**
 * A role that is not set uses the model of this role instead (phase 3 A5): accounts from phase 2
 * have no model for the phase 3 roles. One level only; the roles of phase 2 have no fallback.
 */
export const roleFallback: Readonly<Partial<Record<ModelRole, ModelRole>>> = {
  practitioner: 'teacher',
  extractor: 'teacher',
};

const Label = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80));

/** `POST /api/account/connections`. ACP connections come with step 7. */
/** Agent CLIs driven over ACP (plan A9). Account mode only; the admin enables each one. */
export const AcpAgent = Schema.Literals(['claude-code', 'antigravity', 'opencode']);
export type AcpAgent = typeof AcpAgent.Type;

/**
 * Models the admin allows per ACP agent (risk 30): an ACP connection runs on the server
 * operator's own subscription, so a learner may only pick from this list. A missing or empty list
 * allows nothing.
 */
export const AcpModels = Schema.Struct({
  'claude-code': Schema.optionalKey(Schema.Array(ModelName)),
  antigravity: Schema.optionalKey(Schema.Array(ModelName)),
  opencode: Schema.optionalKey(Schema.Array(ModelName)),
});
export type AcpModels = typeof AcpModels.Type;

export const CreateConnectionRequest = Schema.Union([
  Schema.Struct({ label: Label, provider: Schema.Literal('anthropic'), apiKey: Secret }),
  Schema.Struct({ label: Label, provider: Schema.Literal('gemini'), apiKey: Secret }),
  Schema.Struct({
    label: Label,
    provider: Schema.Literal('openai-compatible'),
    endpointId: EndpointId,
    apiKey: Secret,
  }),
  /** No key: the agent uses its own login on the server. */
  Schema.Struct({ label: Label, provider: Schema.Literal('acp'), agent: AcpAgent }),
]);
export type CreateConnectionRequest = typeof CreateConnectionRequest.Type;

export const ConnectionInfo = Schema.Struct({
  id: Schema.NonEmptyString,
  label: Schema.String,
  provider: Schema.Literals(['anthropic', 'gemini', 'openai-compatible', 'acp']),
  endpointId: Schema.optionalKey(EndpointId),
  agent: Schema.optionalKey(AcpAgent),
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
  practitioner: Schema.optionalKey(RoleModel),
  extractor: Schema.optionalKey(RoleModel),
});
export type RoleModels = typeof RoleModels.Type;

/** `PUT /api/account/roles`: replaces the whole map. */
export const SetRolesRequest = Schema.Struct({ roles: RoleModels });
export type SetRolesRequest = typeof SetRolesRequest.Type;

/** `GET /api/account/settings`. */
export const AccountSettings = Schema.Struct({
  connections: Schema.Array(ConnectionInfo),
  roles: RoleModels,
  /** ACP agents the admin enabled: the ones a new connection may use. */
  acpAgents: Schema.Array(AcpAgent),
  /** The models a role may pick for each enabled agent. */
  acpModels: AcpModels,
});
export type AccountSettings = typeof AccountSettings.Type;

// Teaching profile of an account (phase 3 A2): `GET`, `PUT` (ProfileRequest) and `DELETE` (back to
// the default) on `PROFILE_PATH`. Each answers with `ProfileResponse`.

/** `PUT /api/account/profile`. Validated against the saving limits on both sides. */
export const ProfileRequest = Schema.Struct({ profile: SavedProfile });
export type ProfileRequest = typeof ProfileRequest.Type;

/** Body limit of `PUT /api/account/profile`: seven prompts at the longest, as 3-byte UTF-8. */
export const MAX_PROFILE_BODY_BYTES = 512 * 1024;

export const ProfileResponse = Schema.Struct({
  /** The profile new sessions use: the saved one with defaults filled in, or the default. */
  profile: TeachingProfile,
  /** False when nothing is saved and `profile` is the default. */
  saved: Schema.Boolean,
});
export type ProfileResponse = typeof ProfileResponse.Type;

// Account sessions (plan tai-khoan.md A1, A2). The server writes the log; the client only reads it,
// starts turns, and follows the stream. Paths below `SESSIONS_PATH`:
//   GET  /                                  list
//   POST /                                  create (CreateSessionRequest)
//   GET  /:id                               snapshot (SessionSnapshot)
//   GET  /:id/stream?after=<seq>            SSE of AccountFrame
//   POST /:id/turns                         start (StartTurnRequest) -> StartTurnResponse
//   POST /:id/turns/:turnId/cancel          cancel a running turn
//   POST /:id/skip                          skip the current step (SkipStepRequest)

/** Learner input of one message. */
// 4000 code units stay under the 16 KiB body cap of account routes, even as 3-byte UTF-8.
const Input = Schema.String.check(Schema.isMaxLength(4000));

export const CreateSessionRequest = Schema.Struct({
  topic: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  /** Language of the lesson, a BCP 47 tag such as `vi` or `en`. */
  language: Schema.String.check(Schema.isPattern(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/)),
});
export type CreateSessionRequest = typeof CreateSessionRequest.Type;

export const CreateSessionResponse = Schema.Struct({ sessionId: Schema.NonEmptyString });
export type CreateSessionResponse = typeof CreateSessionResponse.Type;

export const SessionSummaryInfo = Schema.Struct({
  sessionId: Schema.NonEmptyString,
  topic: Schema.String,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
  eventCount: Schema.Number,
});
export const SessionList = Schema.Struct({ sessions: Schema.Array(SessionSummaryInfo) });
export type SessionList = typeof SessionList.Type;

/**
 * `send`: the learner's answer. `retry`: the input of the failed or interrupted last turn again.
 * `auto`: the turn that needs no input (first Prober turn, planning). `side`: a side chat message
 * (`content` absent: answer the last learner message again).
 */
export const StartTurnRequest = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('send'), input: Input }),
  Schema.Struct({ kind: Schema.Literal('retry') }),
  Schema.Struct({ kind: Schema.Literal('auto') }),
  Schema.Struct({
    kind: Schema.Literal('side'),
    threadId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
    content: Schema.optionalKey(Input.check(Schema.isMinLength(1))),
  }),
]);
export type StartTurnRequest = typeof StartTurnRequest.Type;

/** `turnId` of a main turn; for a side turn, the id the stream uses for it. */
export const StartTurnResponse = Schema.Struct({ turnId: Schema.NonEmptyString });
export type StartTurnResponse = typeof StartTurnResponse.Type;

export const SkipStepRequest = Schema.Struct({ stepId: Schema.NonEmptyString });
export type SkipStepRequest = typeof SkipStepRequest.Type;

/** A turn the server is running now. An open `TurnStarted` without one is interrupted. */
export const RunningTurn = Schema.Struct({
  turnId: Schema.NonEmptyString,
  kind: Schema.Literals(['main', 'side']),
  threadId: Schema.optionalKey(Schema.String),
  /** Text streamed so far, per assistant message. */
  text: Schema.Array(Schema.Struct({ messageId: Schema.String, text: Schema.String })),
});
export type RunningTurn = typeof RunningTurn.Type;

/** `seq` is the position in the session log: contiguous from 0. */
export const SequencedEvent = Schema.Struct({ seq: Schema.Number, event: DomainEvent });
export type SequencedEvent = typeof SequencedEvent.Type;

/** `GET .../sessions/:id`. */
export const SessionSnapshot = Schema.Struct({
  events: Schema.Array(SequencedEvent),
  running: Schema.Array(RunningTurn),
});
export type SessionSnapshot = typeof SessionSnapshot.Type;

/** First frame of a stream: the turns running at connect time, with their text so far. */
export const RunningFrame = Schema.TaggedStruct('running', { turns: Schema.Array(RunningTurn) });
/** A committed event, in log order. */
export const LogFrame = Schema.TaggedStruct('log', SequencedEvent.fields);
/** Live text of a running turn. Display only. */
export const TurnDeltaFrame = Schema.TaggedStruct('delta', {
  turnId: Schema.NonEmptyString,
  messageId: Schema.NonEmptyString,
  delta: Schema.String,
});
/** A turn started (`running`) or ended. `failed` carries the failure (also in the log). */
export const TurnFrame = Schema.TaggedStruct('turn', {
  turnId: Schema.NonEmptyString,
  kind: Schema.Literals(['main', 'side']),
  threadId: Schema.optionalKey(Schema.String),
  status: Schema.Literals(['running', 'completed', 'failed', 'cancelled']),
  error: Schema.optionalKey(Failure),
});

export const AccountFrame = Schema.Union([RunningFrame, LogFrame, TurnDeltaFrame, TurnFrame]);
export type AccountFrame = typeof AccountFrame.Type;

// Admin switches (plan tai-khoan.md A7). The server enforces them; the UI only reflects them.

export const RegistrationMode = Schema.Literals(['open', 'invite', 'closed']);
export type RegistrationMode = typeof RegistrationMode.Type;

/** `GET /api/config` (no sign-in): what this server offers, so the UI shows the right entry points. */
export const PublicConfig = Schema.Struct({
  /** False when the server runs without accounts (no `KD_LEARN_SECRET_KEY`): guest mode only. */
  accounts: Schema.Boolean,
  registration: RegistrationMode,
  guestMode: Schema.Boolean,
  demoMode: Schema.Boolean,
});
export type PublicConfig = typeof PublicConfig.Type;

export const DemoBudgetPeriod = Schema.Literals(['day', 'month', 'none']);
export type DemoBudgetPeriod = typeof DemoBudgetPeriod.Type;

/** Model calls for every demo user together (plan A8). Periods are UTC days or months. */
export const DemoBudget = Schema.Struct({
  /** 0 closes demo mode. */
  limit: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  period: DemoBudgetPeriod,
  /** Calls used in the current period, reservations of running turns included. */
  used: Schema.Int,
});
export type DemoBudget = typeof DemoBudget.Type;

/** `GET /api/admin/config`. Step 7 adds the ACP agents. */
export const AdminConfig = Schema.Struct({
  registration: RegistrationMode,
  guestMode: Schema.Boolean,
  demoMode: Schema.Boolean,
  demoBudget: DemoBudget,
  /** The demo model from the environment, without its key; absent when none is set. */
  demoModel: Schema.optionalKey(Schema.String),
  acpAgents: Schema.Array(AcpAgent),
  /** Models a role may pick, per agent (risk 30). */
  acpModels: AcpModels,
  /** Agent processes that may run at once, for every user together. */
  acpMaxConcurrent: Schema.Int,
  /**
   * False when this build does not include the ACP adapter (built without `KD_BUILD_ACP=1`):
   * enabled agents then fail every turn with `AcpUnavailable`. Checked only while an agent is
   * enabled (loading the adapter resolves agent binaries); `true` when none is.
   */
  acpAvailable: Schema.Boolean,
});
export type AdminConfig = typeof AdminConfig.Type;

/** `PUT /api/admin/config`: only the fields given change. */
export const UpdateAdminConfigRequest = Schema.Struct({
  registration: Schema.optionalKey(RegistrationMode),
  guestMode: Schema.optionalKey(Schema.Boolean),
  demoMode: Schema.optionalKey(Schema.Boolean),
  demoBudgetLimit: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(1_000_000_000)),
  ),
  demoBudgetPeriod: Schema.optionalKey(DemoBudgetPeriod),
  acpAgents: Schema.optionalKey(Schema.Array(AcpAgent)),
  /** Replaces the whole map. */
  acpModels: Schema.optionalKey(AcpModels),
  acpMaxConcurrent: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(32)),
  ),
});
export type UpdateAdminConfigRequest = typeof UpdateAdminConfigRequest.Type;

export const AdminUser = Schema.Struct({
  id: Schema.NonEmptyString,
  email: Schema.String,
  role: Role,
  disabled: Schema.Boolean,
  /** Too many failed logins: sign-in is refused until `lockedUntil` (epoch ms) or an unlock. */
  lockedUntil: Schema.optionalKey(Schema.Number),
  createdAt: Schema.Number,
});
export type AdminUser = typeof AdminUser.Type;

/** `GET /api/admin/users`. */
export const AdminUserList = Schema.Struct({ users: Schema.Array(AdminUser) });
export type AdminUserList = typeof AdminUserList.Type;

/**
 * `PATCH /api/admin/users/:id`. `disabled: true` also revokes every token of the user;
 * `unlock: true` clears the failed-login lock.
 */
export const UpdateUserRequest = Schema.Struct({
  disabled: Schema.optionalKey(Schema.Boolean),
  unlock: Schema.optionalKey(Schema.Literal(true)),
});
export type UpdateUserRequest = typeof UpdateUserRequest.Type;
