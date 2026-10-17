/**
 * AVEN-012 Root policy failures.
 *
 * The public `code` and `message` are fixed per code and the `outcome` is one
 * of three fixed values; the constructor accepts only those, so no
 * caller-controlled text, identifier, proposal content, SQL message,
 * validation issue or thrown value can cross this boundary. There is never a
 * `cause`. An unknown code (possible from untyped JavaScript) is reported as
 * `internal_error`, and an unknown outcome as `unknown`. The instance is
 * frozen, and `toJSON` serializes exactly `name`, `code`, `outcome` and
 * `message`, in that order.
 *
 * `outcome` says what is known about storage: `not_written` (nothing was
 * written by this call), `rolled_back` (the Ledger reported a completed
 * rollback) or `unknown`. The pure functions of this package never write, so
 * their errors are always `not_written`.
 *
 * Every error fails closed: an error is never an ALLOW, never a recorded
 * decision and never a permission. Codes used only by the Ledger subpath
 * belong to a later patch and are listed here so the error surface is fixed.
 */
export type RootPolicyErrorCode =
  | 'invalid_request'
  | 'invalid_policy'
  | 'untrusted_policy'
  | 'untrusted_capability'
  | 'invalid_proposal'
  | 'binding_mismatch'
  | 'unknown_binding'
  | 'unresolved_reference'
  | 'identifier_collision'
  | 'untrusted_evaluation'
  | 'stale_evaluation'
  | 'ledger_rejected'
  | 'storage_failure'
  | 'invalid_history'
  | 'internal_error';

export type RootPolicyOutcome = 'not_written' | 'rolled_back' | 'unknown';

const messages: Readonly<Record<RootPolicyErrorCode, string>> = Object.freeze({
  invalid_request:
    'The Root policy request is malformed or outside the v1 limits',
  invalid_policy:
    'The Root policy definition is malformed or violates a Root invariant',
  untrusted_policy:
    'The policy was not created by this Root policy package; nothing was evaluated',
  untrusted_capability:
    'A Root capability was not created by this Root policy package',
  invalid_proposal:
    'The action proposal is not a valid AVEN-011 v1 proposal; nothing was evaluated',
  binding_mismatch:
    'The action proposal does not belong to the requested owner, session and task, or its declared binding differs',
  unknown_binding:
    'The owner, proposal event, session or task does not exist for this owner',
  unresolved_reference:
    'A reference the decision event needs does not exist for this owner',
  identifier_collision:
    'A decision or event identifier is already in use for this owner',
  untrusted_evaluation:
    'The evaluation was not produced by this Root gateway; nothing was recorded',
  stale_evaluation:
    'The evaluation is outside the Root recording window; nothing was recorded',
  ledger_rejected: 'The Experience Ledger rejected the policy decision event',
  storage_failure: 'Storage failed while handling the Root policy request',
  invalid_history:
    'The recorded proposal or approval history is malformed or inconsistent',
  internal_error:
    'The Root policy package failed an internal consistency check',
});

export const ROOT_POLICY_ERROR_CODES: readonly RootPolicyErrorCode[] =
  Object.freeze(Object.keys(messages) as RootPolicyErrorCode[]);
export const ROOT_POLICY_OUTCOMES: readonly RootPolicyOutcome[] = Object.freeze(
  ['not_written', 'rolled_back', 'unknown'] as const,
);

export interface SerializedRootPolicyError {
  readonly name: 'RootPolicyError';
  readonly code: RootPolicyErrorCode;
  readonly outcome: RootPolicyOutcome;
  readonly message: string;
}

/** Classifies untyped input by strict equality, without coercion or lookup. */
function normalizeCode(value: unknown): RootPolicyErrorCode {
  for (const code of ROOT_POLICY_ERROR_CODES) if (value === code) return code;
  return 'internal_error';
}

/** An unrecognized outcome is never reported as a confirmed non-write. */
function normalizeOutcome(value: unknown): RootPolicyOutcome {
  for (const outcome of ROOT_POLICY_OUTCOMES)
    if (value === outcome) return outcome;
  return 'unknown';
}

export class RootPolicyError extends Error {
  declare readonly name: 'RootPolicyError';
  readonly code: RootPolicyErrorCode;
  readonly outcome: RootPolicyOutcome;
  constructor(
    code: RootPolicyErrorCode,
    outcome: RootPolicyOutcome = 'not_written',
  ) {
    const safe = normalizeCode(code);
    super(messages[safe]);
    // A null-prototype descriptor: an inherited `get`, `set`, `writable` or
    // `configurable` on Object.prototype cannot change how `name` is defined.
    const name = Object.create(null) as PropertyDescriptor;
    name.value = 'RootPolicyError';
    name.enumerable = false;
    name.writable = false;
    name.configurable = false;
    Object.defineProperty(this, 'name', name);
    this.code = safe;
    this.outcome = normalizeOutcome(outcome);
    Object.freeze(this);
  }

  /** A frozen null-prototype object with keys in a fixed order. */
  toJSON(): SerializedRootPolicyError {
    const json = Object.create(null) as {
      name: 'RootPolicyError';
      code: RootPolicyErrorCode;
      outcome: RootPolicyOutcome;
      message: string;
    };
    json.name = this.name;
    json.code = this.code;
    json.outcome = this.outcome;
    json.message = this.message;
    return Object.freeze(json);
  }
}

/** Throws a fixed, `not_written` error. */
export const fail = (code: RootPolicyErrorCode): never => {
  throw new RootPolicyError(code);
};

/** Rethrows a `RootPolicyError`; anything else becomes `internal_error`. */
export function rethrow(error: unknown): never {
  if (error instanceof RootPolicyError) throw error;
  throw new RootPolicyError('internal_error');
}
