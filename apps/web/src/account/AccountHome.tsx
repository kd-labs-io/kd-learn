// Home of a signed-in account: sessions on the server (plan A1), listed and created with Query.
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Heading } from '@astryxdesign/core/Heading';
import { HStack } from '@astryxdesign/core/HStack';
import { Layout, LayoutContent } from '@astryxdesign/core/Layout';
import { VStack } from '@astryxdesign/core/VStack';
import { getLocale, m } from '@kd-learn/i18n';
import { LoadingSkeleton } from '@kd-learn/ui/components/LoadingSkeleton';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { PracticeLink } from '../practice/PracticeLink';
import { homeColumn, SessionRows, StartTopic } from '../app/HomeParts';
import { preferredProvider, useAccountSourceLibrary } from '../sources/library';
import { noSources, SourcePicker, type PickedSources } from '../sources/SourcePicker';
import { errorText, keys, useAccountApi } from './api';
import { Block } from '../app/Block';
import { pageWidth } from '../app/page';

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
      contentWidth={pageWidth}
      content={
        <LayoutContent padding={6}>
          <VStack gap={6}>
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
            <HStack gap={10} vAlign="start" wrap="wrap">
              <VStack gap={6} width={homeColumn}>
                <StartTopic
                  topic={topic}
                  onTopic={setTopic}
                  onStart={start}
                  isStarting={create.isPending}
                  sources={<SourcePicker library={library} value={picked} onChange={setPicked} />}
                  error={
                    create.isError ? (
                      <Banner
                        status="error"
                        title={m.home_create_failed({ reason: errorText(create.error) })}
                      />
                    ) : null
                  }
                />
                <Block gap={0}>
                  <PracticeLink />
                </Block>
              </VStack>
              <VStack width={homeColumn}>
                <Block gap={3}>
                  <Heading level={2}>{m.home_sessions_title()}</Heading>
                  {sessions.isPending ? (
                    <LoadingSkeleton variant="list" label={m.loading()} />
                  ) : null}
                  {sessions.isError ? (
                    <Banner
                      status="error"
                      title={m.account_load_failed({ reason: errorText(sessions.error) })}
                      endContent={
                        <Button label={m.turn_retry()} onClick={() => void sessions.refetch()} />
                      }
                    />
                  ) : null}
                  {sessions.data === undefined ? null : (
                    <SessionRows
                      sessions={[...sessions.data.sessions].sort(
                        (a, b) => b.updatedAt - a.updatedAt,
                      )}
                      onOpen={(sessionId) =>
                        void navigate({ to: '/a/$sessionId', params: { sessionId } })
                      }
                    />
                  )}
                </Block>
              </VStack>
            </HStack>
          </VStack>
        </LayoutContent>
      }
    />
  );
}
