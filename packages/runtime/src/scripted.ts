import type { ModelConfiguration } from '@aven/contracts';
import { ModelRuntimeError, type ModelRuntimeErrorCode } from './errors.ts';
import type {
  FinishReason,
  ModelRuntime,
  ModelRuntimeInvocation,
  ModelRuntimeOutput,
  ModelRuntimeRequest,
} from './types.ts';

/**
 * TEST-ONLY deterministic runtime, published at `@aven/runtime/testing` so it
 * is never part of the production entry point. It generates nothing: every
 * output is configured by the test. No clock, randomness, network, credential,
 * storage or provider SDK. Usage is reported only when a step configures it.
 */
export const SCRIPTED_RUNTIME_IDENTIFIER = 'aven-scripted-test-runtime';
export const SCRIPTED_RUNTIME_VERSION = '0.1.0';

export type ScriptedStep =
  /** Return exactly this output. */
  | {
      readonly kind: 'respond';
      readonly text: string;
      readonly finishReason?: FinishReason;
      readonly usage?: NonNullable<ModelRuntimeOutput['usage']>;
    }
  /** Reject with a normalized runtime error. */
  | { readonly kind: 'fail'; readonly code: ModelRuntimeErrorCode }
  /** Throw an arbitrary non-normalized value, as a buggy adapter might. */
  | { readonly kind: 'throw'; readonly error: unknown }
  /** Resolve with an arbitrary value that bypasses the output type. */
  | { readonly kind: 'malformed'; readonly value: unknown }
  /** Never settle unless the invocation signal aborts. */
  | { readonly kind: 'pending' };

export interface ScriptedModelRuntimeOptions {
  readonly runtime?: { readonly identifier: string; readonly version: string };
  readonly model: ModelConfiguration;
  readonly script:
    | readonly ScriptedStep[]
    | ((request: ModelRuntimeRequest, call: number) => ScriptedStep);
}

export interface ScriptedModelRuntime extends ModelRuntime {
  /** The frozen requests received, in call order. */
  readonly requests: readonly ModelRuntimeRequest[];
}

export function createScriptedModelRuntime(
  options: ScriptedModelRuntimeOptions,
): ScriptedModelRuntime {
  const runtime = options.runtime ?? {
    identifier: SCRIPTED_RUNTIME_IDENTIFIER,
    version: SCRIPTED_RUNTIME_VERSION,
  };
  const requests: ModelRuntimeRequest[] = [];
  function next(request: ModelRuntimeRequest): ScriptedStep | undefined {
    const call = requests.length;
    requests.push(request);
    return typeof options.script === 'function'
      ? options.script(request, call)
      : options.script[call];
  }
  async function invoke(
    request: ModelRuntimeRequest,
    { signal }: ModelRuntimeInvocation,
  ): Promise<ModelRuntimeOutput> {
    const step = next(request);
    if (!step)
      throw new ModelRuntimeError(
        'runtime_failure',
        new Error('Scripted runtime has no step for this call'),
      );
    switch (step.kind) {
      case 'respond':
        return {
          text: step.text,
          runtime: { ...runtime },
          model: { ...options.model },
          ...(step.finishReason ? { finishReason: step.finishReason } : {}),
          ...(step.usage ? { usage: { ...step.usage } } : {}),
        };
      case 'fail':
        throw new ModelRuntimeError(step.code);
      case 'throw':
        throw step.error;
      case 'malformed':
        return step.value as ModelRuntimeOutput;
      case 'pending':
        return new Promise<never>((_, reject) => {
          const cancel = () =>
            reject(new ModelRuntimeError('runtime_aborted', signal.reason));
          if (signal.aborted) cancel();
          else signal.addEventListener('abort', cancel, { once: true });
        });
    }
  }
  return Object.freeze({ invoke, requests });
}
