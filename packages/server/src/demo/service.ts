// Whether a demo turn may run, and with which model (plan tai-khoan.md A8).
import type { ImageModelRef, ModelRef } from '@kd-learn/ai/port';
import type { Endpoint } from '../config.ts';
import type { DemoBudgetService } from './budget.ts';
import type { DemoModelConfig } from './config.ts';

/** Demo images (phase 5 A9): the model on the server's key, and the calls one image costs. */
export interface DemoImages {
  readonly model: ImageModelRef;
  readonly cost: number;
}

export type DemoGate =
  | {
      readonly _tag: 'Ready';
      readonly model: ModelRef;
      readonly budget: DemoBudgetService;
      /** Absent: no images in demo turns. */
      readonly images?: DemoImages;
    }
  | { readonly _tag: 'Disabled' };

/** The demo image model, on the demo provider and key; undefined when it cannot make images. */
export const resolveDemoImageModel = (
  model: DemoModelConfig | undefined,
  imageModel: string | undefined,
  endpoints: ReadonlyArray<Endpoint>,
): ImageModelRef | undefined => {
  if (model === undefined || imageModel === undefined) return undefined;
  if (model.provider === 'gemini') {
    return { provider: 'gemini', model: imageModel, apiKey: model.apiKey };
  }
  if (model.provider !== 'openai-compatible') return undefined;
  const endpoint = endpoints.find((e) => e.id === model.endpointId && e.images);
  return endpoint === undefined
    ? undefined
    : {
        provider: 'openai-compatible',
        model: imageModel,
        apiKey: model.apiKey,
        baseURL: endpoint.baseURL,
      };
};

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
  images?: DemoImages,
): DemoGate =>
  switchOn && model !== undefined && budget.status().limit > 0
    ? { _tag: 'Ready', model, budget, ...(images === undefined ? {} : { images }) }
    : { _tag: 'Disabled' };
