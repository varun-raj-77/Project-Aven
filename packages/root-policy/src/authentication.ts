import { OwnerApprovalSchema, type OwnerApproval } from '@aven/contracts';
import { canonicalText, taggedSha256 } from './canonical.ts';
import { ROOT_POLICY_CONFIG, deepFreeze } from './config.ts';
import { fail, rethrow } from './errors.ts';
import { inertCopy } from './inert.ts';

/**
 * Approval authentication for Root (AVEN-012).
 *
 * A stored `owner_approval` record proves only that something with storage
 * access recorded it: its owner provenance is declared, never authenticated
 * (the AVEN-005 owner channel is unauthenticated). AVEN-012 has NO real owner
 * authentication. Root therefore relies on an approval only when a
 * Root-held authentication capability vouches for it, and the only such
 * capability in this milestone is a SYNTHETIC TEST CAPABILITY: an in-memory
 * channel that test code uses to stand in for a future authenticated owner
 * interface. It authenticates nobody. A policy that uses it says so in its
 * digested definition (`approvalAuthentication: 'synthetic_test_only'`), and
 * every decision that relies on it carries the reason code
 * `approval_authenticated_by_synthetic_test_capability`.
 *
 * Capabilities are recognised by identity (a module-private registry), never
 * by shape, so a structurally identical object, a JSON configuration or
 * proposal content cannot become one. This is an in-process prototype:
 * module privacy is not OS-level isolation, and any code in this process can
 * create its own synthetic channel.
 */
export interface ApprovalAuthenticator {
  readonly kind: 'synthetic_test_only';
  readonly notice: 'Synthetic test capability: not owner authentication';
}

/** The synthetic channel: the authenticator plus its test-only attest hook. */
export interface SyntheticApprovalChannel {
  readonly authenticator: ApprovalAuthenticator;
  /**
   * Marks one approval as authenticated by this synthetic channel. Test code
   * calls it where a real owner interface would authenticate the owner.
   */
  readonly attest: (approval: unknown) => void;
}

const ATTESTATION_TAG = 'AVEN-012-SYNTHETIC-APPROVAL-ATTESTATION-V1';
const ATTESTED = new WeakMap<object, Set<string>>();

/**
 * The fields that identify what an approval approves. Revocation and the
 * per-version evidence and provenance are judged separately by Root.
 */
function identityOf(approval: OwnerApproval): string {
  const text = canonicalText({
    id: approval.id,
    ownerId: approval.ownerId,
    proposal: approval.proposal,
    bounds: approval.bounds,
    issuedAt: approval.issuedAt,
    expiresAt: approval.expiresAt,
  });
  if (text === undefined) return fail('internal_error');
  return taggedSha256(ATTESTATION_TAG, text);
}

function parseApproval(value: unknown): OwnerApproval {
  const inert = inertCopy(value, ROOT_POLICY_CONFIG.limits.request);
  const parsed = OwnerApprovalSchema.safeParse(inert?.copy);
  return parsed.success ? parsed.data : fail('invalid_request');
}

/** Creates a new synthetic channel with an empty attestation set. */
export function createSyntheticApprovalChannel(): SyntheticApprovalChannel {
  const authenticator: ApprovalAuthenticator = deepFreeze({
    kind: 'synthetic_test_only' as const,
    notice: 'Synthetic test capability: not owner authentication' as const,
  });
  const attested = new Set<string>();
  ATTESTED.set(authenticator, attested);
  const attest = (approval: unknown): void => {
    try {
      attested.add(identityOf(parseApproval(approval)));
    } catch (error) {
      rethrow(error);
    }
  };
  return Object.freeze({ authenticator, attest });
}

/** Whether the value is an authenticator this module created. */
export function isApprovalAuthenticator(
  value: unknown,
): value is ApprovalAuthenticator {
  return typeof value === 'object' && value !== null && ATTESTED.has(value);
}

/** Whether this authenticator vouches for the approval's identity. */
export function isAuthenticated(
  authenticator: ApprovalAuthenticator,
  approval: OwnerApproval,
): boolean {
  const attested = ATTESTED.get(authenticator);
  return attested !== undefined && attested.has(identityOf(approval));
}
