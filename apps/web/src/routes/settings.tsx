import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Heading } from '@astryxdesign/core/Heading';
import { HStack } from '@astryxdesign/core/HStack';
import { Layout, LayoutContent } from '@astryxdesign/core/Layout';
import { Selector } from '@astryxdesign/core/Selector';
import { Spinner } from '@astryxdesign/core/Spinner';
import { TextInput } from '@astryxdesign/core/TextInput';
import { VStack } from '@astryxdesign/core/VStack';
import { m } from '@kd-learn/i18n';
import type { GuestProvider, GuestSettings } from '@kd-learn/storage/port';
import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { AppHeader } from '../app/AppHeader';
import { useEndpoints, useStoragePersistent } from '../learn/hooks';
import { runStorage, useGuestSettings } from '../storage';

export const Route = createFileRoute('/settings')({ component: Settings });

const DEFAULT_MODEL: Partial<Record<GuestProvider, string>> = { anthropic: 'claude-haiku-5-5' };

function Settings() {
  const stored = useGuestSettings();
  const endpoints = useEndpoints();
  const persistent = useStoragePersistent();

  const [provider, setProvider] = useState<GuestProvider>('anthropic');
  const [endpointId, setEndpointId] = useState('');
  const [model, setModel] = useState(DEFAULT_MODEL['anthropic'] ?? '');
  const [apiKey, setApiKey] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [message, setMessage] = useState<{ status: 'success' | 'error'; text: string } | undefined>(
    undefined,
  );

  // Fill the form once, from what is saved. Later changes (another tab) do not overwrite typing.
  useEffect(() => {
    if (loaded || stored.status !== 'ready') return;
    setLoaded(true);
    if (stored.data === undefined) return;
    setProvider(stored.data.provider);
    setModel(stored.data.model);
    setEndpointId(stored.data.endpointId ?? '');
  }, [loaded, stored]);

  const savedKey = stored.status === 'ready' ? stored.data?.apiKey : undefined;
  const offered = endpoints.status === 'ready' ? endpoints.endpoints : [];
  // Hide the OpenAI-compatible choice when the server offers no endpoint (and none is selected).
  const providerOptions = [
    { value: 'anthropic', label: m.provider_anthropic() },
    { value: 'gemini', label: m.provider_gemini() },
    ...(offered.length > 0 || provider === 'openai-compatible'
      ? [{ value: 'openai-compatible', label: m.provider_openai_compatible() }]
      : []),
  ];
  const endpointGone =
    provider === 'openai-compatible' &&
    endpoints.status === 'ready' &&
    !offered.some((endpoint) => endpoint.id === endpointId);

  const save = async () => {
    const key = apiKey.trim() || savedKey;
    const name = model.trim();
    if (!key || name === '' || (provider === 'openai-compatible' && endpointId === '')) {
      setMessage({ status: 'error', text: m.settings_missing() });
      return;
    }
    const next: GuestSettings = {
      provider,
      model: name,
      apiKey: key,
      ...(provider === 'openai-compatible' ? { endpointId } : {}),
    };
    try {
      await runStorage((storage) => storage.saveSettings(next));
      setApiKey('');
      setMessage({ status: 'success', text: m.settings_saved() });
    } catch (cause) {
      setMessage({
        status: 'error',
        text: m.storage_error({ reason: cause instanceof Error ? cause.message : String(cause) }),
      });
    }
  };

  const deleteKey = async () => {
    try {
      await runStorage((storage) => storage.deleteApiKey);
      setApiKey('');
      setMessage({ status: 'success', text: m.settings_key_deleted() });
    } catch (cause) {
      setMessage({
        status: 'error',
        text: m.storage_error({ reason: cause instanceof Error ? cause.message : String(cause) }),
      });
    }
  };

  return (
    <Layout
      header={<AppHeader />}
      content={
        <LayoutContent padding={6}>
          <VStack gap={5} maxWidth="56ch">
            <Heading level={2}>{m.settings_title()}</Heading>

            {persistent === false ? (
              <Banner
                status="warning"
                title={m.storage_not_persistent_title()}
                description={m.storage_not_persistent_body()}
                data-testid="not-persistent"
              />
            ) : null}

            {stored.status === 'loading' ? <Spinner size="sm" label={m.learn_loading()} /> : null}
            {stored.status === 'error' ? (
              <Banner status="error" title={m.storage_error({ reason: stored.error.message })} />
            ) : null}

            <Selector
              label={m.settings_provider()}
              options={providerOptions}
              value={provider}
              onChange={(value) => {
                const next = value as GuestProvider;
                setProvider(next);
                // A model name belongs to a provider: offer the default one when the field is untouched.
                if (model === '' || model === DEFAULT_MODEL[provider]) {
                  setModel(DEFAULT_MODEL[next] ?? '');
                }
              }}
              data-testid="provider"
            />

            {provider === 'openai-compatible' ? (
              <Selector
                label={m.settings_endpoint()}
                placeholder={m.settings_endpoint_placeholder()}
                options={offered.map((endpoint) => ({ value: endpoint.id, label: endpoint.label }))}
                value={endpointGone ? '' : endpointId}
                onChange={setEndpointId}
                {...(endpointGone
                  ? { status: { type: 'error' as const, message: m.settings_endpoint_gone() } }
                  : endpoints.status === 'error'
                    ? { status: { type: 'error' as const, message: m.settings_endpoints_failed() } }
                    : {})}
                data-testid="endpoint"
              />
            ) : null}

            <TextInput
              label={m.settings_model()}
              description={m.settings_model_description()}
              value={model}
              onChange={setModel}
              autoComplete="off"
              hasSpellCheck={false}
              data-testid="model"
            />

            <TextInput
              label={m.settings_key()}
              description={
                savedKey === undefined ? m.settings_key_description() : m.settings_key_saved_hint()
              }
              type="password"
              value={apiKey}
              onChange={setApiKey}
              autoComplete="off"
              data-testid="api-key"
            />

            {message === undefined ? null : (
              <Banner status={message.status} title={message.text} data-testid="settings-message" />
            )}

            <HStack gap={2}>
              <Button
                label={m.settings_save()}
                variant="primary"
                onClick={() => void save()}
                data-testid="save-settings"
              />
              {savedKey === undefined ? null : (
                <Button
                  label={m.settings_delete_key()}
                  variant="destructive"
                  onClick={() => void deleteKey()}
                  data-testid="delete-key"
                />
              )}
            </HStack>
          </VStack>
        </LayoutContent>
      }
    />
  );
}
