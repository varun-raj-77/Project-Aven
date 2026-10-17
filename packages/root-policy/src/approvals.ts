import type {
  ActionProposal,
  EvidenceReference,
  OwnerApproval,
  ProposalBinding,
} from '@aven/contracts';
import { isAuthenticated } from './authentication.ts';
import { canonicallyEqual } from './canonical.ts';
import { deepFreeze } from './config.ts';
import { fail } from './errors.ts';
import type { PolicyInternals } from './policy.ts';
import {
  compareInstants,
  instantOf,
  shiftSeconds,
  type Instant,
} from './timestamps.ts';

/**
 * Root's verification of owner approval records (AVEN-012), pure.
 *
 * Approval records are untrusted inputs: Root receives every stored version
 * of every approval it found for a proposal (Patch 3 reads them owner-scoped
 * from storage) and checks each approval, as a whole, against the proposal
 * Root just revalidated, never against what the proposal cites. An approval
 * is `verified` only when ALL of these hold:
 *  - every version names this owner, exactly this proposal binding (id,
 *    version, proposal digest and parameters digest) and exactly this task;
 *  - its versions agree on what they approve and when (id, owner, binding,
 *    bounds, issuance and expiry), and no version is revoked;
 *  - issued no earlier than the proposal was created, not after Root's
 *    evaluation time, not expired at it, and not older than the policy's
 *    maximum approval age;
 *  - a Root-held authentication capability vouches for it. Without one
 *    (`approvalAuthentication: 'unavailable'`) no approval is ever verified.
 * Every failed check is reported as a fixed reason; nothing is repaired.
 */
export type ApprovalReason =
  | 'approval_owner_mismatch'
  | 'approval_binding_mismatch'
  | 'approval_scope_mismatch'
  | 'approval_versions_conflict'
  | 'approval_revoked'
  | 'approval_predates_proposal'
  | 'approval_not_yet_valid'
  | 'approval_expired'
  | 'approval_stale'
  | 'approval_authentication_unavailable'
  | 'approval_not_authenticated';

/** Every reason, in the fixed order findings report them. */
export const APPROVAL_REASONS: readonly ApprovalReason[] = Object.freeze([
  'approval_owner_mismatch',
  'approval_binding_mismatch',
  'approval_scope_mismatch',
  'approval_versions_conflict',
  'approval_revoked',
  'approval_predates_proposal',
  'approval_not_yet_valid',
  'approval_expired',
  'approval_stale',
  'approval_authentication_unavailable',
  'approval_not_authenticated',
] as const);

export interface ApprovalFinding {
  readonly approvalId: string;
  readonly versions: readonly number[];
  readonly status: 'verified' | 'rejected';
  readonly reasons: readonly ApprovalReason[];
  /** The evidence of the lowest version (its recording event). */
  readonly evidence: Readonly<EvidenceReference>;
}

/** What two versions of one approval must agree on. */
const stable = (a: OwnerApproval) => ({
  id: a.id,
  ownerId: a.ownerId,
  proposal: a.proposal,
  bounds: a.bounds,
  issuedAt: a.issuedAt,
  expiresAt: a.expiresAt,
});

function at(timestamp: string): Instant {
  return instantOf(timestamp) ?? fail('internal_error');
}

/**
 * Verifies parsed approval records against a revalidated proposal at Root's
 * evaluation instant. Records are grouped by approval identifier; identical
 * duplicate records count once, conflicting ones reject the approval.
 * Findings are sorted by approval identifier.
 */
export function verifyApprovals(
  records: readonly OwnerApproval[],
  subject: {
    readonly proposal: Readonly<ActionProposal>;
    readonly binding: Readonly<ProposalBinding>;
    readonly evaluatedAt: Instant;
    readonly policy: PolicyInternals;
  },
): readonly ApprovalFinding[] {
  const groups = new Map<string, OwnerApproval[]>();
  for (const record of records) {
    const group = groups.get(record.id) ?? [];
    group.push(record);
    groups.set(record.id, group);
  }
  const created = at(subject.proposal.metadata.createdAt);
  const maxAge = subject.policy.definition.approvalMaxAgeSeconds;
  const findings: ApprovalFinding[] = [];
  for (const id of [...groups.keys()].sort()) {
    const versions = groups
      .get(id)!
      .slice()
      .sort((a, b) => a.metadata.recordVersion - b.metadata.recordVersion);
    const first = versions[0]!;
    const reasons = new Set<ApprovalReason>();
    for (const version of versions) {
      if (version.ownerId !== subject.proposal.ownerId)
        reasons.add('approval_owner_mismatch');
      if (!canonicallyEqual(version.proposal, subject.binding))
        reasons.add('approval_binding_mismatch');
      if (!canonicallyEqual(version.bounds, subject.proposal.task))
        reasons.add('approval_scope_mismatch');
      if (!canonicallyEqual(stable(version), stable(first)))
        reasons.add('approval_versions_conflict');
      if (version.lifecycle.status !== 'issued')
        reasons.add('approval_revoked');
    }
    for (let i = 1; i < versions.length; i += 1)
      if (
        versions[i]!.metadata.recordVersion ===
          versions[i - 1]!.metadata.recordVersion &&
        !canonicallyEqual(versions[i], versions[i - 1])
      )
        reasons.add('approval_versions_conflict');
    const issued = at(first.issuedAt);
    if (compareInstants(issued, created) < 0)
      reasons.add('approval_predates_proposal');
    if (compareInstants(issued, subject.evaluatedAt) > 0)
      reasons.add('approval_not_yet_valid');
    if (compareInstants(subject.evaluatedAt, at(first.expiresAt)) >= 0)
      reasons.add('approval_expired');
    if (compareInstants(shiftSeconds(issued, maxAge), subject.evaluatedAt) < 0)
      reasons.add('approval_stale');
    const authenticator = subject.policy.authenticator;
    if (authenticator === null)
      reasons.add('approval_authentication_unavailable');
    else if (!isAuthenticated(authenticator, first))
      reasons.add('approval_not_authenticated');
    const ordered = APPROVAL_REASONS.filter((reason) => reasons.has(reason));
    findings.push({
      approvalId: id,
      versions: [
        ...new Set(versions.map((version) => version.metadata.recordVersion)),
      ],
      status: ordered.length === 0 ? 'verified' : 'rejected',
      reasons: ordered,
      evidence: {
        evidenceId: first.evidence.evidenceId,
        eventId: first.evidence.eventId,
      },
    });
  }
  return deepFreeze(findings);
}
