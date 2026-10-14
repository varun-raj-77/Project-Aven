import { z } from 'zod';
import {
  ActionProposalSchema,
  ProposalBindingSchema,
  type ActionProposal,
  type ProposalBinding,
} from '@aven/contracts';
import { canonicalText } from './canonical.ts';
import {
  ACTION_PROPOSALS_CONFIG,
  AVEN_011_ACTION_PROPOSALS_VERSION,
  deepFreeze,
} from './config.ts';
import { ActionProposalError } from './errors.ts';
import { inertCopy } from './inert.ts';
import { validateActionProposal } from './proposal.ts';

/**
 * Authority-neutral, read-only view of a validated proposal.
 *
 * The input is never trusted: the proposal is revalidated and its binding
 * recomputed, and a binding that differs is rejected. The view states what
 * was requested and declared, labels it as such, and confers nothing:
 * requested authority is not granted, declared consequences are not
 * assessed, parameter content is not verified, cited approvals are not
 * verified, and no Root decision is evaluated here.
 */
export interface ProposalInspection {
  readonly kind: 'action_proposal_inspection';
  readonly protocol: typeof AVEN_011_ACTION_PROPOSALS_VERSION;
  readonly ownerId: string;
  readonly task: { readonly sessionId: string; readonly taskId: string };
  readonly proposal: { readonly id: string; readonly version: number };
  readonly binding: Readonly<ProposalBinding>;
  readonly toolId: string;
  readonly action: string;
  readonly target: Readonly<ActionProposal['target']>;
  readonly requestedAuthority: {
    readonly entries: readonly Readonly<
      ActionProposal['requestedAuthority'][number]
    >[];
    readonly status: 'requested_not_granted';
  };
  readonly declaredConsequences: Readonly<ActionProposal['consequences']> & {
    readonly status: 'declared_unassessed';
  };
  readonly parameters: {
    readonly locator: string;
    readonly declaredContentDigest: Readonly<
      ActionProposal['parameters']['artifact']['digest']
    >;
    readonly content: 'not_verified';
  };
  readonly priorApprovalCitations: readonly {
    readonly approvalId: string;
    readonly status: 'cited_unverified';
  }[];
  readonly confersAuthority: false;
  readonly rootDecision: 'not_evaluated_here';
}

const ValidatedShape = z.strictObject({
  proposal: ActionProposalSchema,
  binding: ProposalBindingSchema,
});

export function inspectActionProposal(validated: unknown): ProposalInspection {
  try {
    // An inert copy first: no getter or Proxy of the caller ever runs. The
    // shape is parsed only to read the claimed binding context; the full v1
    // check is validateActionProposal on the copied proposal.
    const inert = inertCopy(validated, ACTION_PROPOSALS_CONFIG.limits);
    if (inert === undefined) throw new ActionProposalError('invalid_request');
    const claimed = ValidatedShape.safeParse(inert.copy);
    if (!claimed.success) throw new ActionProposalError('invalid_request');
    const { proposal, binding } = validateActionProposal(
      (inert.copy as { proposal: unknown }).proposal,
      {
        ownerId: claimed.data.proposal.ownerId,
        sessionId: claimed.data.proposal.task.sessionId,
        taskId: claimed.data.proposal.task.taskId,
      },
    );
    if (canonicalText(binding) !== canonicalText(claimed.data.binding))
      throw new ActionProposalError('invalid_request');
    const digest = proposal.parameters.artifact.digest;
    return deepFreeze({
      kind: 'action_proposal_inspection',
      protocol: AVEN_011_ACTION_PROPOSALS_VERSION,
      ownerId: proposal.ownerId,
      task: {
        sessionId: proposal.task.sessionId,
        taskId: proposal.task.taskId,
      },
      proposal: { id: proposal.id, version: proposal.metadata.recordVersion },
      binding: {
        proposalId: binding.proposalId,
        proposalVersion: binding.proposalVersion,
        proposalDigest: { ...binding.proposalDigest },
        parametersDigest: { ...binding.parametersDigest },
      },
      toolId: proposal.toolId,
      action: proposal.action,
      target: { ...proposal.target },
      requestedAuthority: {
        entries: proposal.requestedAuthority.map((entry) => ({
          operation: entry.operation,
          resource: { ...entry.resource },
        })),
        status: 'requested_not_granted',
      },
      declaredConsequences: {
        ...proposal.consequences,
        status: 'declared_unassessed',
      },
      parameters: {
        locator: proposal.parameters.artifact.locator,
        declaredContentDigest: { ...digest },
        content: 'not_verified',
      },
      priorApprovalCitations: proposal.priorApprovalIds.map((approvalId) => ({
        approvalId,
        status: 'cited_unverified',
      })),
      confersAuthority: false,
      rootDecision: 'not_evaluated_here',
    });
  } catch (error) {
    if (error instanceof ActionProposalError) throw error;
    throw new ActionProposalError('internal_error');
  }
}
