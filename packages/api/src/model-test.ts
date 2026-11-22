// `POST /api/models/test`: checks that a guest's model and key answer, with one tiny model call.
// Same rules as `/api/turns` for the key (risk 19) and the endpoint (risk 6: no `baseURL`).
import { Schema } from 'effect';
import { ModelChoice } from './contract.ts';

export const MODEL_TEST_PATH = '/api/models/test';

/** The guest's text model to try. `demo` is refused: the demo has no key to check. */
export const ModelTestRequest = Schema.Struct({ model: ModelChoice });
export type ModelTestRequest = typeof ModelTestRequest.Type;

/** The model answered. A failure comes back as `ErrorBody` with a non-2xx status. */
export const ModelTestResponse = Schema.Struct({ ok: Schema.Literal(true) });
export type ModelTestResponse = typeof ModelTestResponse.Type;
