import { z } from 'zod';
import {
  ActionProposalSchema,
  OwnerIdSchema,
  ProposalBindingSchema,
  SessionIdSchema,
  TaskIdSchema,
  type ActionProposal,
  type ProposalBinding,
} from '@aven/contracts';
import {
  canonicalText,
  taggedSha256,
  wellFormedThroughout,
} from './canonical.ts';
import {
  PROPOSAL_DIGEST_PROTOCOL,
  ROOT_POLICY_CONFIG,
  deepFreeze,
} from './config.ts';
import { fail, rethrow } from './errors.ts';
import { inertCopy } from './inert.ts';

/**
 * Root's own revalidation of an AVEN-011 action proposal (protocol v1).
 *
 * Root never trusts a proposal, a stored record or a declared binding: it
 * copies the input inertly (no caller code runs), parses it with the frozen
 * AVEN-002 `ActionProposalSchema`, applies the AVEN-011 v1 format rules and
 * recomputes the exact binding, including the protocol-v1 proposal digest.
 * The rules mirror `validateActionProposal` of `@aven/action-proposals`
 * without importing it (a frozen AVEN-011 tripwire forbids any other package
 * from depending on it, and Root should not depend on the proposing side);
 * the shared AVEN-011 golden digest vectors pin the two implementations to
 * the same results.
 *
 * Nothing in a proposal is authority: requested authority, declared risk and
 * reversibility, cited approvals, the tool's own description and the
 * declared origin of its recording event are all untrusted model output.
 */

const ContextSchema = z.strictObject({
  ownerId: OwnerIdSchema,
  sessionId: SessionIdSchema,
  taskId: TaskIdSchema,
});
export type ProposalContext = z.infer<typeof ContextSchema>;

/** A proposal that passed the v1 rules, with Root's recomputed binding. */
export interface RevalidatedProposal {
  readonly proposal: Readonly<ActionProposal>;
  readonly binding: Readonly<ProposalBinding>;
}

/**
 * Learning-lifecycle operations and non-read operations on learned state are
 * outside the AVEN-011 v1 format. Root also forbids them by policy invariant.
 */
export const LEARNING_OPERATIONS: ReadonlySet<string> = new Set([
  'promote_learning',
  'revoke_learning',
  'rollback_learning',
]);

/** True for an operation Root never permits: it would change owner state. */
export function changesLearnedState(
  operation: string,
  resourceKind: string,
): boolean {
  return (
    LEARNING_OPERATIONS.has(operation) ||
    (resourceKind === 'learned_state' && operation !== 'read')
  );
}

function hasV1Stamp(proposal: ActionProposal): boolean {
  const creation = proposal.metadata.creation;
  const stamp = ROOT_POLICY_CONFIG.proposal.stamp;
  return (
    Object.keys(creation).length === 2 &&
    creation.component === stamp.component &&
    creation.version === stamp.version
  );
}

/** The protocol-v1 digest of a parsed proposal. */
export function proposalDigestOf(proposal: ActionProposal): {
  readonly algorithm: 'sha256';
  readonly value: string;
} {
  const text = canonicalText(proposal);
  if (text === undefined) return fail('invalid_proposal');
  return {
    algorithm: 'sha256',
    value: taggedSha256(PROPOSAL_DIGEST_PROTOCOL, text),
  };
}

/**
 * Revalidates a proposal for an explicit owner, session and task and
 * recomputes its binding. A malformed or non-v1 proposal is
 * `invalid_proposal`; a proposal of another owner, session or task is
 * `binding_mismatch`. Nothing in the result is a permission.
 */
export function revalidateProposal(
  candidate: unknown,
  context: unknown,
): RevalidatedProposal {
  try {
    const inertContext = inertCopy(context, ROOT_POLICY_CONFIG.limits.proposal);
    const scope = ContextSchema.safeParse(inertContext?.copy);
    if (!scope.success) return fail('invalid_request');
    const inert = inertCopy(candidate, ROOT_POLICY_CONFIG.limits.proposal);
    if (inert === undefined || !wellFormedThroughout(inert.copy))
      return fail('invalid_proposal');
    const parsed = ActionProposalSchema.safeParse(inert.copy);
    if (!parsed.success) return fail('invalid_proposal');
    const proposal = parsed.data;
    if (
      !hasV1Stamp(proposal) ||
      proposal.metadata.recordVersion !==
        ROOT_POLICY_CONFIG.proposal.recordVersion
    )
      fail('invalid_proposal');
    if (
      proposal.requestedAuthority.some((entry) =>
        changesLearnedState(entry.operation, entry.resource.kind),
      )
    )
      fail('invalid_proposal');
    if (
      proposal.ownerId !== scope.data.ownerId ||
      proposal.task.sessionId !== scope.data.sessionId ||
      proposal.task.taskId !== scope.data.taskId
    )
      fail('binding_mismatch');
    const parameters = proposal.parameters.artifact.digest;
    const binding = ProposalBindingSchema.parse({
      proposalId: proposal.id,
      proposalVersion: proposal.metadata.recordVersion,
      proposalDigest: proposalDigestOf(proposal),
      parametersDigest: {
        algorithm: parameters.algorithm,
        value: parameters.value,
      },
    });
    return deepFreeze({ proposal, binding });
  } catch (error) {
    return rethrow(error);
  }
}
