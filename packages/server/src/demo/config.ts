// Demo configuration from the environment (plan tai-khoan.md A8). The demo model and its key
// stay in the environment: the admin UI sets only the switch and the budget. Messages name the
// variable, never its value.
import type { DemoBudgetPeriod } from '@kd-learn/api';
import { ConfigError } from '../config.ts';

export type DemoModelConfig =
  | { readonly provider: 'anthropic' | 'gemini'; readonly model: string; readonly apiKey: string }
  | {
      readonly provider: 'openai-compatible';
      readonly endpointId: string;
      readonly model: string;
      readonly apiKey: string;
    };

export interface DemoConfig {
  /** Undefined when no demo model is set: demo mode is then closed. */
  readonly model: DemoModelConfig | undefined;
  /**
   * Image model on the demo provider and key (phase 5 A9): Gemini, or an endpoint with images.
   * Undefined: no demo images, whatever the admin switch says.
   */
  readonly imageModel?: string;
  /** Budget until an admin changes it. 0 (the default) closes demo mode. */
  readonly limit: number;
  readonly period: DemoBudgetPeriod;
}

const periods: ReadonlyArray<DemoBudgetPeriod> = ['day', 'month', 'none'];

/**
 * - `KD_LEARN_DEMO_PROVIDER` (`anthropic`, `gemini`, `openai-compatible`), `KD_LEARN_DEMO_MODEL`,
 *   `KD_LEARN_DEMO_API_KEY`: all three or none. `KD_LEARN_DEMO_ENDPOINT`: the endpoint id, for
 *   `openai-compatible` only.
 * - `KD_LEARN_DEMO_IMAGE_MODEL`: image model on the same provider and key (phase 5 A9). Optional.
 * - `KD_LEARN_DEMO_BUDGET`: model calls per period, default 0 (closed).
 * - `KD_LEARN_DEMO_BUDGET_PERIOD`: `day` (default), `month` or `none`. Periods are in UTC.
 */
export const loadDemoConfig = (env: Readonly<Record<string, string | undefined>>): DemoConfig => {
  const provider = env.KD_LEARN_DEMO_PROVIDER?.trim() ?? '';
  const model = env.KD_LEARN_DEMO_MODEL?.trim() ?? '';
  const apiKey = env.KD_LEARN_DEMO_API_KEY?.trim() ?? '';
  const endpointId = env.KD_LEARN_DEMO_ENDPOINT?.trim() ?? '';
  const set = [provider, model, apiKey].filter((v) => v !== '').length;
  if (set !== 0 && set !== 3) {
    throw new ConfigError({
      message:
        'Set all of KD_LEARN_DEMO_PROVIDER, KD_LEARN_DEMO_MODEL and KD_LEARN_DEMO_API_KEY, or none.',
    });
  }
  let demoModel: DemoModelConfig | undefined;
  if (set === 3) {
    if (provider === 'anthropic' || provider === 'gemini') {
      if (endpointId !== '') {
        throw new ConfigError({
          message: 'KD_LEARN_DEMO_ENDPOINT is only for KD_LEARN_DEMO_PROVIDER=openai-compatible.',
        });
      }
      demoModel = { provider, model, apiKey };
    } else if (provider === 'openai-compatible') {
      if (endpointId === '') {
        throw new ConfigError({ message: 'Set KD_LEARN_DEMO_ENDPOINT to an endpoint id.' });
      }
      demoModel = { provider, endpointId, model, apiKey };
    } else {
      throw new ConfigError({
        message: 'KD_LEARN_DEMO_PROVIDER must be anthropic, gemini or openai-compatible.',
      });
    }
  }

  const rawLimit = env.KD_LEARN_DEMO_BUDGET?.trim() ?? '';
  const limit = rawLimit === '' ? 0 : Number(rawLimit);
  if (!/^\d+$/.test(rawLimit === '' ? '0' : rawLimit) || !Number.isSafeInteger(limit)) {
    throw new ConfigError({ message: 'KD_LEARN_DEMO_BUDGET must be a whole number of calls.' });
  }
  const period = (env.KD_LEARN_DEMO_BUDGET_PERIOD?.trim() || 'day') as DemoBudgetPeriod;
  if (!periods.includes(period)) {
    throw new ConfigError({ message: 'KD_LEARN_DEMO_BUDGET_PERIOD must be day, month or none.' });
  }
  const imageModel = env.KD_LEARN_DEMO_IMAGE_MODEL?.trim() ?? '';
  if (imageModel !== '' && demoModel === undefined) {
    throw new ConfigError({ message: 'KD_LEARN_DEMO_IMAGE_MODEL needs the demo model set.' });
  }
  if (imageModel !== '' && demoModel?.provider === 'anthropic') {
    throw new ConfigError({
      message: 'KD_LEARN_DEMO_IMAGE_MODEL needs gemini or openai-compatible.',
    });
  }
  return { model: demoModel, limit, period, ...(imageModel === '' ? {} : { imageModel }) };
};
