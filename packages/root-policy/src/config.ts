/**
 * AVEN-012 Root policy: package identity and fixed v1 parameters.
 *
 * The creation stamp below is written into every policy decision this
 * package builds. The proposal protocol is AVEN-011's digest protocol v1,
 * which Root re-implements and re-checks independently: Root never depends on
 * the proposing package (`@aven/action-proposals`) and never trusts a binding
 * it did not recompute. Limits protect the process while untrusted data is
 * copied; they are not policy semantics.
 */
export const AVEN_012_ROOT_POLICY_VERSION = 'aven-012-root-policy-v1';
export const ROOT_POLICY_COMPONENT = '@aven/root-policy';
/** Domain tag of the policy digest written into every decision's issuer. */
export const ROOT_POLICY_DIGEST_PROTOCOL = 'AVEN-012-ROOT-POLICY-DIGEST-V1';
/** Format tag every Root policy definition must declare. */
export const ROOT_POLICY_DEFINITION_FORMAT =
  'aven-012-root-policy-definition-v1';
/** The AVEN-011 proposal digest protocol v1, recomputed by Root. */
export const PROPOSAL_DIGEST_PROTOCOL = 'AVEN-011-ACTION-PROPOSAL-DIGEST-V1';

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

export const ROOT_POLICY_CONFIG = deepFreeze({
  version: AVEN_012_ROOT_POLICY_VERSION,
  /** Written into `metadata.creation` of every decision Root builds. */
  creation: {
    component: ROOT_POLICY_COMPONENT,
    version: AVEN_012_ROOT_POLICY_VERSION,
  },
  policyDigest: {
    protocol: ROOT_POLICY_DIGEST_PROTOCOL,
    algorithm: 'sha256',
  },
  /** The only proposal format Root evaluates: AVEN-011 protocol v1. */
  proposal: {
    protocol: PROPOSAL_DIGEST_PROTOCOL,
    algorithm: 'sha256',
    stamp: {
      component: '@aven/action-proposals',
      version: 'aven-011-action-proposals-v1',
    },
    recordVersion: 1,
  },
  /** The frozen milestone this package is built on; it changes none of it. */
  frozenBaseline: {
    tag: 'aven-011',
    commit: '44ba416d90624be67fde2fab31c716e8298648bb',
  },
  /** The only frozen AVEN-002 contract schema version this package reads. */
  contractSchemaVersion: 1,
  limits: {
    /** Exactly the AVEN-011 v1 proposal limits. */
    proposal: {
      maxDepth: 16,
      maxNodes: 2048,
      maxArrayLength: 256,
      maxStringLength: 20000,
    },
    /** One evaluation request: a proposal plus bounded approval records. */
    request: {
      maxDepth: 18,
      maxNodes: 65536,
      maxArrayLength: 256,
      maxStringLength: 20000,
    },
    /** A Root policy definition (Root configuration, still copied inertly). */
    policy: {
      maxDepth: 8,
      maxNodes: 65536,
      maxArrayLength: 1024,
      maxStringLength: 512,
    },
    /** Approval records Root considers for one proposal, all versions. */
    maxApprovalRecords: 64,
    /** Upper bound of a policy's approval age limit: 30 days. */
    maxApprovalAgeSeconds: 2592000,
  },
} as const);
export type RootPolicyConfiguration = typeof ROOT_POLICY_CONFIG;
