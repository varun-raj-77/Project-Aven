/**
 * AVEN-011 action proposals: package identity and fixed v1 parameters.
 *
 * The creation stamp below is written into every proposal this package
 * constructs and selects the digest protocol when a stored proposal is read
 * back: the frozen AVEN-002 `DigestSchema` has no protocol field, so the
 * protocol version travels inside the digested payload. Limits protect the
 * process while caller data is copied; they are not proposal semantics.
 */
export const AVEN_011_ACTION_PROPOSALS_VERSION = 'aven-011-action-proposals-v1';
export const ACTION_PROPOSAL_DIGEST_PROTOCOL =
  'AVEN-011-ACTION-PROPOSAL-DIGEST-V1';
export const ACTION_PROPOSAL_CREATION_COMPONENT = '@aven/action-proposals';

/** Recursively freezes acyclic plain data (objects and arrays) and returns it. */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Reflect.ownKeys(value)) {
      deepFreeze((value as Record<PropertyKey, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

export const ACTION_PROPOSALS_CONFIG = deepFreeze({
  version: AVEN_011_ACTION_PROPOSALS_VERSION,
  /** Written into `metadata.creation` of every constructed proposal. */
  creation: {
    component: ACTION_PROPOSAL_CREATION_COMPONENT,
    version: AVEN_011_ACTION_PROPOSALS_VERSION,
  },
  digest: {
    protocol: ACTION_PROPOSAL_DIGEST_PROTOCOL,
    algorithm: 'sha256',
  },
  /** The frozen milestone this package is built on; it changes none of it. */
  frozenBaseline: {
    tag: 'aven-010',
    commit: '76535d8647ee36e56bd2efd1a86642d1fc572ee7',
  },
  /** The only frozen AVEN-002 contract schema version this package reads. */
  contractSchemaVersion: 1,
  /** Resource bounds on caller data, checked while it is copied. */
  limits: {
    maxDepth: 16,
    maxNodes: 2048,
    maxArrayLength: 256,
    maxStringLength: 20000,
  },
} as const);
export type ActionProposalsConfiguration = typeof ACTION_PROPOSALS_CONFIG;
