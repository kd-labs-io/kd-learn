// Account settings (plan tai-khoan.md A5, A6): connections (a provider key, kept encrypted on the
// server, or an ACP agent the admin enabled) and the model of each role. A key is sent once and
// never shown again; the list only shows its last 4 characters.
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Heading } from '@astryxdesign/core/Heading';
import { HStack } from '@astryxdesign/core/HStack';
import { Item } from '@astryxdesign/core/Item';
import { Layout, LayoutContent } from '@astryxdesign/core/Layout';
import { Selector } from '@astryxdesign/core/Selector';
import { Spinner } from '@astryxdesign/core/Spinner';
import { Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';
import { VStack } from '@astryxdesign/core/VStack';
import type {
  AccountSettings,
  AcpAgent,
  ConnectionInfo,
  CreateConnectionRequest,
  ModelRole,
  RoleModels,
} from '@kd-learn/api';
import { m } from '@kd-learn/i18n';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { AppHeader } from '../app/AppHeader';
import { errorCode, errorText, keys, useAccountApi } from './api';

type Provider = ConnectionInfo['provider'];

const ROLES: ReadonlyArray<ModelRole> = ['prober', 'teacher', 'sideChat'];

const roleLabel = (role: ModelRole) =>
  role === 'prober' ? m.role_prober() : role === 'teacher' ? m.role_teacher() : m.role_sideChat();

const providerLabel = (provider: Provider) =>
  provider === 'anthropic'
    ? m.provider_anthropic()
    : provider === 'gemini'
      ? m.provider_gemini()
      : provider === 'openai-compatible'
        ? m.provider_openai_compatible()
        : m.provider_acp();

export const agentLabel = (agent: AcpAgent) =>
  agent === 'claude-code' ? 'Claude Code' : agent === 'opencode' ? 'opencode' : 'Antigravity CLI';

const settingsErrorText = (error: unknown) => {
  switch (errorCode(error)) {
    case 'AcpModelNotAllowed':
      return m.error_AcpModelNotAllowed();
    case 'AcpAgentDisabled':
      return m.error_AcpAgentDisabled();
    case 'UnknownEndpoint':
      return m.error_UnknownEndpoint();
    default:
      return m.error_generic({ message: errorText(error) });
  }
};

export function AccountSettingsScreen({ token }: { token: string }) {
  const { call } = useAccountApi();
  const settings = useQuery({
    queryKey: keys.settings(token),
    queryFn: () => call((api) => api.settings()),
  });
  const endpoints = useQuery({
    queryKey: keys.endpoints,
    queryFn: () => call((api) => api.endpoints()),
  });

  return (
    <Layout
      header={<AppHeader />}
      content={
        <LayoutContent padding={6}>
          <VStack gap={6} maxWidth="60ch">
            <Heading level={2}>{m.settings_title()}</Heading>
            {settings.isPending ? <Spinner size="sm" label={m.learn_loading()} /> : null}
            {settings.isError ? (
              <Banner
                status="error"
                title={m.account_load_failed({ reason: errorText(settings.error) })}
              />
            ) : null}
            {settings.data === undefined ? null : (
              <>
                <Connections
                  token={token}
                  settings={settings.data}
                  endpoints={endpoints.data ?? []}
                />
                <Roles token={token} settings={settings.data} />
              </>
            )}
          </VStack>
        </LayoutContent>
      }
    />
  );
}

function Connections({
  token,
  settings,
  endpoints,
}: {
  token: string;
  settings: AccountSettings;
  endpoints: ReadonlyArray<{ id: string; label: string }>;
}) {
  const { call } = useAccountApi();
  const queryClient = useQueryClient();
  const [provider, setProvider] = useState<Provider>('anthropic');
  const [label, setLabel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [endpointId, setEndpointId] = useState('');
  const [agent, setAgent] = useState<string>('');
  const [message, setMessage] = useState<{ ok: boolean; text: string } | undefined>(undefined);

  const refresh = () => queryClient.invalidateQueries({ queryKey: keys.settings(token) });
  const create = useMutation({
    mutationFn: (input: CreateConnectionRequest) => call((api) => api.createConnection(input)),
    onSuccess: async () => {
      setApiKey('');
      setLabel('');
      setMessage({ ok: true, text: m.settings_saved() });
      await refresh();
    },
    onError: (error) => setMessage({ ok: false, text: settingsErrorText(error) }),
  });
  const remove = useMutation({
    mutationFn: (id: string) => call((api) => api.deleteConnection(id)),
    onSettled: refresh,
  });

  const providers: Array<{ value: Provider; label: string }> = [
    { value: 'anthropic', label: m.provider_anthropic() },
    { value: 'gemini', label: m.provider_gemini() },
    ...(endpoints.length > 0
      ? [{ value: 'openai-compatible' as const, label: m.provider_openai_compatible() }]
      : []),
    ...(settings.acpAgents.length > 0 ? [{ value: 'acp' as const, label: m.provider_acp() }] : []),
  ];

  const submit = () => {
    setMessage(undefined);
    const name = label.trim() || providerLabel(provider);
    if (provider === 'acp') {
      const chosen = settings.acpAgents.find((a) => a === agent);
      if (chosen === undefined) return setMessage({ ok: false, text: m.connection_missing() });
      return create.mutate({ label: name, provider: 'acp', agent: chosen });
    }
    const key = apiKey.trim();
    if (key === '') return setMessage({ ok: false, text: m.connection_missing() });
    if (provider === 'openai-compatible') {
      if (endpointId === '') return setMessage({ ok: false, text: m.connection_missing() });
      return create.mutate({ label: name, provider, endpointId, apiKey: key });
    }
    return create.mutate({ label: name, provider, apiKey: key });
  };

  return (
    <VStack gap={3}>
      <Heading level={3}>{m.connections_title()}</Heading>
      <Text type="supporting">{m.connections_hint()}</Text>
      {settings.connections.length === 0 ? (
        <Text type="supporting" data-testid="no-connections">
          {m.connections_empty()}
        </Text>
      ) : (
        <VStack gap={1} as="ul" data-testid="connection-list">
          {settings.connections.map((connection) => (
            <Item
              as="li"
              key={connection.id}
              label={connection.label}
              description={[
                providerLabel(connection.provider),
                connection.agent === undefined ? undefined : agentLabel(connection.agent),
                connection.endpointId,
                connection.keyLast4 === undefined
                  ? undefined
                  : m.connection_key_last4({ last4: connection.keyLast4 }),
              ]
                .filter((part) => part !== undefined)
                .join(' · ')}
              endContent={
                <Button
                  label={m.connection_delete()}
                  variant="ghost"
                  size="sm"
                  onClick={() => remove.mutate(connection.id)}
                  data-testid="connection-delete"
                />
              }
              data-testid="connection-item"
            />
          ))}
        </VStack>
      )}

      <Heading level={4}>{m.connection_add()}</Heading>
      <Selector
        label={m.settings_provider()}
        options={providers}
        value={provider}
        onChange={(value) => setProvider(value as Provider)}
        data-testid="connection-provider"
      />
      {provider === 'openai-compatible' ? (
        <Selector
          label={m.settings_endpoint()}
          placeholder={m.settings_endpoint_placeholder()}
          options={endpoints.map((endpoint) => ({ value: endpoint.id, label: endpoint.label }))}
          value={endpointId}
          onChange={setEndpointId}
          data-testid="connection-endpoint"
        />
      ) : null}
      {provider === 'acp' ? (
        <Selector
          label={m.connection_agent()}
          description={m.connection_agent_hint()}
          placeholder={m.connection_agent_placeholder()}
          options={settings.acpAgents.map((id) => ({ value: id, label: agentLabel(id) }))}
          value={agent}
          onChange={setAgent}
          data-testid="connection-agent"
        />
      ) : (
        <TextInput
          label={m.settings_key()}
          description={m.connection_key_hint()}
          type="password"
          value={apiKey}
          onChange={setApiKey}
          autoComplete="off"
          data-testid="connection-key"
        />
      )}
      <TextInput
        label={m.connection_label()}
        placeholder={providerLabel(provider)}
        value={label}
        onChange={setLabel}
        autoComplete="off"
        data-testid="connection-label"
      />
      {message === undefined ? null : (
        <Banner
          status={message.ok ? 'success' : 'error'}
          title={message.text}
          data-testid="connection-message"
        />
      )}
      <HStack>
        <Button
          label={m.connection_add()}
          variant="primary"
          isLoading={create.isPending}
          onClick={submit}
          data-testid="connection-save"
        />
      </HStack>
    </VStack>
  );
}

function Roles({ token, settings }: { token: string; settings: AccountSettings }) {
  const { call } = useAccountApi();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Record<ModelRole, { connectionId: string; model: string }>>(
    () => draftOf(settings.roles),
  );
  const [message, setMessage] = useState<{ ok: boolean; text: string } | undefined>(undefined);

  // A connection created or deleted elsewhere on the page: forget choices that no longer exist.
  const ids = settings.connections.map((c) => c.id).join(',');
  useEffect(() => {
    setDraft((current) => {
      const next = { ...current };
      for (const role of ROLES) {
        if (!settings.connections.some((c) => c.id === next[role].connectionId)) {
          next[role] = { connectionId: '', model: '' };
        }
      }
      return next;
    });
  }, [ids, settings.connections]);

  const save = useMutation({
    mutationFn: (roles: RoleModels) => call((api) => api.setRoles(roles)),
    onSuccess: (next) => {
      queryClient.setQueryData(keys.settings(token), next);
      setMessage({ ok: true, text: m.settings_saved() });
    },
    onError: (error) => setMessage({ ok: false, text: settingsErrorText(error) }),
  });

  const connectionOf = (id: string) => settings.connections.find((c) => c.id === id);
  const set = (role: ModelRole, patch: Partial<{ connectionId: string; model: string }>) =>
    setDraft((current) => ({ ...current, [role]: { ...current[role], ...patch } }));

  const submit = () => {
    setMessage(undefined);
    const roles: Record<string, { connectionId: string; model: string }> = {};
    for (const role of ROLES) {
      const { connectionId, model } = draft[role];
      if (connectionId === '' && model.trim() === '') continue;
      if (connectionId === '' || model.trim() === '') {
        return setMessage({ ok: false, text: m.roles_incomplete({ role: roleLabel(role) }) });
      }
      roles[role] = { connectionId, model: model.trim() };
    }
    save.mutate(roles as RoleModels);
  };

  const copyToAll = () =>
    setDraft((current) => ({
      prober: current.prober,
      teacher: current.prober,
      sideChat: current.prober,
    }));

  return (
    <VStack gap={3}>
      <Heading level={3}>{m.roles_title()}</Heading>
      <Text type="supporting">{m.roles_hint()}</Text>
      {settings.connections.length === 0 ? (
        <Text type="supporting">{m.roles_need_connection()}</Text>
      ) : (
        <>
          {ROLES.map((role) => {
            const connection = connectionOf(draft[role].connectionId);
            const acpModels =
              connection?.provider === 'acp' && connection.agent !== undefined
                ? (settings.acpModels[connection.agent] ?? [])
                : undefined;
            return (
              <VStack key={role} gap={2} data-testid={`role-${role}`}>
                <Heading level={4}>{roleLabel(role)}</Heading>
                <Selector
                  label={m.roles_connection()}
                  placeholder={m.roles_connection_placeholder()}
                  options={settings.connections.map((c) => ({ value: c.id, label: c.label }))}
                  value={draft[role].connectionId}
                  onChange={(connectionId) => set(role, { connectionId, model: '' })}
                  data-testid={`role-${role}-connection`}
                />
                {acpModels === undefined ? (
                  <TextInput
                    label={m.settings_model()}
                    description={m.settings_model_description()}
                    value={draft[role].model}
                    onChange={(model) => set(role, { model })}
                    autoComplete="off"
                    hasSpellCheck={false}
                    data-testid={`role-${role}-model`}
                  />
                ) : acpModels.length === 0 ? (
                  <Banner status="warning" title={m.roles_acp_no_models()} />
                ) : (
                  <Selector
                    label={m.settings_model()}
                    description={m.roles_acp_models_hint()}
                    placeholder={m.roles_model_placeholder()}
                    options={acpModels.map((model) => ({ value: model, label: model }))}
                    value={draft[role].model}
                    onChange={(model) => set(role, { model })}
                    data-testid={`role-${role}-model`}
                  />
                )}
              </VStack>
            );
          })}
          {message === undefined ? null : (
            <Banner
              status={message.ok ? 'success' : 'error'}
              title={message.text}
              data-testid="roles-message"
            />
          )}
          <HStack gap={2} wrap="wrap">
            <Button
              label={m.roles_save()}
              variant="primary"
              isLoading={save.isPending}
              onClick={submit}
              data-testid="roles-save"
            />
            <Button label={m.roles_copy()} onClick={copyToAll} data-testid="roles-copy" />
          </HStack>
        </>
      )}
    </VStack>
  );
}

function draftOf(roles: RoleModels): Record<ModelRole, { connectionId: string; model: string }> {
  const one = (role: ModelRole) => ({
    connectionId: roles[role]?.connectionId ?? '',
    model: roles[role]?.model ?? '',
  });
  return { prober: one('prober'), teacher: one('teacher'), sideChat: one('sideChat') };
}
