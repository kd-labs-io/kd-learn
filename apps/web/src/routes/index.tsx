import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Heading } from '@astryxdesign/core/Heading';
import { Item } from '@astryxdesign/core/Item';
import { Layout, LayoutContent } from '@astryxdesign/core/Layout';
import { Spinner } from '@astryxdesign/core/Spinner';
import { Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';
import { VStack } from '@astryxdesign/core/VStack';
import { defaultProfile } from '@kd-learn/agent/client';
import { getLocale, getLocaleTag, m } from '@kd-learn/i18n';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { AppHeader } from '../app/AppHeader';
import { useStoragePersistent } from '../learn/hooks';
import { runStorage, useGuestSettings, useSessionList } from '../storage';

export const Route = createFileRoute('/')({ component: Home });

const formatDate = (epochMs: number) =>
  new Intl.DateTimeFormat(getLocaleTag(), { dateStyle: 'medium', timeStyle: 'short' }).format(
    epochMs,
  );

function Home() {
  const navigate = useNavigate();
  const sessions = useSessionList();
  const settings = useGuestSettings();
  const persistent = useStoragePersistent();
  const [topic, setTopic] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const needsKey =
    settings.status === 'ready' && (settings.data === undefined || !settings.data.apiKey);

  const start = async () => {
    const name = topic.trim();
    if (name === '' || creating) return;
    setCreating(true);
    setError(undefined);
    try {
      const sessionId = crypto.randomUUID();
      // The log starts with the profile it was created with, in the learner's language (plan A1, A6).
      await runStorage((storage) =>
        storage.appendEvents(sessionId, [
          {
            _tag: 'SessionCreated',
            id: crypto.randomUUID(),
            at: Date.now(),
            sessionId,
            topic: name,
            profile: { ...defaultProfile, language: getLocale() },
          },
        ]),
      );
      await navigate({ to: '/s/$sessionId', params: { sessionId } });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setCreating(false);
    }
  };

  return (
    <Layout
      header={<AppHeader />}
      content={
        <LayoutContent padding={6}>
          <VStack gap={6} maxWidth="68ch">
            <Text type="large" color="secondary">
              {m.app_tagline()}
            </Text>

            {persistent === false ? (
              <Banner
                status="warning"
                title={m.storage_not_persistent_title()}
                description={m.storage_not_persistent_body()}
                data-testid="not-persistent"
              />
            ) : null}

            {needsKey ? (
              <Banner
                status="info"
                title={m.home_need_key_title()}
                description={m.home_need_key_body()}
                endContent={
                  <Button
                    label={m.home_need_key_action()}
                    onClick={() => void navigate({ to: '/settings' })}
                    data-testid="need-key-action"
                  />
                }
                data-testid="need-key"
              />
            ) : null}

            <VStack gap={3}>
              <Heading level={2}>{m.home_new_title()}</Heading>
              <TextInput
                label={m.home_topic_label()}
                placeholder={m.home_topic_placeholder()}
                value={topic}
                onChange={setTopic}
                onEnter={() => void start()}
                data-testid="topic-input"
              />
              <Button
                label={m.home_start()}
                variant="primary"
                isLoading={creating}
                isDisabled={topic.trim() === ''}
                onClick={() => void start()}
                data-testid="start-session"
              />
              {error === undefined ? null : (
                <Banner status="error" title={m.home_create_failed({ reason: error })} />
              )}
            </VStack>

            <VStack gap={2}>
              <Heading level={2}>{m.home_sessions_title()}</Heading>
              {sessions.status === 'loading' ? (
                <Spinner size="sm" label={m.learn_loading()} />
              ) : null}
              {sessions.status === 'error' ? (
                <Banner
                  status="error"
                  title={m.storage_error({ reason: sessions.error.message })}
                />
              ) : null}
              {sessions.status === 'ready' && sessions.data.length === 0 ? (
                <Text type="supporting" data-testid="no-sessions">
                  {m.home_sessions_empty()}
                </Text>
              ) : null}
              {sessions.status === 'ready' && sessions.data.length > 0 ? (
                <VStack gap={1} as="ul" data-testid="session-list">
                  {sessions.data.map((session) => (
                    <Item
                      as="li"
                      key={session.sessionId}
                      label={session.topic === '' ? session.sessionId : session.topic}
                      description={m.home_session_updated({ date: formatDate(session.updatedAt) })}
                      onClick={() =>
                        void navigate({
                          to: '/s/$sessionId',
                          params: { sessionId: session.sessionId },
                        })
                      }
                      data-testid="session-item"
                    />
                  ))}
                </VStack>
              ) : null}
            </VStack>
          </VStack>
        </LayoutContent>
      }
    />
  );
}
