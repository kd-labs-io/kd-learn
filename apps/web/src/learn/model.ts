import type { ImageModelChoice, ModelChoice } from '@kd-learn/api';
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

/** The guest's image model a main turn carries (phase 5 A6), or undefined while it is incomplete. */
export function imageChoiceOf(settings: GuestSettings | undefined): ImageModelChoice | undefined {
  const image = settings?.image;
  if (image === undefined || !image.apiKey || !image.model) return undefined;
  const { provider, model, apiKey } = image;
  if (provider === 'openai-compatible') {
    return image.endpointId ? { provider, endpointId: image.endpointId, model, apiKey } : undefined;
  }
  return { provider, model, apiKey };
}
