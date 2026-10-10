/**
 * AVEN-010 correction failures (patch 2 scaffold).
 *
 * The public `code` and `message` are fixed per code; the constructor accepts
 * only a code, so no caller-controlled text, owner, session, task, event or
 * evidence identifier, correction text, SQL message, validation issue or
 * thrown value can cross this boundary. There is never a `cause`. An unknown
 * code (possible from untyped JavaScript) is reported as `internal_error`. The
 * instance is frozen, and `toJSON` serializes exactly `name`, `code` and
 * `message`, in that order. An error carries no authority meaning: it never
 * allows, denies or approves anything.
 *
 * Every message is owner-local: "does not exist for this owner" is the same
 * whether an identifier is missing or belongs to someone else. The code set
 * is the one accepted in the AVEN-010 design; later patches use these codes
 * and add none before their own behavior needs one. Patch 4 (the pure
 * immediate-override resolver) adds `invalid_correction_history`, which never
 * says which record, owner, sequence or field was wrong.
 */
export type CorrectionErrorCode =
  | 'invalid_submission'
  | 'unknown_binding'
  | 'unresolved_target'
  | 'identifier_collision'
  | 'storage_failure'
  | 'invalid_correction_history'
  | 'internal_error';

const messages: Readonly<Record<CorrectionErrorCode, string>> = Object.freeze({
  invalid_submission:
    'The correction submission is malformed; nothing was recorded',
  unknown_binding:
    'The correction session or task does not exist for this owner; nothing was recorded',
  unresolved_target:
    'The correction target does not resolve for this owner; nothing was recorded',
  identifier_collision:
    'A correction identifier is already in use for this owner; nothing was recorded',
  storage_failure:
    'Correction storage failed; no correction receipt was issued',
  invalid_correction_history:
    'The correction history or query is malformed or inconsistent; no correction view was built',
  internal_error:
    'The corrections package failed an internal consistency check; no correction receipt was issued',
});

export const CORRECTION_ERROR_CODES: readonly CorrectionErrorCode[] =
  Object.freeze(Object.keys(messages) as CorrectionErrorCode[]);

export interface SerializedCorrectionError {
  readonly name: 'CorrectionError';
  readonly code: CorrectionErrorCode;
  readonly message: string;
}

/** Classifies untyped input by strict equality, without coercion or lookup. */
function normalizeCorrectionErrorCode(value: unknown): CorrectionErrorCode {
  switch (value) {
    case 'invalid_submission':
      return 'invalid_submission';
    case 'unknown_binding':
      return 'unknown_binding';
    case 'unresolved_target':
      return 'unresolved_target';
    case 'identifier_collision':
      return 'identifier_collision';
    case 'storage_failure':
      return 'storage_failure';
    case 'invalid_correction_history':
      return 'invalid_correction_history';
    default:
      return 'internal_error';
  }
}

export class CorrectionError extends Error {
  declare readonly name: 'CorrectionError';
  readonly code: CorrectionErrorCode;
  constructor(code: CorrectionErrorCode) {
    const safe = normalizeCorrectionErrorCode(code);
    super(messages[safe]);
    // A null-prototype descriptor: an inherited `get`, `set`, `writable` or
    // `configurable` on Object.prototype cannot change how `name` is defined.
    const name = Object.create(null) as PropertyDescriptor;
    name.value = 'CorrectionError';
    name.enumerable = false;
    name.writable = false;
    name.configurable = false;
    Object.defineProperty(this, 'name', name);
    this.code = safe;
    Object.freeze(this);
  }

  /**
   * A frozen null-prototype object with keys in a fixed order, so
   * serializing it can never reach an inherited `toJSON` or accessor on
   * Object.prototype.
   */
  toJSON(): SerializedCorrectionError {
    const json = Object.create(null) as {
      name: 'CorrectionError';
      code: CorrectionErrorCode;
      message: string;
    };
    json.name = this.name;
    json.code = this.code;
    json.message = this.message;
    return Object.freeze(json);
  }
}
