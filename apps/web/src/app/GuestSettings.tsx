import { Banner } from '@astryxdesign/core/Banner';
import { LoadingSkeleton } from '@kd-learn/ui/components/LoadingSkeleton';
import { Button } from '@astryxdesign/core/Button';
import { Heading } from '@astryxdesign/core/Heading';
import { HStack } from '@astryxdesign/core/HStack';
import { Layout, LayoutContent } from '@astryxdesign/core/Layout';
import { Selector } from '@astryxdesign/core/Selector';
import { Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';
import { VStack } from '@astryxdesign/core/VStack';
import { m } from '@kd-learn/i18n';
import type { EndpointInfo } from '@kd-learn/api';
import type { GuestImageSettings, GuestProvider, GuestSettings } from '@kd-learn/storage/port';
import { useEffect, useState } from 'react';
import { useGuestSourceLibrary } from '../sources/library';
import { SearchPreference } from '../sources/SearchPreference';
import { ProfileLink } from '../profile/ProfileLink';
import { AppearanceSettings } from '../theme/AppearanceSettings';
import { useEndpoints, useStoragePersistent } from '../learn/hooks';
import { runStorage, useGuestSettings } from '../storage';
import { pageWidth } from './page';
import { Block } from './Block';

const DEFAULT_MODEL: Partial<Record<GuestProvider, string>> = { anthropic: 'claude-haiku-5-5' };

/** Guest settings: provider, model and key, kept on this device only. */
export function GuestSettings() {
  const library = useGuestSourceLibrary('guest');
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
      // The image model is saved on its own; keep it.
      ...(stored.status === 'ready' && stored.data?.image ? { image: stored.data.image } : {}),
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
      contentWidth={pageWidth}
      content={
        <LayoutContent padding={6}>
          <VStack gap={6} maxWidth="720px">
            <Heading level={2}>{m.settings_title()}</Heading>

            {persistent === false ? (
              <Banner
                status="warning"
                title={m.storage_not_persistent_title()}
                description={m.storage_not_persistent_body()}
                data-testid="not-persistent"
              />
            ) : null}

            {stored.status === 'loading' ? <LoadingSkeleton label={m.loading()} /> : null}
            {stored.status === 'error' ? (
              <Banner status="error" title={m.storage_error({ reason: stored.error.message })} />
            ) : null}

            <Block gap={4}>
              <Heading level={3}>{m.settings_model()}</Heading>
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
                  options={offered.map((endpoint) => ({
                    value: endpoint.id,
                    label: endpoint.label,
                  }))}
                  value={endpointGone ? '' : endpointId}
                  onChange={setEndpointId}
                  {...(endpointGone
                    ? { status: { type: 'error' as const, message: m.settings_endpoint_gone() } }
                    : endpoints.status === 'error'
                      ? {
                          status: {
                            type: 'error' as const,
                            message: m.settings_endpoints_failed(),
                          },
                        }
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
                  savedKey === undefined
                    ? m.settings_key_description()
                    : m.settings_key_saved_hint()
                }
                type="password"
                value={apiKey}
                onChange={setApiKey}
                autoComplete="off"
                data-testid="api-key"
              />

              {message === undefined ? null : (
                <Banner
                  status={message.status}
                  title={message.text}
                  data-testid="settings-message"
                />
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
            </Block>

            <ImageSettings
              stored={stored.status === 'ready' ? stored.data : undefined}
              endpoints={offered}
            />

            <Block gap={3}>
              <Heading level={3}>{m.settings_learning()}</Heading>
              <SearchPreference providers={library.providers} />
              <ProfileLink />
            </Block>
            <AppearanceSettings isSynced={false} />
          </VStack>
        </LayoutContent>
      }
    />
  );
}

type ImageProvider = GuestImageSettings['provider'];

/**
 * The image model (phase 5 A6): Gemini or an endpoint that makes images, with a key of its own.
 * Saved apart from the text model; without it the Teacher makes no images.
 */
function ImageSettings({
  stored,
  endpoints,
}: {
  stored: GuestSettings | undefined;
  endpoints: ReadonlyArray<EndpointInfo>;
}) {
  const saved = stored?.image;
  const [provider, setProvider] = useState<ImageProvider | ''>(saved?.provider ?? '');
  const [endpointId, setEndpointId] = useState(saved?.endpointId ?? '');
  const [model, setModel] = useState(saved?.model ?? '');
  const [apiKey, setApiKey] = useState('');
  const [message, setMessage] = useState<{ status: 'success' | 'error'; text: string } | undefined>(
    undefined,
  );
  const [filled, setFilled] = useState(saved !== undefined);
  useEffect(() => {
    if (filled || saved === undefined) return;
    setFilled(true);
    setProvider(saved.provider);
    setEndpointId(saved.endpointId ?? '');
    setModel(saved.model);
  }, [filled, saved]);

  const imageEndpoints = endpoints.filter((endpoint) => endpoint.images === true);
  const providerOptions = [
    { value: 'gemini', label: m.provider_gemini() },
    ...(imageEndpoints.length > 0 || provider === 'openai-compatible'
      ? [{ value: 'openai-compatible', label: m.provider_openai_compatible() }]
      : []),
  ];

  const write = async (next: GuestSettings, text: string) => {
    try {
      await runStorage((storage) => storage.saveSettings(next));
      setApiKey('');
      setMessage({ status: 'success', text });
    } catch (cause) {
      setMessage({
        status: 'error',
        text: m.storage_error({ reason: cause instanceof Error ? cause.message : String(cause) }),
      });
    }
  };

  const save = async () => {
    if (stored === undefined)
      return setMessage({ status: 'error', text: m.image_settings_text_first() });
    const key = apiKey.trim() || saved?.apiKey;
    const name = model.trim();
    if (
      provider === '' ||
      !key ||
      name === '' ||
      (provider === 'openai-compatible' && endpointId === '')
    ) {
      return setMessage({ status: 'error', text: m.settings_missing() });
    }
    await write(
      {
        ...stored,
        image: {
          provider,
          model: name,
          apiKey: key,
          ...(provider === 'openai-compatible' ? { endpointId } : {}),
        },
      },
      m.settings_saved(),
    );
  };

  const remove = async () => {
    if (stored === undefined) return;
    const { image: _image, ...rest } = stored;
    setProvider('');
    setModel('');
    setEndpointId('');
    await write(rest, m.image_settings_removed());
  };

  const deleteKey = async () => {
    try {
      await runStorage((storage) => storage.deleteImageApiKey);
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
    <Block gap={3} data-testid="image-settings">
      <Heading level={3}>{m.image_settings_title()}</Heading>
      <Text type="supporting">{m.image_settings_hint()}</Text>
      <Selector
        label={m.settings_provider()}
        placeholder={m.image_settings_none()}
        options={providerOptions}
        value={provider}
        onChange={(value) => setProvider(value as ImageProvider)}
        data-testid="image-provider"
      />
      {provider === 'openai-compatible' ? (
        <Selector
          label={m.settings_endpoint()}
          placeholder={m.settings_endpoint_placeholder()}
          options={imageEndpoints.map((endpoint) => ({
            value: endpoint.id,
            label: endpoint.label,
          }))}
          value={endpointId}
          onChange={setEndpointId}
          data-testid="image-endpoint"
        />
      ) : null}
      {provider === '' ? null : (
        <>
          <TextInput
            label={m.settings_model()}
            description={m.settings_model_description()}
            value={model}
            onChange={setModel}
            autoComplete="off"
            hasSpellCheck={false}
            data-testid="image-model"
          />
          <TextInput
            label={m.image_settings_key()}
            description={
              saved?.apiKey === undefined
                ? m.settings_key_description()
                : m.settings_key_saved_hint()
            }
            type="password"
            value={apiKey}
            onChange={setApiKey}
            autoComplete="off"
            data-testid="image-api-key"
          />
        </>
      )}
      {message === undefined ? null : (
        <Banner status={message.status} title={message.text} data-testid="image-settings-message" />
      )}
      <HStack gap={2} wrap="wrap">
        <Button
          label={m.image_settings_save()}
          onClick={() => void save()}
          isDisabled={provider === ''}
          data-testid="image-save"
        />
        {saved?.apiKey === undefined ? null : (
          <Button
            label={m.settings_delete_key()}
            variant="destructive"
            onClick={() => void deleteKey()}
            data-testid="image-delete-key"
          />
        )}
        {saved === undefined ? null : (
          <Button
            label={m.image_settings_remove()}
            onClick={() => void remove()}
            data-testid="image-remove"
          />
        )}
      </HStack>
    </Block>
  );
}
