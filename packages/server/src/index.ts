// Turn orchestration over HTTP/SSE (plan 3.1, A1), and accounts (plan tai-khoan.md). Runs in Node;
// the host mounts the handlers.
export { createHandlers, handleEndpoints, handleTurns, consoleLogger } from './handler.ts';
export type {
  CreateHandlersOptions,
  Handler,
  HandlerDeps,
  Handlers,
  LogEntry,
  LogFields,
  Logger,
  RequestContext,
} from './handler.ts';
export { ConfigError, DEFAULT_MAX_REQUEST_BYTES, loadConfig } from './config.ts';
export type { Endpoint, ServerConfig } from './config.ts';
export { loadAccountConfig } from './auth/config.ts';
export type { AccountConfig } from './auth/config.ts';
export type { AuthService, CurrentUser, RegistrationMode } from './auth/service.ts';
export { redact } from './safety.ts';
