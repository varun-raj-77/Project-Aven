/**
 * @aven/action-proposals: the AVEN-011 Action Proposal Boundary (Patch 2,
 * the pure root entry).
 *
 * Deterministic construction, validation, canonical digest (protocol v1),
 * binding and authority-neutral inspection of frozen AVEN-002 action
 * proposals. It depends only on `@aven/contracts`, `zod`, `node:crypto`
 * (SHA-256) and `node:util` (a side-effect-free Proxy check). Nothing here
 * records, reads storage, reads a clock, generates identifiers, calls a
 * model, executes a tool, learns or decides authority: Aven proposes, Root
 * decides. The Ledger recorder and history reader are later patches.
 */
export {
  ACTION_PROPOSAL_CREATION_COMPONENT,
  ACTION_PROPOSAL_DIGEST_PROTOCOL,
  ACTION_PROPOSALS_CONFIG,
  AVEN_011_ACTION_PROPOSALS_VERSION,
  type ActionProposalsConfiguration,
} from './config.ts';
export {
  ACTION_PROPOSAL_ERROR_CODES,
  ACTION_PROPOSAL_OUTCOMES,
  ActionProposalError,
  type ActionProposalErrorCode,
  type ActionProposalOutcome,
  type SerializedActionProposalError,
} from './errors.ts';
export {
  computeActionProposalDigest,
  constructActionProposal,
  validateActionProposal,
  type ActionProposalDraft,
  type ProposalBindingContext,
  type ProposalDigest,
  type ValidatedActionProposal,
} from './proposal.ts';
export { inspectActionProposal, type ProposalInspection } from './inspect.ts';
