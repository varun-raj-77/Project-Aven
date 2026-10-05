import { z } from 'zod';
import { isModelRuntimeErrorCode, ModelRuntimeError } from './errors.ts';
import {
  ModelRuntimeOutputSchema,
  ModelRuntimeRequestSchema,
  type ModelRuntime,
  type ModelRuntimeResult,
} from './types.ts';

export interface InvokeOptions {
  /** Standard cancellation. An abort before a result is accepted yields `runtime_aborted`. */
  readonly signal?: AbortSignal | undefined;
  /**
   * Optional wall-clock limit in milliseconds; exceeding it yields
   * `runtime_timeout`. Enforced by a timer (interrupts pending asynchronous
   * work) and a monotonic deadline checked before any outcome is accepted.
   * Synchronous work inside an implementation cannot be preempted in-process,
   * but any outcome it produces after the deadline is rejected.
   */
  readonly timeoutMs?: number | undefined;
}

const MAX_TIMEOUT_MS = 2_147_483_647; // Largest delay Node timers accept.
export const InvokeOptionsSchema = z.strictObject({
  signal: z.instanceof(AbortSignal).optional(),
  timeoutMs: z.number().int().positive().max(MAX_TIMEOUT_MS).optional(),
});

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const entry of Object.values(value)) deepFreeze(entry);
  }
  return value;
}

/**
 * The single normalizing entry point for every runtime implementation.
 *
 * 1. Validates options and the provider-neutral request before invoking
 *    anything (`invalid_request`). The implementation receives a frozen copy.
 * 2. Invokes the implementation with an AbortSignal that fires on caller abort
 *    or timeout. Once stopped, a late result or rejection is discarded.
 *    `timeoutMs` is also a monotonic deadline: an outcome observed after it
 *    (e.g. after event-loop-blocking synchronous work that delayed the timer)
 *    is `runtime_timeout`, never a completed result.
 * 3. Maps anything the implementation throws to a normalized error. Foreign
 *    errors, and `ModelRuntimeError`s whose `code` is not one of the six
 *    allowed values at runtime, become `runtime_failure` with a fixed message.
 * 4. Validates the output strictly (`malformed_runtime_result`) and returns a
 *    frozen result. Provider-specific fields never pass through.
 *
 * No retry, failover, routing, persistence or exactly-once guarantee.
 */
export async function invokeModelRuntime(
  runtime: ModelRuntime,
  request: unknown,
  options: InvokeOptions = {},
): Promise<ModelRuntimeResult> {
  const settings = InvokeOptionsSchema.safeParse(options);
  if (!settings.success)
    throw new ModelRuntimeError('invalid_request', settings.error);
  const parsed = ModelRuntimeRequestSchema.safeParse(request);
  if (!parsed.success)
    throw new ModelRuntimeError('invalid_request', parsed.error);
  if (
    runtime === null ||
    typeof runtime !== 'object' ||
    typeof runtime.invoke !== 'function'
  )
    throw new ModelRuntimeError('runtime_unavailable');
  const { signal, timeoutMs } = settings.data;
  if (signal?.aborted)
    throw new ModelRuntimeError('runtime_aborted', signal.reason);

  const controller = new AbortController();
  let stopped: ModelRuntimeError | undefined;
  let rejectStop: (error: ModelRuntimeError) => void = () => undefined;
  const stop = new Promise<never>((_, reject) => {
    rejectStop = reject;
  });
  stop.catch(() => undefined);
  const halt = (error: ModelRuntimeError) => {
    if (stopped) return;
    stopped = error;
    controller.abort(error);
    rejectStop(error);
  };
  const onAbort = () =>
    halt(new ModelRuntimeError('runtime_aborted', signal?.reason));
  signal?.addEventListener('abort', onAbort, { once: true });
  // Monotonic clock: unaffected by wall-clock adjustments.
  const deadline =
    timeoutMs === undefined ? undefined : performance.now() + timeoutMs;
  const expire = () => {
    if (deadline !== undefined && performance.now() >= deadline)
      halt(new ModelRuntimeError('runtime_timeout'));
  };
  const timer =
    timeoutMs === undefined
      ? undefined
      : setTimeout(
          () => halt(new ModelRuntimeError('runtime_timeout')),
          timeoutMs,
        );
  try {
    const input = deepFreeze(parsed.data);
    const invocation = Object.freeze({ signal: controller.signal });
    let output: unknown;
    try {
      const pending = Promise.resolve().then(() =>
        runtime.invoke(input, invocation),
      );
      pending.catch(() => undefined); // Discard a late rejection after a stop.
      output = await Promise.race([pending, stop]);
    } catch (error) {
      expire();
      if (stopped) throw stopped;
      // `code` is typed, not runtime-checked: revalidate it before propagating.
      const code =
        error instanceof ModelRuntimeError &&
        isModelRuntimeErrorCode(error.code)
          ? error.code
          : 'runtime_failure';
      throw new ModelRuntimeError(code, error);
    }
    // An abort or expired deadline observed before acceptance wins over a
    // result that raced it.
    expire();
    if (stopped) throw stopped;
    const result = ModelRuntimeOutputSchema.safeParse(output);
    if (!result.success)
      throw new ModelRuntimeError('malformed_runtime_result', result.error);
    expire(); // Validation is synchronous work too; re-check before acceptance.
    if (stopped) throw stopped;
    return deepFreeze({ status: 'completed' as const, ...result.data });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}
