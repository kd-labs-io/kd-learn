// The learning screen in guest and demo mode: the log lives in the local DB and this tab runs the
// turns (plan phase 1, A3).
import { findInterruptedTurn } from '@kd-learn/core';
import { useNavigate } from '@tanstack/react-router';
import { Result } from 'effect';
import { useSession } from '../storage';
import { useRunner, useStoragePersistent, useTurnRunningElsewhere } from './hooks';
import { LearnScreen } from './LearnScreen';
import type { LessonView } from './source';

export function GuestLesson({ sessionId }: { sessionId: string }) {
  const navigate = useNavigate();
  const stored = useSession(sessionId);
  const { runner, state } = useRunner(sessionId);
  const persistent = useStoragePersistent();

  const view: LessonView =
    stored.status === 'ready'
      ? { status: 'ready', log: stored.data.log, session: stored.data.session }
      : stored.status === 'error'
        ? { status: 'error', message: stored.error.message }
        : { status: 'loading' };
  const session =
    stored.status === 'ready' && Result.isSuccess(stored.data.session)
      ? stored.data.session.success
      : undefined;
  const hasOpenTurn = session !== undefined && findInterruptedTurn(session) !== undefined;
  const elsewhere = useTurnRunningElsewhere(sessionId, hasOpenTurn && !state.main.running);

  return (
    <LearnScreen
      source={{ view, state, actions: runner, elsewhere, persistent }}
      onHome={() => void navigate({ to: '/' })}
      onSettings={() => void navigate({ to: '/settings' })}
    />
  );
}
