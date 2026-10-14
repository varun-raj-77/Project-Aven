/**
 * AVEN-011 action-proposal failures.
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
 * their errors are always `not_written`. An error carries no authority
 * meaning: it never allows, denies or approves anything.
 *
 * The code set is the one accepted in the AVEN-011 design; codes used only by
 * the recorder and reader belong to later patches and are listed here so the
 * error surface stays fixed.
 */
export type ActionProposalErrorCode =
  | 'invalid_request'
  | 'binding_mismatch'
  | 'unsupported_proposal'
  | 'unsupported_origin'
  | 'operation_not_in_v1_format'
  | 'timestamp_order'
  | 'unknown_binding'
  | 'unresolved_reference'
  | 'identifier_collision'
  | 'ledger_rejected'
  | 'storage_failure'
  | 'invalid_history'
  | 'internal_error';

export type ActionProposalOutcome = 'not_written' | 'rolled_back' | 'unknown';

const messages: Readonly<Record<ActionProposalErrorCode, string>> =
  Object.freeze({
    invalid_request:
      'The action proposal input is malformed or outside the v1 limits',
    binding_mismatch:
      'The action proposal does not belong to the requested owner, session and task',
    unsupported_proposal:
      'The action proposal is not in the AVEN-011 v1 format',
    unsupported_origin:
      'The declared proposal origin is not supported by the AVEN-011 v1 format',
    operation_not_in_v1_format:
      'A requested operation is not in the AVEN-011 v1 recording format',
    timestamp_order: 'The proposal event occurs before the proposal creation',
    unknown_binding: 'The owner, session or task does not exist for this owner',
    unresolved_reference:
      'A cited evidence or approval reference does not exist for this owner',
    identifier_collision:
      'An event or proposal identifier is already in use for this owner',
    ledger_rejected: 'The Experience Ledger rejected the proposal event',
    storage_failure: 'Storage failed while handling the action proposal',
    invalid_history:
      'The recorded proposal history is malformed or inconsistent',
    internal_error:
      'The action proposals package failed an internal consistency check',
  });

export const ACTION_PROPOSAL_ERROR_CODES: readonly ActionProposalErrorCode[] =
  Object.freeze(Object.keys(messages) as ActionProposalErrorCode[]);
export const ACTION_PROPOSAL_OUTCOMES: readonly ActionProposalOutcome[] =
  Object.freeze(['not_written', 'rolled_back', 'unknown'] as const);

export interface SerializedActionProposalError {
  readonly name: 'ActionProposalError';
  readonly code: ActionProposalErrorCode;
  readonly outcome: ActionProposalOutcome;
  readonly message: string;
}

/** Classifies untyped input by strict equality, without coercion or lookup. */
function normalizeCode(value: unknown): ActionProposalErrorCode {
  for (const code of ACTION_PROPOSAL_ERROR_CODES)
    if (value === code) return code;
  return 'internal_error';
}

/** An unrecognized outcome is never reported as a confirmed non-write. */
function normalizeOutcome(value: unknown): ActionProposalOutcome {
  for (const outcome of ACTION_PROPOSAL_OUTCOMES)
    if (value === outcome) return outcome;
  return 'unknown';
}

export class ActionProposalError extends Error {
  declare readonly name: 'ActionProposalError';
  readonly code: ActionProposalErrorCode;
  readonly outcome: ActionProposalOutcome;
  constructor(
    code: ActionProposalErrorCode,
    outcome: ActionProposalOutcome = 'not_written',
  ) {
    const safe = normalizeCode(code);
    super(messages[safe]);
    // A null-prototype descriptor: an inherited `get`, `set`, `writable` or
    // `configurable` on Object.prototype cannot change how `name` is defined.
    const name = Object.create(null) as PropertyDescriptor;
    name.value = 'ActionProposalError';
    name.enumerable = false;
    name.writable = false;
    name.configurable = false;
    Object.defineProperty(this, 'name', name);
    this.code = safe;
    this.outcome = normalizeOutcome(outcome);
    Object.freeze(this);
  }

  /** A frozen null-prototype object with keys in a fixed order. */
  toJSON(): SerializedActionProposalError {
    const json = Object.create(null) as {
      name: 'ActionProposalError';
      code: ActionProposalErrorCode;
      outcome: ActionProposalOutcome;
      message: string;
    };
    json.name = this.name;
    json.code = this.code;
    json.outcome = this.outcome;
    json.message = this.message;
    return Object.freeze(json);
  }
}
