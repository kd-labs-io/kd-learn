// Parts shared by the guest and the account home (plan cai-thien-ux.md step 4): the topic box is
// the one main action, the session list says where each lesson stands.
import { Button } from '@astryxdesign/core/Button';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { Heading } from '@astryxdesign/core/Heading';
import { HStack } from '@astryxdesign/core/HStack';
import { Item } from '@astryxdesign/core/Item';
import { Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';
import { VStack } from '@astryxdesign/core/VStack';
import { m } from '@kd-learn/i18n';
import { useState, type ReactNode } from 'react';
import { Block } from './Block';
import { formatDate } from './format';

/** Column width of the two home columns: side by side on a wide screen, stacked on a phone. */
export const homeColumn = 'min(100%, 460px)';

interface StartTopicProps {
  readonly topic: string;
  readonly onTopic: (topic: string) => void;
  readonly onStart: () => void;
  readonly isStarting: boolean;
  /** The source picker, between the box and the button. */
  readonly sources: ReactNode;
  readonly error: ReactNode;
}

export function StartTopic({
  topic,
  onTopic,
  onStart,
  isStarting,
  sources,
  error,
}: StartTopicProps) {
  // The button stays enabled: pressing it with an empty box says why instead of doing nothing.
  const [tried, setTried] = useState(false);
  const empty = topic.trim() === '';
  const start = () => {
    setTried(true);
    if (!empty) onStart();
  };
  const suggestions = [m.home_suggestion_1(), m.home_suggestion_2(), m.home_suggestion_3()];
  return (
    <Block gap={4}>
      <Heading level={2}>{m.home_hero_title()}</Heading>
      <TextInput
        label={m.home_topic_label()}
        isLabelHidden
        placeholder={m.home_topic_placeholder()}
        value={topic}
        onChange={(value) => {
          onTopic(value);
          setTried(false);
        }}
        onEnter={start}
        {...(tried && empty ? { status: { type: 'error', message: m.home_start_hint() } } : {})}
        data-testid="topic-input"
      />
      <HStack gap={1} vAlign="center" wrap="wrap">
        <Text type="supporting">{m.home_suggestions()}</Text>
        {suggestions.map((suggestion) => (
          <Button
            key={suggestion}
            label={suggestion}
            variant="ghost"
            size="sm"
            onClick={() => {
              onTopic(suggestion);
              setTried(false);
            }}
            data-testid="topic-suggestion"
          />
        ))}
      </HStack>
      {sources}
      <Button
        label={m.home_start()}
        variant="primary"
        size="lg"
        isLoading={isStarting}
        onClick={start}
        data-testid="start-session"
      />
      {error}
    </Block>
  );
}

/** What the list knows of a session: the storage summary, guest or account. */
export interface SessionRowData {
  readonly sessionId: string;
  readonly topic: string;
  readonly updatedAt: number;
  readonly stepsTotal?: number;
  readonly stepsResolved: number;
  readonly completed: boolean;
}

const statusOf = (session: SessionRowData) =>
  session.completed
    ? { text: m.session_status_done(), color: 'secondary' as const }
    : session.stepsTotal === undefined
      ? { text: m.session_status_new(), color: 'accent' as const }
      : { text: m.session_status_active(), color: 'accent' as const };

export function SessionRows({
  sessions,
  onOpen,
}: {
  sessions: ReadonlyArray<SessionRowData>;
  onOpen: (sessionId: string) => void;
}) {
  if (sessions.length === 0) {
    return (
      <EmptyState
        title={m.home_sessions_empty_title()}
        description={m.home_sessions_empty_body()}
        isCompact
        data-testid="no-sessions"
      />
    );
  }
  return (
    <VStack gap={1} as="ul" data-testid="session-list">
      {sessions.map((session) => {
        const status = statusOf(session);
        const progress =
          session.stepsTotal === undefined || session.completed
            ? undefined
            : m.session_progress({ done: session.stepsResolved, total: session.stepsTotal });
        return (
          <Item
            as="li"
            key={session.sessionId}
            label={session.topic === '' ? session.sessionId : session.topic}
            description={[progress, m.home_session_updated({ date: formatDate(session.updatedAt) })]
              .filter(Boolean)
              .join(' · ')}
            endContent={
              <Text type="supporting" color={status.color} data-testid="session-status">
                {status.text}
              </Text>
            }
            onClick={() => onOpen(session.sessionId)}
            data-testid="session-item"
          />
        );
      })}
    </VStack>
  );
}
