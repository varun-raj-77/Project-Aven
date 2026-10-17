/**
 * @aven/root-policy: the AVEN-012 Root Policy Gateway (Patch 2, the pure
 * Root policy engine).
 *
 * Aven proposes; Root decides. This entry validates Root-controlled policy
 * definitions, revalidates AVEN-011 v1 action proposals independently,
 * verifies approval records and evaluates a proposal to a frozen AVEN-002
 * `PolicyDecision` (ALLOW, DENY or REQUIRE_OWNER_APPROVAL). It depends only
 * on `@aven/contracts`, `zod`, `node:crypto` (SHA-256) and `node:util` (a
 * side-effect-free Proxy check). Nothing here records, reads storage or a
 * clock, generates identifiers, calls a model, executes a tool or learns.
 * Decision recording is a later patch; tool execution is not in AVEN-012.
 * This is an in-process prototype: package and module separation is not
 * OS-level security isolation.
 */
export {
  AVEN_012_ROOT_POLICY_VERSION,
  PROPOSAL_DIGEST_PROTOCOL,
  ROOT_POLICY_COMPONENT,
  ROOT_POLICY_CONFIG,
  ROOT_POLICY_DEFINITION_FORMAT,
  ROOT_POLICY_DIGEST_PROTOCOL,
  type RootPolicyConfiguration,
} from './config.ts';
export {
  ROOT_POLICY_ERROR_CODES,
  ROOT_POLICY_OUTCOMES,
  RootPolicyError,
  type RootPolicyErrorCode,
  type RootPolicyOutcome,
  type SerializedRootPolicyError,
} from './errors.ts';
export {
  ROOT_DENY_ALL_POLICY_DEFINITION,
  ROOT_V1_REFERENCE_RISK_TABLE,
  createRootPolicy,
  type RootPolicy,
  type RootPolicyAction,
  type RootPolicyDefinition,
  type RootPolicyGrant,
  type RootRisk,
} from './policy.ts';
export {
  revalidateProposal,
  type ProposalContext,
  type RevalidatedProposal,
} from './proposal.ts';
export {
  APPROVAL_REASONS,
  type ApprovalFinding,
  type ApprovalReason,
} from './approvals.ts';
export {
  ROOT_REASON_CODES,
  evaluateActionProposal,
  type EffectiveRisk,
  type RootEvaluation,
  type RootEvaluationInput,
  type RootReasonCode,
} from './evaluate.ts';
export type { ApprovalAuthenticator } from './authentication.ts';
