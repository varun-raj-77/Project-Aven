// Synthetic model/runtime identities and text only. No real provider or credential.
import type { ModelConfiguration } from '@aven/contracts';
import type { ModelRuntimeRequest } from '../src/index.ts';

export const MODEL_A: ModelConfiguration = {
  providerId: 'synthetic-provider-a',
  modelId: 'synthetic-model-a',
  modelVersion: '2026-10-01',
  configurationId: 'synthetic-config-a',
};
export const MODEL_B: ModelConfiguration = {
  providerId: 'synthetic-provider-b',
  modelId: 'synthetic-model-b',
  modelVersion: '7',
  configurationId: 'synthetic-config-b',
};
export const RUNTIME_A = {
  identifier: 'synthetic-runtime-a',
  version: '1.0.0',
};
export const RUNTIME_B = {
  identifier: 'synthetic-runtime-b',
  version: '3.2.1',
};

export const REQUEST: ModelRuntimeRequest = {
  messages: [
    { role: 'system', content: 'Synthetic system instruction.' },
    { role: 'user', content: 'Synthetic question?' },
  ],
};

/** Resolves after pending microtasks and timers have had a chance to run. */
export const tick = (ms = 0) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
