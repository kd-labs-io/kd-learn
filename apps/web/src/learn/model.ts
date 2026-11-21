import type { ModelChoice } from '@kd-learn/api';
import type { GuestSettings } from '@kd-learn/storage/port';

/** The model choice a request carries, or undefined while the settings lack a key, model or endpoint. */
export function modelChoiceOf(settings: GuestSettings | undefined): ModelChoice | undefined {
  if (settings === undefined || !settings.apiKey || !settings.model) return undefined;
  const { provider, model, apiKey } = settings;
  if (provider === 'openai-compatible') {
    return settings.endpointId
      ? { provider, endpointId: settings.endpointId, model, apiKey }
      : undefined;
  }
  return { provider, model, apiKey };
}
