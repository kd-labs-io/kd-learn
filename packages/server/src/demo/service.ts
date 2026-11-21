// Whether a demo turn may run, and with which model (plan tai-khoan.md A8).
import type { ModelRef } from '@kd-learn/ai/port';
import type { Endpoint } from '../config.ts';
import type { DemoBudgetService } from './budget.ts';
import type { DemoModelConfig } from './config.ts';

export type DemoGate =
  | { readonly _tag: 'Ready'; readonly model: ModelRef; readonly budget: DemoBudgetService }
  | { readonly _tag: 'Disabled' };

export const resolveDemoModel = (
  model: DemoModelConfig | undefined,
  endpoints: ReadonlyArray<Endpoint>,
): ModelRef | undefined => {
  if (model === undefined) return undefined;
  if (model.provider !== 'openai-compatible') return model;
  const endpoint = endpoints.find((e) => e.id === model.endpointId);
  return endpoint === undefined
    ? undefined
    : {
        provider: 'openai-compatible',
        model: model.model,
        apiKey: model.apiKey,
        baseURL: endpoint.baseURL,
      };
};

/** Demo runs when the switch is on, the budget limit is above 0, and the model resolves. */
export const demoGate = (
  switchOn: boolean,
  model: ModelRef | undefined,
  budget: DemoBudgetService,
): DemoGate =>
  switchOn && model !== undefined && budget.status().limit > 0
    ? { _tag: 'Ready', model, budget }
    : { _tag: 'Disabled' };
