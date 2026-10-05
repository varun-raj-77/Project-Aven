/**
 * Normalized, provider-neutral runtime failure categories.
 *
 * The public `message` is fixed per code so provider response bodies, headers,
 * credentials or stack traces never cross this boundary through it. The
 * original failure, if any, is kept only in `cause` for in-process diagnosis;
 * callers must never serialize `cause` into a public response or the Ledger.
 */
export type ModelRuntimeErrorCode =
  | 'invalid_request'
  | 'runtime_unavailable'
  | 'runtime_timeout'
  | 'runtime_aborted'
  | 'runtime_failure'
  | 'malformed_runtime_result';

const messages: Record<ModelRuntimeErrorCode, string> = {
  invalid_request:
    'The model runtime request is malformed; no runtime was invoked',
  runtime_unavailable: 'The model runtime is unavailable',
  runtime_timeout: 'The model runtime did not finish within the time limit',
  runtime_aborted: 'The model runtime invocation was cancelled',
  runtime_failure: 'The model runtime failed',
  malformed_runtime_result:
    'The model runtime returned a result that does not match the runtime contract',
};

export const MODEL_RUNTIME_ERROR_CODES = Object.freeze(
  Object.keys(messages) as ModelRuntimeErrorCode[],
);

export function isModelRuntimeErrorCode(
  value: unknown,
): value is ModelRuntimeErrorCode {
  return typeof value === 'string' && Object.hasOwn(messages, value);
}

export class ModelRuntimeError extends Error {
  readonly code: ModelRuntimeErrorCode;
  constructor(code: ModelRuntimeErrorCode, cause?: unknown) {
    // The type union is compile-time only; an invalid runtime value (e.g. from
    // JavaScript) becomes `runtime_failure` and never appears in the error.
    const safe = isModelRuntimeErrorCode(code) ? code : 'runtime_failure';
    super(messages[safe], { cause });
    this.name = 'ModelRuntimeError';
    this.code = safe;
  }
}
