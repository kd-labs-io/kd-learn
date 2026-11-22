// Home of a signed-in account: sessions on the server (plan A1), listed and created with Query.
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Heading } from '@astryxdesign/core/Heading';
import { Item } from '@astryxdesign/core/Item';
import { Layout, LayoutContent } from '@astryxdesign/core/Layout';
import { Spinner } from '@astryxdesign/core/Spinner';
import { Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';
import { VStack } from '@astryxdesign/core/VStack';
import { getLocale, m } from '@kd-learn/i18n';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { AppHeader } from '../app/AppHeader';
import { PracticeLink } from '../practice/PracticeLink';
import { formatDate } from '../app/GuestHome';
import { preferredProvider, useAccountSourceLibrary } from '../sources/library';
import { noSources, SourcePicker, type PickedSources } from '../sources/SourcePicker';
import { errorText, keys, useAccountApi } from './api';

export function AccountHome({ token }: { token: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { call } = useAccountApi();
  const [topic, setTopic] = useState('');
  const library = useAccountSourceLibrary(token);
  const [picked, setPicked] = useState<PickedSources>(noSources);

  const sessions = useQuery({
    queryKey: keys.sessions(token),
    queryFn: () => call((api) => api.sessions()),
  });
  const settings = useQuery({
    queryKey: keys.settings(token),
    queryFn: () => call((api) => api.settings()),
  });
  const create = useMutation({
    mutationFn: async (name: string) => {
      const created = await call((api) =>
        api.createSession({
          topic: name,
          language: getLocale(),
          ...(picked.sourceIds.length === 0 ? {} : { sourceIds: [...picked.sourceIds] }),
        }),
      );
      const provider = preferredProvider(library.providers);
      // The research runs on the server and attaches itself when ready; a refusal (no search
      // source any more) does not stop the lesson.
      if (picked.research && provider !== undefined) {
        await library.research(name, provider, created.sessionId).catch(() => undefined);
      }
      return created;
    },
    onSuccess: async ({ sessionId }) => {
      await queryClient.invalidateQueries({ queryKey: keys.sessions(token) });
      await navigate({ to: '/a/$sessionId', params: { sessionId } });
    },
  });

  const roles = settings.data?.roles;
  const needsRoles =
    roles !== undefined &&
    (roles.prober === undefined || roles.teacher === undefined || roles.sideChat === undefined);

  const start = () => {
    const name = topic.trim();
    if (name === '' || create.isPending) return;
    create.mutate(name);
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

            {needsRoles ? (
              <Banner
                status="info"
                title={m.account_need_roles_title()}
                description={m.account_need_roles_body()}
                endContent={
                  <Button
                    label={m.home_need_key_action()}
                    onClick={() => void navigate({ to: '/settings' })}
                    data-testid="need-roles-action"
                  />
                }
                data-testid="need-roles"
              />
            ) : null}

            <PracticeLink />

            <VStack gap={3}>
              <Heading level={2}>{m.home_new_title()}</Heading>
              <TextInput
                label={m.home_topic_label()}
                placeholder={m.home_topic_placeholder()}
                value={topic}
                onChange={setTopic}
                onEnter={start}
                data-testid="topic-input"
              />
              <SourcePicker library={library} value={picked} onChange={setPicked} />
              <Button
                label={m.home_start()}
                variant="primary"
                isLoading={create.isPending}
                isDisabled={topic.trim() === ''}
                onClick={start}
                data-testid="start-session"
              />
              {create.isError ? (
                <Banner
                  status="error"
                  title={m.home_create_failed({ reason: errorText(create.error) })}
                />
              ) : null}
            </VStack>

            <VStack gap={2}>
              <Heading level={2}>{m.home_sessions_title()}</Heading>
              {sessions.isPending ? <Spinner size="sm" label={m.learn_loading()} /> : null}
              {sessions.isError ? (
                <Banner
                  status="error"
                  title={m.account_load_failed({ reason: errorText(sessions.error) })}
                  endContent={
                    <Button label={m.turn_retry()} onClick={() => void sessions.refetch()} />
                  }
                />
              ) : null}
              {sessions.data?.sessions.length === 0 ? (
                <Text type="supporting" data-testid="no-sessions">
                  {m.home_sessions_empty()}
                </Text>
              ) : null}
              {sessions.data !== undefined && sessions.data.sessions.length > 0 ? (
                <VStack gap={1} as="ul" data-testid="session-list">
                  {[...sessions.data.sessions]
                    .sort((a, b) => b.updatedAt - a.updatedAt)
                    .map((session) => (
                      <Item
                        as="li"
                        key={session.sessionId}
                        label={session.topic === '' ? session.sessionId : session.topic}
                        description={m.home_session_updated({
                          date: formatDate(session.updatedAt),
                        })}
                        onClick={() =>
                          void navigate({
                            to: '/a/$sessionId',
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
