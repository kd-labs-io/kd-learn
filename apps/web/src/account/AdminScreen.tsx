// Admin screen (plan tai-khoan.md A7-A9): the three switches, the demo budget, ACP agents and
// their allowed models (risk 30), users (disable, unlock) and invite codes. The server enforces
// every switch; this screen only sets them.
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Heading } from '@astryxdesign/core/Heading';
import { HStack } from '@astryxdesign/core/HStack';
import { Item } from '@astryxdesign/core/Item';
import { Layout, LayoutContent } from '@astryxdesign/core/Layout';
import { NumberInput } from '@astryxdesign/core/NumberInput';
import { Selector } from '@astryxdesign/core/Selector';
import { Switch } from '@astryxdesign/core/Switch';
import { Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';
import { VStack } from '@astryxdesign/core/VStack';
import type {
  AcpAgent,
  AdminConfig,
  AdminUser,
  DemoBudgetPeriod,
  RegistrationMode,
  UpdateAdminConfigRequest,
  UpdateAdminSearchRequest,
} from '@kd-learn/api';
import { m } from '@kd-learn/i18n';
import { LoadingSkeleton } from '@kd-learn/ui/components/LoadingSkeleton';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { AppHeader } from '../app/AppHeader';
import { formatDate } from '../app/format';
import { agentLabel } from './AccountSettings';
import { errorText, keys, useAccountApi } from './api';
import { pageWidth } from '../app/page';
import { Block } from '../app/Block';

const AGENTS: ReadonlyArray<AcpAgent> = ['claude-code', 'opencode', 'antigravity'];

export function AdminScreen({ token, selfId }: { token: string; selfId: string }) {
  const { call } = useAccountApi();
  const queryClient = useQueryClient();
  const config = useQuery({
    queryKey: keys.adminConfig(token),
    queryFn: () => call((api) => api.adminConfig()),
  });
  const update = useMutation({
    mutationFn: (change: UpdateAdminConfigRequest) => call((api) => api.updateAdminConfig(change)),
    onSuccess: async (next) => {
      queryClient.setQueryData(keys.adminConfig(token), next);
      // The public config (entry points, header) follows the switches.
      await queryClient.invalidateQueries({ queryKey: keys.config });
    },
  });
  const change = (patch: UpdateAdminConfigRequest) =>
    update.mutateAsync(patch).then(() => undefined);

  return (
    <Layout
      contentWidth={pageWidth}
      header={<AppHeader />}
      content={
        <LayoutContent padding={6}>
          <VStack gap={6} maxWidth="68ch" data-testid="admin">
            <Heading level={2}>{m.admin_title()}</Heading>
            {config.isPending ? <LoadingSkeleton label={m.loading()} /> : null}
            {config.isError ? (
              <Banner
                status="error"
                title={m.account_load_failed({ reason: errorText(config.error) })}
              />
            ) : null}
            {update.isError ? (
              <Banner
                status="error"
                title={m.error_generic({ message: errorText(update.error) })}
              />
            ) : null}
            {config.data === undefined ? null : (
              <>
                <Switches config={config.data} change={change} />
                <Demo config={config.data} change={change} />
                <Acp config={config.data} change={change} />
              </>
            )}
            <Search token={token} />
            <Invites />
            <Users token={token} selfId={selfId} />
          </VStack>
        </LayoutContent>
      }
    />
  );
}

type Change = (patch: UpdateAdminConfigRequest) => Promise<void>;

function Switches({ config, change }: { config: AdminConfig; change: Change }) {
  return (
    <Block gap={3}>
      <Heading level={3}>{m.admin_switches()}</Heading>
      <Selector
        label={m.admin_registration()}
        options={[
          { value: 'open', label: m.admin_registration_open() },
          { value: 'invite', label: m.admin_registration_invite() },
          { value: 'closed', label: m.admin_registration_closed() },
        ]}
        value={config.registration}
        onChange={(value) => void change({ registration: value as RegistrationMode })}
        data-testid="admin-registration"
      />
      <Switch
        label={m.admin_guest_mode()}
        description={m.admin_guest_mode_hint()}
        value={config.guestMode}
        changeAction={(guestMode) => change({ guestMode })}
        data-testid="admin-guest-mode"
      />
      <Switch
        label={m.admin_demo_mode()}
        description={m.admin_demo_mode_hint()}
        value={config.demoMode}
        changeAction={(demoMode) => change({ demoMode })}
        data-testid="admin-demo-mode"
      />
      <Switch
        label={m.admin_figure_cdn()}
        description={m.admin_figure_cdn_hint()}
        value={config.figureCdn}
        changeAction={(figureCdn) => change({ figureCdn })}
        data-testid="admin-figure-cdn"
      />
    </Block>
  );
}

function Demo({ config, change }: { config: AdminConfig; change: Change }) {
  const { demoBudget } = config;
  return (
    <Block gap={3}>
      <Heading level={3}>{m.admin_demo()}</Heading>
      <Text data-testid="admin-demo-used">
        {m.admin_demo_used({ used: demoBudget.used, limit: demoBudget.limit })}
      </Text>
      <Text type="supporting">
        {config.demoModel === undefined
          ? m.admin_demo_no_model()
          : m.admin_demo_model({ model: config.demoModel })}
      </Text>
      {config.demoMode && (demoBudget.limit === 0 || config.demoModel === undefined) ? (
        <Banner status="warning" title={m.admin_demo_closed()} />
      ) : null}
      <NumberInput
        label={m.admin_demo_limit()}
        description={m.admin_demo_limit_hint()}
        value={demoBudget.limit}
        min={0}
        step={10}
        onChange={(limit) => {
          if (Number.isInteger(limit) && limit >= 0) void change({ demoBudgetLimit: limit });
        }}
        data-testid="admin-demo-limit"
      />
      <Selector
        label={m.admin_demo_period()}
        options={[
          { value: 'day', label: m.admin_period_day() },
          { value: 'month', label: m.admin_period_month() },
          { value: 'none', label: m.admin_period_none() },
        ]}
        value={demoBudget.period}
        onChange={(value) => void change({ demoBudgetPeriod: value as DemoBudgetPeriod })}
        data-testid="admin-demo-period"
      />
      <Switch
        label={m.admin_demo_images()}
        description={
          config.demoImageModel === undefined
            ? m.admin_demo_images_no_model()
            : m.admin_demo_images_hint({ model: config.demoImageModel })
        }
        value={config.demoImages}
        changeAction={(demoImages) => change({ demoImages })}
        data-testid="admin-demo-images"
      />
      <NumberInput
        label={m.admin_demo_image_cost()}
        description={m.admin_demo_image_cost_hint()}
        value={config.demoImageCost}
        min={1}
        max={1000}
        onChange={(cost) => {
          if (Number.isInteger(cost) && cost >= 1 && cost <= 1000) {
            void change({ demoImageCost: cost });
          }
        }}
        data-testid="admin-demo-image-cost"
      />
    </Block>
  );
}

function Acp({ config, change }: { config: AdminConfig; change: Change }) {
  const [drafts, setDrafts] = useState<Partial<Record<AcpAgent, string>>>({});
  const toggle = (agent: AcpAgent, on: boolean) =>
    change({
      acpAgents: on
        ? [...config.acpAgents, agent]
        : config.acpAgents.filter((enabled) => enabled !== agent),
    });
  const saveModels = (agent: AcpAgent) => {
    const list = (drafts[agent] ?? (config.acpModels[agent] ?? []).join(', '))
      .split(',')
      .map((model) => model.trim())
      .filter((model) => model !== '');
    void change({ acpModels: { ...config.acpModels, [agent]: list } });
  };
  return (
    <Block gap={3}>
      <Heading level={3}>{m.admin_acp()}</Heading>
      <Text type="supporting">{m.admin_acp_hint()}</Text>
      {!config.acpAvailable && config.acpAgents.length > 0 ? (
        <Banner
          status="warning"
          title={m.admin_acp_unavailable_title()}
          description={m.admin_acp_unavailable_body()}
          data-testid="admin-acp-unavailable"
        />
      ) : null}
      {AGENTS.map((agent) => {
        const on = config.acpAgents.includes(agent);
        return (
          <VStack key={agent} gap={2}>
            <Switch
              label={agentLabel(agent)}
              value={on}
              changeAction={(next) => toggle(agent, next)}
              data-testid={`admin-acp-${agent}`}
            />
            {on ? (
              <HStack gap={2} vAlign="end" wrap="wrap">
                <TextInput
                  label={m.admin_acp_models()}
                  description={m.admin_acp_models_hint()}
                  value={drafts[agent] ?? (config.acpModels[agent] ?? []).join(', ')}
                  onChange={(value) => setDrafts((current) => ({ ...current, [agent]: value }))}
                  autoComplete="off"
                  hasSpellCheck={false}
                  data-testid={`admin-acp-models-${agent}`}
                />
                <Button label={m.settings_save()} onClick={() => saveModels(agent)} />
              </HStack>
            ) : null}
          </VStack>
        );
      })}
      <NumberInput
        label={m.admin_acp_max()}
        value={config.acpMaxConcurrent}
        min={1}
        max={32}
        onChange={(max) => {
          if (Number.isInteger(max) && max >= 1 && max <= 32)
            void change({ acpMaxConcurrent: max });
        }}
        data-testid="admin-acp-max"
      />
    </Block>
  );
}

function Invites() {
  const { call } = useAccountApi();
  const invite = useMutation({ mutationFn: () => call((api) => api.createInvite({})) });
  return (
    <Block gap={3}>
      <Heading level={3}>{m.admin_invites()}</Heading>
      <Text type="supporting">{m.admin_invites_hint()}</Text>
      {invite.data === undefined ? null : (
        <Banner
          status="success"
          title={m.admin_invite_created({ date: formatDate(invite.data.expiresAt) })}
          description={invite.data.code}
          data-testid="admin-invite-code"
        />
      )}
      {invite.isError ? (
        <Banner status="error" title={m.error_generic({ message: errorText(invite.error) })} />
      ) : null}
      <HStack>
        <Button
          label={m.admin_invite_create()}
          isLoading={invite.isPending}
          onClick={() => invite.mutate()}
          data-testid="admin-invite"
        />
      </HStack>
    </Block>
  );
}

function Users({ token, selfId }: { token: string; selfId: string }) {
  const { call } = useAccountApi();
  const queryClient = useQueryClient();
  const users = useQuery({
    queryKey: keys.adminUsers(token),
    queryFn: () => call((api) => api.adminUsers()),
  });
  const update = useMutation({
    mutationFn: ({ id, change }: { id: string; change: { disabled?: boolean; unlock?: true } }) =>
      call((api) => api.updateUser(id, change)),
    onSettled: () => queryClient.invalidateQueries({ queryKey: keys.adminUsers(token) }),
  });
  const describe = (user: AdminUser) =>
    [
      user.role === 'admin' ? m.admin_user_admin() : undefined,
      user.disabled ? m.admin_user_disabled() : undefined,
      user.lockedUntil === undefined
        ? undefined
        : m.admin_user_locked({ date: formatDate(user.lockedUntil) }),
      m.admin_user_created({ date: formatDate(user.createdAt) }),
    ]
      .filter((part) => part !== undefined)
      .join(' · ');
  return (
    <Block gap={3}>
      <Heading level={3}>{m.admin_users()}</Heading>
      {users.isPending ? <LoadingSkeleton variant="list" label={m.loading()} /> : null}
      {update.isError ? (
        <Banner status="error" title={m.error_generic({ message: errorText(update.error) })} />
      ) : null}
      <VStack gap={1} as="ul" data-testid="admin-users">
        {(users.data?.users ?? []).map((user) => (
          <Item
            as="li"
            key={user.id}
            label={user.email}
            description={describe(user)}
            endContent={
              <HStack gap={1}>
                {user.lockedUntil === undefined ? null : (
                  <Button
                    label={m.admin_user_unlock()}
                    size="sm"
                    variant="ghost"
                    onClick={() => update.mutate({ id: user.id, change: { unlock: true } })}
                  />
                )}
                {user.id === selfId ? null : (
                  <Button
                    label={user.disabled ? m.admin_user_enable() : m.admin_user_disable()}
                    size="sm"
                    variant={user.disabled ? 'secondary' : 'destructive'}
                    onClick={() =>
                      update.mutate({ id: user.id, change: { disabled: !user.disabled } })
                    }
                  />
                )}
              </HStack>
            }
            data-testid="admin-user"
          />
        ))}
      </VStack>
    </Block>
  );
}
/** Search sources for research (phase 4 A6): SearXNG, Exa and its key, and guest/demo access. */
function Search({ token }: { token: string }) {
  const { call } = useAccountApi();
  const queryClient = useQueryClient();
  const [key, setKey] = useState('');
  const search = useQuery({
    queryKey: keys.adminSearch(token),
    queryFn: () => call((api) => api.adminSearch()),
  });
  const update = useMutation({
    mutationFn: (change: UpdateAdminSearchRequest) => call((api) => api.updateAdminSearch(change)),
    onSuccess: async (next) => {
      queryClient.setQueryData(keys.adminSearch(token), next);
      // The sources and settings screens offer what the server now allows.
      await queryClient.invalidateQueries({ queryKey: ['search'] });
    },
  });
  const change = (patch: UpdateAdminSearchRequest) =>
    update.mutateAsync(patch).then(() => undefined);
  const data = search.data;
  return (
    <Block gap={3} data-testid="admin-search">
      <Heading level={3}>{m.admin_search()}</Heading>
      {search.isPending ? <LoadingSkeleton variant="list" label={m.loading()} /> : null}
      {update.isError ? (
        <Banner status="error" title={m.error_generic({ message: errorText(update.error) })} />
      ) : null}
      {data === undefined ? null : (
        <>
          <Switch
            label={m.search_searxng()}
            description={data.searxng.configured ? m.admin_searxng_hint() : m.admin_searxng_unset()}
            value={data.searxng.enabled}
            isDisabled={!data.searxng.configured}
            changeAction={(searxngEnabled) => change({ searxngEnabled })}
            data-testid="admin-searxng"
          />
          <Switch
            label={m.search_exa()}
            description={
              data.exa.hasKey
                ? m.admin_exa_key_set({ last4: data.exa.keyLast4 ?? '' })
                : m.admin_exa_no_key()
            }
            value={data.exa.enabled}
            isDisabled={!data.exa.hasKey}
            changeAction={(exaEnabled) => change({ exaEnabled })}
            data-testid="admin-exa"
          />
          <HStack gap={2} vAlign="end" wrap="wrap">
            <TextInput
              label={m.admin_exa_key()}
              type="password"
              value={key}
              onChange={setKey}
              data-testid="admin-exa-key"
            />
            <Button
              label={m.admin_exa_key_save()}
              isDisabled={key.trim().length < 8}
              isLoading={update.isPending}
              onClick={() => void change({ exaKey: key.trim() }).then(() => setKey(''))}
              data-testid="admin-exa-key-save"
            />
            {data.exa.hasKey ? (
              <Button
                label={m.admin_exa_key_remove()}
                variant="ghost"
                onClick={() => void change({ exaKey: null })}
                data-testid="admin-exa-key-remove"
              />
            ) : null}
          </HStack>
          <Selector
            label={m.admin_search_guest()}
            options={[
              { value: 'searxng', label: m.search_searxng() },
              { value: 'off', label: m.admin_search_off() },
            ]}
            value={data.guest}
            onChange={(value) => void change({ guest: value as 'searxng' | 'off' })}
            data-testid="admin-search-guest"
          />
          <Selector
            label={m.admin_search_demo()}
            description={m.admin_search_demo_hint()}
            options={[
              { value: 'searxng', label: m.search_searxng() },
              { value: 'exa', label: m.search_exa() },
              { value: 'off', label: m.admin_search_off() },
            ]}
            value={data.demo}
            onChange={(value) => void change({ demo: value as 'searxng' | 'exa' | 'off' })}
            data-testid="admin-search-demo"
          />
        </>
      )}
    </Block>
  );
}
