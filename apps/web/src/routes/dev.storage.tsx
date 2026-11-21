// Test harness for the local DB (plan step 5). Playwright drives `window.__kdStorage` here
// (apps/web/e2e/storage.e2e.ts); the page also shows the live session list from the store hooks.
// Not linked from the app. Remove once the step 7 UI can be tested directly.
import { Heading } from '@astryxdesign/core/Heading';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { projectSession, type DomainEvent, type SavedProfile } from '@kd-learn/core';
import type { GuestSettings } from '@kd-learn/storage/port';
import { createFileRoute } from '@tanstack/react-router';
import { Result } from 'effect';
import { useEffect, useState } from 'react';
import { getStorage, runStorage, useSession, useSessionList } from '../storage';

export const Route = createFileRoute('/dev/storage')({ component: DevStorage });

async function guard<A>(run: () => Promise<A>): Promise<A | { error: string; message: string }> {
  try {
    return await run();
  } catch (error) {
    const e = error as { _tag?: string; message?: string };
    return { error: e._tag ?? 'Error', message: e.message ?? String(error) };
  }
}

/** Plain-data API for the browser test. Errors come back as `{ error: tag, message }`. */
const api = {
  async persistent() {
    return (await getStorage()).persistent;
  },
  append: (sessionId: string, events: DomainEvent[]) =>
    guard(() => runStorage((storage) => storage.appendEvents(sessionId, events))),
  read: (sessionId: string) => guard(() => runStorage((storage) => storage.readSession(sessionId))),
  list: () => guard(() => runStorage((storage) => storage.listSessions)),
  getSettings: () => guard(() => runStorage((storage) => storage.getSettings)),
  saveSettings: (settings: GuestSettings) =>
    guard(() => runStorage((storage) => storage.saveSettings(settings))),
  deleteApiKey: () => guard(() => runStorage((storage) => storage.deleteApiKey)),
  getProfile: () => guard(() => runStorage((storage) => storage.getProfile)),
  saveProfile: (profile: SavedProfile | undefined) =>
    guard(() => runStorage((storage) => storage.saveProfile(profile))),
  /** State of the projection of a stored log, to check `core` and the store work together. */
  async state(sessionId: string) {
    const log = await runStorage((storage) => storage.readSession(sessionId));
    const session = projectSession(log);
    return Result.isSuccess(session) ? session.success.state._tag : `error:${session.failure._tag}`;
  },
};

declare global {
  interface Window {
    __kdStorage?: typeof api;
  }
}

const viewedSession = 'view';

function DevStorage() {
  const [ready, setReady] = useState(false);
  const sessions = useSessionList();
  const view = useSession(viewedSession);

  useEffect(() => {
    window.__kdStorage = api;
    void getStorage().then(() => setReady(true));
  }, []);

  return (
    <VStack gap={4} padding={6}>
      <Heading level={1}>Storage harness</Heading>
      <Text id="storage-state">{ready ? 'ready' : 'loading'}</Text>
      <Text id="session-count">
        {sessions.status === 'ready' ? `sessions: ${sessions.data.length}` : 'sessions: ...'}
      </Text>
      <Text id="view-events">
        {view.status === 'ready' ? `view events: ${view.data.log.length}` : 'view events: ...'}
      </Text>
    </VStack>
  );
}
