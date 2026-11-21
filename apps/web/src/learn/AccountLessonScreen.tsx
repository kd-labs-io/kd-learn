// The learning screen for an account session: same screen as guests, fed by the server's log.
import { useNavigate } from '@tanstack/react-router';
import { useSyncExternalStore } from 'react';
import { clientOptions } from '../account/api';
import { signOut } from '../account/auth';
import { getAccountLesson } from './account-lesson';
import { LearnScreen } from './LearnScreen';

export function AccountLessonScreen({ token, sessionId }: { token: string; sessionId: string }) {
  const navigate = useNavigate();
  const lesson = getAccountLesson(token, sessionId, {
    options: clientOptions(token),
    onUnauthorized: signOut,
  });
  const { view, runner } = useSyncExternalStore(
    lesson.subscribe,
    lesson.getSnapshot,
    lesson.getSnapshot,
  );
  return (
    <LearnScreen
      source={{ view, state: runner, actions: lesson, elsewhere: false, persistent: true }}
      onHome={() => void navigate({ to: '/' })}
      onSettings={() => void navigate({ to: '/settings' })}
    />
  );
}
