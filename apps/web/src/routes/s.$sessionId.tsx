import { createFileRoute } from '@tanstack/react-router';
import { GuestLesson } from '../learn/GuestLesson';

export const Route = createFileRoute('/s/$sessionId')({ component: LessonRoute });

function LessonRoute() {
  const { sessionId } = Route.useParams();
  // `key`: a different session is a different screen, with its own drafts.
  return <GuestLesson key={sessionId} sessionId={sessionId} />;
}
