/**
 * Owner Model failures (patch 1 scaffold).
 *
 * The public `code` and `message` are fixed per code; the constructor accepts
 * only a code, so no caller-controlled text, owner data, validation detail or
 * thrown value can cross this boundary. There is never a `cause`. An unknown
 * code (possible from untyped JavaScript) is reported as `internal_error`. The
 * instance is frozen, and `toJSON` serializes exactly `name`, `code` and
 * `message`. An error carries no authority meaning: it never allows, denies or
 * approves anything.
 *
 * The code set is deliberately minimal. Later AVEN-009 patches add codes only
 * when their own behavior needs them.
 */
export type OwnerModelErrorCode = 'invalid_input' | 'internal_error';

const messages: Readonly<Record<OwnerModelErrorCode, string>> = Object.freeze({
  invalid_input: 'The owner-model input is malformed; no owner state was read',
  internal_error:
    'The owner model failed an internal consistency check; no owner state was read',
});

export const OWNER_MODEL_ERROR_CODES: readonly OwnerModelErrorCode[] =
  Object.freeze(Object.keys(messages) as OwnerModelErrorCode[]);

export interface SerializedOwnerModelError {
  readonly name: 'OwnerModelError';
  readonly code: OwnerModelErrorCode;
  readonly message: string;
}

/** Classifies untyped input without coercion or retaining caller objects. */
function normalizeOwnerModelErrorCode(value: unknown): OwnerModelErrorCode {
  if (value === 'invalid_input') return 'invalid_input';
  return 'internal_error';
}

export class OwnerModelError extends Error {
  declare readonly name: 'OwnerModelError';
  readonly code: OwnerModelErrorCode;
  constructor(code: OwnerModelErrorCode) {
    const safe = normalizeOwnerModelErrorCode(code);
    super(messages[safe]);
    Object.defineProperty(this, 'name', {
      value: 'OwnerModelError',
      enumerable: false,
    });
    this.code = safe;
    Object.freeze(this);
  }

  toJSON(): SerializedOwnerModelError {
    return { name: this.name, code: this.code, message: this.message };
  }
}
