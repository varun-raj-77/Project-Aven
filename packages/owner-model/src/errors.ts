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
 * when their own behavior needs them. Patch 2 (owner-state intake) adds the
 * three identity codes, Patch 3 (durable lineage) adds two lineage codes and
 * Patch 4 (lifecycle claims) adds one claim code; none carries a position,
 * ID, version, category, path, count, event, transition kind or owner.
 */
export type OwnerModelErrorCode =
  | 'invalid_input'
  | 'internal_error'
  | 'conflicting_duplicate'
  | 'identity_conflict'
  | 'version_order_conflict'
  | 'invalid_lineage_reference'
  | 'lineage_cycle'
  | 'invalid_lifecycle_claim';

const messages: Readonly<Record<OwnerModelErrorCode, string>> = Object.freeze({
  invalid_input: 'The owner-model input is malformed; no owner state was read',
  internal_error:
    'The owner model failed an internal consistency check; no owner state was read',
  conflicting_duplicate:
    'Owner-state records share an identity and version but disagree; no owner state was read',
  identity_conflict:
    'An owner-state identity changes record kind or category across versions; no owner state was read',
  version_order_conflict:
    'An owner-state creation time moves backwards as its version increases; no owner state was read',
  invalid_lineage_reference:
    'An owner-state lineage reference does not resolve to a version of the same category; no lineage was built',
  lineage_cycle:
    'Owner-state lineage references form a cycle; no lineage was built',
  invalid_lifecycle_claim:
    'Owner-state lifecycle claims do not agree with recorded transitions; no verified owner model was built',
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
  if (value === 'conflicting_duplicate') return 'conflicting_duplicate';
  if (value === 'identity_conflict') return 'identity_conflict';
  if (value === 'version_order_conflict') return 'version_order_conflict';
  if (value === 'invalid_lineage_reference') return 'invalid_lineage_reference';
  if (value === 'lineage_cycle') return 'lineage_cycle';
  if (value === 'invalid_lifecycle_claim') return 'invalid_lifecycle_claim';
  return 'internal_error';
}

export class OwnerModelError extends Error {
  declare readonly name: 'OwnerModelError';
  readonly code: OwnerModelErrorCode;
  constructor(code: OwnerModelErrorCode) {
    const safe = normalizeOwnerModelErrorCode(code);
    super(messages[safe]);
    // A null-prototype descriptor: an inherited `get`, `set`, `writable` or
    // `configurable` on Object.prototype cannot change how `name` is defined.
    const name = Object.create(null) as PropertyDescriptor;
    name.value = 'OwnerModelError';
    name.enumerable = false;
    name.writable = false;
    name.configurable = false;
    Object.defineProperty(this, 'name', name);
    this.code = safe;
    Object.freeze(this);
  }

  /**
   * A frozen null-prototype object, so serializing it can never reach an
   * inherited `toJSON` or accessor on Object.prototype.
   */
  toJSON(): SerializedOwnerModelError {
    const json = Object.create(null) as {
      name: 'OwnerModelError';
      code: OwnerModelErrorCode;
      message: string;
    };
    json.name = this.name;
    json.code = this.code;
    json.message = this.message;
    return Object.freeze(json);
  }
}
