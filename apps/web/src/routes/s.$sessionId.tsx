import { createFileRoute } from '@tanstack/react-router';
import { LearnScreen } from '../learn/LearnScreen';

export const Route = createFileRoute('/s/$sessionId')({ component: LessonRoute });

function LessonRoute() {
  const { sessionId } = Route.useParams();
  // `key`: a different session is a different screen, with its own drafts.
  return <LearnScreen key={sessionId} sessionId={sessionId} />;
}
