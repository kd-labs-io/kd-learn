// Mounts @kd-learn/server in the web app (plan step 4). Only the server routes import this, and
// they load the server package lazily, so the SPA (Capacitor) bundle never contains it.
import type { Handlers } from '@kd-learn/server';

let handlers: Promise<Handlers> | undefined;

/** Handlers built once per process from the environment (see KD_* variables in @kd-learn/server). */
export const apiHandlers = (): Promise<Handlers> => {
  handlers ??= import('@kd-learn/server').then((server) => server.createHandlers(process.env));
  return handlers;
};

/**
 * The socket peer of the current request, for rate limiting. Never the X-Forwarded-For header:
 * the server package decides whether to trust that (KD_LEARN_TRUST_PROXY).
 */
export const requestContext = async (): Promise<{ clientAddress: string | undefined }> => {
  const { getRequestIP } = await import('@tanstack/react-start/server');
  return { clientAddress: getRequestIP() };
};
