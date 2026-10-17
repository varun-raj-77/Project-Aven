import { z } from 'zod';
import {
  OwnerApprovalSchema,
  OwnerIdSchema,
  PolicyDecisionIdSchema,
  PolicyDecisionSchema,
  SessionIdSchema,
  TaskIdSchema,
  TimestampSchema,
  type EvidenceReference,
  type OwnerApproval,
  type PolicyDecision,
  type ProposalBinding,
} from '@aven/contracts';
import { verifyApprovals, type ApprovalFinding } from './approvals.ts';
import { canonicallyEqual, wellFormedThroughout } from './canonical.ts';
import {
  AVEN_012_ROOT_POLICY_VERSION,
  ROOT_POLICY_COMPONENT,
  ROOT_POLICY_CONFIG,
  deepFreeze,
} from './config.ts';
import { fail, rethrow } from './errors.ts';
import { inertCopy } from './inert.ts';
import {
  pairKey,
  policyInternals,
  type PolicyInternals,
  type RootPolicyGrant,
  type RootRisk,
} from './policy.ts';
import { changesLearnedState, revalidateProposal } from './proposal.ts';
import { compareInstants, instantOf, type Instant } from './timestamps.ts';

/**
 * Root's deterministic policy evaluation (AVEN-012), pure.
 *
 * Aven proposes; Root decides. Given a registered Root policy and an
 * evaluation input, Root revalidates the proposal, recomputes its binding,
 * classifies the action with its OWN catalog and risk table, and returns a
 * frozen AVEN-002 `PolicyDecision` (ALLOW, DENY or REQUIRE_OWNER_APPROVAL)
 * plus an explanation. Nothing here reads a clock, storage or the network,
 * generates identifiers, calls a model, executes a tool, records anything or
 * learns. The decision is not recorded and authorizes no execution by
 * itself; recording is a separate step (the Ledger subpath), and a future
 * executor must recheck the real parameter bytes against the bound digest.
 *
 * Trusted inputs are the policy (Root configuration, registered by identity)
 * and, from the Root host, the evaluation time. Everything else is untrusted:
 * the proposal (its requested authority, declared risk and reversibility,
 * cited approvals and texts), the caller-allocated decision identifier and
 * the approval records, each of which must pass `verifyApprovals`.
 *
 * Decision rules, in order (the first that applies decides):
 *  1. proposal created after the evaluation time: DENY;
 *  2. (tool, action) not in the policy catalog: DENY;
 *  3. target kind differs from the catalogued effect, or requested
 *     authority is not exactly that one effect on that target: DENY;
 *  4. the effect would change learned owner state: DENY (defense in depth;
 *     revalidation and the policy invariants already exclude it);
 *  5. the effect is unclassified or `forbidden` by the risk table: DENY;
 *  6. effective risk = Root's classification, raised (never lowered) by
 *     the declared risk (`unknown` counts as high) and by a declared
 *     reversibility worse than the catalog's (at least medium);
 *  7. high risk under `highRisk: 'deny'`: DENY;
 *  8. low risk and a matching, valid Root grant: ALLOW (`existing_grant`);
 *  9. any verified owner approval: ALLOW (`owner_approval`);
 * 10. otherwise: REQUIRE_OWNER_APPROVAL.
 */
export type RootReasonCode =
  | 'cited_approvals_not_authority'
  | 'proposal_created_after_evaluation'
  | 'action_not_in_policy'
  | 'target_kind_mismatch'
  | 'requested_authority_mismatch'
  | 'learned_state_change_forbidden'
  | 'risk_unclassified'
  | 'operation_forbidden'
  | 'root_risk_low'
  | 'root_risk_medium'
  | 'root_risk_high'
  | 'declared_risk_not_authority'
  | 'declared_risk_escalated'
  | 'declared_reversibility_escalated'
  | 'parameters_bound_by_digest_only'
  | 'approvals_rejected'
  | 'high_risk_denied_by_policy'
  | 'grant_verified'
  | 'no_applicable_grant'
  | 'grants_limited_to_low_risk'
  | 'owner_approval_verified'
  | 'approval_authenticated_by_synthetic_test_capability'
  | 'approval_authentication_unavailable'
  | 'no_verified_owner_approval';

/** The fixed reason vocabulary; decisions list reasons in rule order. */
export const ROOT_REASON_CODES: readonly RootReasonCode[] = Object.freeze([
  'cited_approvals_not_authority',
  'proposal_created_after_evaluation',
  'action_not_in_policy',
  'target_kind_mismatch',
  'requested_authority_mismatch',
  'learned_state_change_forbidden',
  'risk_unclassified',
  'operation_forbidden',
  'root_risk_low',
  'root_risk_medium',
  'root_risk_high',
  'declared_risk_not_authority',
  'declared_risk_escalated',
  'declared_reversibility_escalated',
  'parameters_bound_by_digest_only',
  'approvals_rejected',
  'high_risk_denied_by_policy',
  'grant_verified',
  'no_applicable_grant',
  'grants_limited_to_low_risk',
  'owner_approval_verified',
  'approval_authenticated_by_synthetic_test_capability',
  'approval_authentication_unavailable',
  'no_verified_owner_approval',
] as const);

const InputSchema = z.strictObject({
  ownerId: OwnerIdSchema,
  sessionId: SessionIdSchema,
  taskId: TaskIdSchema,
  proposal: z.unknown(),
  decisionId: PolicyDecisionIdSchema,
  evaluatedAt: TimestampSchema,
  approvals: z
    .array(z.unknown())
    .max(ROOT_POLICY_CONFIG.limits.maxApprovalRecords)
    .optional(),
});

/** What the evaluation input carries (all of it is copied inertly). */
export interface RootEvaluationInput {
  readonly ownerId: string;
  readonly sessionId: string;
  readonly taskId: string;
  /** The proposal to evaluate; revalidated, never trusted. */
  readonly proposal: unknown;
  /** Caller-allocated `decision_` identifier; it carries no authority. */
  readonly decisionId: string;
  /** Root's evaluation time, supplied by the Root host, never a proposal. */
  readonly evaluatedAt: string;
  /** Every stored version of every approval Root found for the proposal. */
  readonly approvals?: readonly unknown[];
}

export type EffectiveRisk = 'low' | 'medium' | 'high';

/** A frozen evaluation: the decision and why. It executes nothing. */
export interface RootEvaluation {
  readonly kind: 'root_policy_evaluation';
  readonly version: typeof AVEN_012_ROOT_POLICY_VERSION;
  readonly decision: Readonly<PolicyDecision>;
  readonly binding: Readonly<ProposalBinding>;
  readonly task: { readonly sessionId: string; readonly taskId: string };
  readonly classification: {
    readonly toolId: string;
    readonly action: string;
    readonly catalogued: boolean;
    readonly rootRisk: RootRisk | 'unclassified' | null;
    readonly effectiveRisk: EffectiveRisk | null;
  };
  readonly grantReference: string | null;
  readonly approvals: readonly ApprovalFinding[];
  readonly parameters: {
    readonly locator: string;
    readonly declaredDigest: {
      readonly algorithm: 'sha256';
      readonly value: string;
    };
    readonly content: 'not_inspected';
  };
  readonly executes: false;
  readonly executionRequirement: 'recheck_parameter_bytes_and_root_decision_at_execution';
}

/** Evidence of the approvals an ALLOW relied on (for the recorder). */
export function approvalEvidence(
  evaluation: RootEvaluation,
): readonly EvidenceReference[] {
  const decision = evaluation.decision;
  if (decision.decision !== 'ALLOW' || decision.basis.kind !== 'owner_approval')
    return [];
  const ids = new Set<string>(decision.basis.approvalIds);
  return evaluation.approvals
    .filter((finding) => ids.has(finding.approvalId))
    .map((finding) => ({ ...finding.evidence }));
}

const RISK_LEVEL: Readonly<Record<EffectiveRisk, number>> = {
  low: 0,
  medium: 1,
  high: 2,
};
const LEVEL_RISK: readonly EffectiveRisk[] = ['low', 'medium', 'high'];
const DECLARED_RISK: Readonly<Record<string, number>> = {
  low: 0,
  medium: 1,
  high: 2,
  unknown: 2,
};
const REVERSIBILITY: Readonly<Record<string, number>> = {
  reversible: 0,
  partially_reversible: 1,
  irreversible: 2,
  unknown: 2,
};

function grantMatches(
  grant: Readonly<RootPolicyGrant>,
  proposal: RevalidatedLike,
  evaluatedAt: Instant,
): boolean {
  const scope = grant.scope;
  const from = instantOf(grant.validFrom) ?? fail('internal_error');
  const until = instantOf(grant.validUntil) ?? fail('internal_error');
  return (
    grant.ownerId === proposal.ownerId &&
    grant.toolId === proposal.toolId &&
    grant.action === proposal.action &&
    grant.resource.kind === proposal.target.kind &&
    grant.resource.identifier === proposal.target.identifier &&
    (scope.kind === 'owner' ||
      (scope.sessionId === proposal.task.sessionId &&
        (scope.kind === 'session' || scope.taskId === proposal.task.taskId))) &&
    compareInstants(from, evaluatedAt) <= 0 &&
    compareInstants(evaluatedAt, until) < 0
  );
}

interface RevalidatedLike {
  readonly ownerId: string;
  readonly toolId: string;
  readonly action: string;
  readonly target: { readonly kind: string; readonly identifier: string };
  readonly task: { readonly sessionId: string; readonly taskId: string };
}

type Outcome =
  | { readonly decision: 'DENY' }
  | {
      readonly decision: 'ALLOW';
      readonly basis:
        | { readonly kind: 'existing_grant'; readonly grantReference: string }
        | { readonly kind: 'owner_approval'; readonly approvalIds: string[] };
    }
  | {
      readonly decision: 'REQUIRE_OWNER_APPROVAL';
      readonly approvalRequirement: string;
    };

function requirement(
  binding: Readonly<ProposalBinding>,
  task: { readonly sessionId: string; readonly taskId: string },
  internals: PolicyInternals,
): string {
  const base =
    'Owner approval bound to proposal ' +
    binding.proposalId +
    ' version ' +
    String(binding.proposalVersion) +
    ' (proposal digest sha256:' +
    binding.proposalDigest.value +
    ', parameters digest sha256:' +
    binding.parametersDigest.value +
    ') for task ' +
    task.sessionId +
    '/' +
    task.taskId +
    ', issued after the proposal, unexpired, unrevoked and within ' +
    String(internals.definition.approvalMaxAgeSeconds) +
    ' seconds of evaluation, and authenticated through a Root-trusted channel';
  return internals.authenticator === null
    ? base +
        '; this policy has no Root-trusted approval authentication, so no approval can satisfy it'
    : base +
        '; the only channel configured is a synthetic test capability, not owner authentication';
}

/**
 * Evaluates one proposal under a registered Root policy. Returns a frozen
 * evaluation whose decision is a valid frozen AVEN-002 `PolicyDecision`.
 * Throws a `RootPolicyError` (never a decision) when the policy is not
 * registered (`untrusted_policy`), the input is malformed (`invalid_request`),
 * the proposal is not a valid AVEN-011 v1 proposal (`invalid_proposal`) or
 * belongs to another owner, session or task (`binding_mismatch`).
 */
export function evaluateActionProposal(
  policy: unknown,
  input: unknown,
): RootEvaluation {
  try {
    const internals = policyInternals(policy);
    const inert = inertCopy(input, ROOT_POLICY_CONFIG.limits.request);
    if (inert === undefined || !wellFormedThroughout(inert.copy))
      return fail('invalid_request');
    const parsed = InputSchema.safeParse(inert.copy);
    if (!parsed.success) return fail('invalid_request');
    const request = parsed.data;
    const evaluatedAt =
      instantOf(request.evaluatedAt) ?? fail('invalid_request');
    const approvals: OwnerApproval[] = (request.approvals ?? []).map(
      (record) => {
        const approval = OwnerApprovalSchema.safeParse(record);
        return approval.success ? approval.data : fail('invalid_request');
      },
    );
    const { proposal, binding } = revalidateProposal(request.proposal, {
      ownerId: request.ownerId,
      sessionId: request.sessionId,
      taskId: request.taskId,
    });

    const reasons: RootReasonCode[] = [];
    const findings = verifyApprovals(approvals, {
      proposal,
      binding,
      evaluatedAt,
      policy: internals,
    });
    const verified = findings
      .filter((finding) => finding.status === 'verified')
      .map((finding) => finding.approvalId);
    const classification = {
      toolId: proposal.toolId,
      action: proposal.action,
      catalogued: false,
      rootRisk: null as RootRisk | 'unclassified' | null,
      effectiveRisk: null as EffectiveRisk | null,
    };
    let grantReference: string | null = null;

    const decide = (): Outcome => {
      if (proposal.priorApprovalIds.length > 0)
        reasons.push('cited_approvals_not_authority');
      const created =
        instantOf(proposal.metadata.createdAt) ?? fail('internal_error');
      if (compareInstants(created, evaluatedAt) > 0) {
        reasons.push('proposal_created_after_evaluation');
        return { decision: 'DENY' };
      }
      const entry = internals.actions.get(
        pairKey(proposal.toolId, proposal.action),
      );
      if (entry === undefined) {
        reasons.push('action_not_in_policy');
        return { decision: 'DENY' };
      }
      classification.catalogued = true;
      if (proposal.target.kind !== entry.resourceKind) {
        reasons.push('target_kind_mismatch');
        return { decision: 'DENY' };
      }
      const requested = proposal.requestedAuthority;
      if (
        requested.length !== 1 ||
        requested[0]!.operation !== entry.operation ||
        !canonicallyEqual(requested[0]!.resource, proposal.target)
      ) {
        reasons.push('requested_authority_mismatch');
        return { decision: 'DENY' };
      }
      if (changesLearnedState(entry.operation, entry.resourceKind)) {
        reasons.push('learned_state_change_forbidden');
        return { decision: 'DENY' };
      }
      const rootRisk = internals.risk.get(
        pairKey(entry.operation, entry.resourceKind),
      );
      if (rootRisk === undefined) {
        classification.rootRisk = 'unclassified';
        reasons.push('risk_unclassified');
        return { decision: 'DENY' };
      }
      classification.rootRisk = rootRisk;
      if (rootRisk === 'forbidden') {
        reasons.push('operation_forbidden');
        return { decision: 'DENY' };
      }
      reasons.push(`root_risk_${rootRisk}`);
      let level = RISK_LEVEL[rootRisk];
      const declared = DECLARED_RISK[proposal.consequences.risk]!;
      if (declared > level) {
        level = declared;
        reasons.push('declared_risk_escalated');
      } else if (declared < level) reasons.push('declared_risk_not_authority');
      if (
        REVERSIBILITY[proposal.consequences.reversibility]! >
        REVERSIBILITY[entry.reversibility]!
      ) {
        reasons.push('declared_reversibility_escalated');
        level = Math.max(level, RISK_LEVEL.medium);
      }
      const effective = LEVEL_RISK[level]!;
      classification.effectiveRisk = effective;
      reasons.push('parameters_bound_by_digest_only');
      if (findings.some((finding) => finding.status === 'rejected'))
        reasons.push('approvals_rejected');
      if (effective === 'high' && internals.definition.highRisk === 'deny') {
        reasons.push('high_risk_denied_by_policy');
        return { decision: 'DENY' };
      }
      const grant = internals.grants
        .filter((candidate) => grantMatches(candidate, proposal, evaluatedAt))
        .sort((a, b) => (a.grantId < b.grantId ? -1 : 1))[0];
      if (effective === 'low') {
        if (grant !== undefined) {
          reasons.push('grant_verified');
          grantReference =
            internals.definition.policyVersion + '#' + grant.grantId;
          return {
            decision: 'ALLOW',
            basis: { kind: 'existing_grant', grantReference },
          };
        }
        reasons.push('no_applicable_grant');
      } else if (grant !== undefined)
        reasons.push('grants_limited_to_low_risk');
      if (verified.length > 0) {
        reasons.push('owner_approval_verified');
        if (internals.authenticator !== null)
          reasons.push('approval_authenticated_by_synthetic_test_capability');
        return {
          decision: 'ALLOW',
          basis: { kind: 'owner_approval', approvalIds: [...verified] },
        };
      }
      if (internals.authenticator === null)
        reasons.push('approval_authentication_unavailable');
      reasons.push('no_verified_owner_approval');
      return {
        decision: 'REQUIRE_OWNER_APPROVAL',
        approvalRequirement: requirement(binding, proposal.task, internals),
      };
    };
    const outcome = decide();

    const parsedDecision = PolicyDecisionSchema.safeParse({
      kind: 'policy_decision',
      ownerId: proposal.ownerId,
      metadata: {
        schemaVersion: 1,
        recordVersion: 1,
        createdAt: request.evaluatedAt,
        creation: {
          component: ROOT_POLICY_COMPONENT,
          version: AVEN_012_ROOT_POLICY_VERSION,
        },
      },
      id: request.decisionId,
      proposal: {
        proposalId: binding.proposalId,
        proposalVersion: binding.proposalVersion,
        proposalDigest: { ...binding.proposalDigest },
        parametersDigest: { ...binding.parametersDigest },
      },
      evaluatedAt: request.evaluatedAt,
      issuer: {
        kind: 'root',
        policyVersion: internals.policy.policyVersion,
        policyDigest: { ...internals.policy.policyDigest },
      },
      reasonCodes: [...new Set(reasons)],
      ...outcome,
    });
    if (!parsedDecision.success) return fail('internal_error');
    const declaredDigest = proposal.parameters.artifact.digest;
    const evaluation: RootEvaluation = deepFreeze({
      kind: 'root_policy_evaluation' as const,
      version: AVEN_012_ROOT_POLICY_VERSION,
      decision: parsedDecision.data,
      binding: {
        proposalId: binding.proposalId,
        proposalVersion: binding.proposalVersion,
        proposalDigest: { ...binding.proposalDigest },
        parametersDigest: { ...binding.parametersDigest },
      },
      task: {
        sessionId: proposal.task.sessionId,
        taskId: proposal.task.taskId,
      },
      classification: { ...classification },
      grantReference,
      approvals: findings,
      parameters: {
        locator: proposal.parameters.artifact.locator,
        declaredDigest: {
          algorithm: declaredDigest.algorithm,
          value: declaredDigest.value,
        },
        content: 'not_inspected' as const,
      },
      executes: false as const,
      executionRequirement:
        'recheck_parameter_bytes_and_root_decision_at_execution' as const,
    });
    return evaluation;
  } catch (error) {
    return rethrow(error);
  }
}
