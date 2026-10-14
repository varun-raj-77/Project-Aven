import { z } from 'zod';
import {
  ActionProposalIdSchema,
  ActionProposalSchema,
  OwnerIdSchema,
  ProposalBindingSchema,
  SessionIdSchema,
  TaskIdSchema,
  TimestampSchema,
  type ActionProposal,
  type ProposalBinding,
} from '@aven/contracts';
import {
  canonicalText,
  digestOfCanonicalText,
  isWellFormed,
} from './canonical.ts';
import {
  ACTION_PROPOSAL_CREATION_COMPONENT,
  ACTION_PROPOSALS_CONFIG,
  AVEN_011_ACTION_PROPOSALS_VERSION,
  deepFreeze,
} from './config.ts';
import { ActionProposalError, type ActionProposalErrorCode } from './errors.ts';
import { inertCopy } from './inert.ts';

/**
 * AVEN-011 pure proposal boundary: construction, validation and binding.
 *
 * Every function here is deterministic: identifiers and times are supplied by
 * the caller, and nothing reads a clock, generates randomness, touches
 * storage, calls a model or decides authority. Input is copied inertly (no
 * caller code runs), parsed with the frozen AVEN-002 `ActionProposalSchema`,
 * and checked against the v1 rules below, which are stricter than the
 * contract and bind only proposals that go through this package.
 *
 * A proposal's origin (provenance) belongs to the event that records it, not
 * to the proposal: it is neither accepted here nor part of the digest.
 */

const shape = ActionProposalSchema.shape;

/** Everything the caller supplies; the package derives the rest. */
const DraftSchema = z.strictObject({
  ownerId: OwnerIdSchema,
  sessionId: SessionIdSchema,
  taskId: TaskIdSchema,
  proposalId: ActionProposalIdSchema,
  createdAt: TimestampSchema,
  toolId: shape.toolId,
  action: shape.action,
  target: shape.target,
  parameters: shape.parameters,
  consequences: shape.consequences,
  requestedAuthority: shape.requestedAuthority,
  priorApprovalIds: shape.priorApprovalIds,
});
export type ActionProposalDraft = z.input<typeof DraftSchema>;

const ContextSchema = z.strictObject({
  ownerId: OwnerIdSchema,
  sessionId: SessionIdSchema,
  taskId: TaskIdSchema,
});
export type ProposalBindingContext = z.input<typeof ContextSchema>;

export interface ProposalDigest {
  readonly algorithm: 'sha256';
  readonly value: string;
}

/** A proposal that passed the v1 rules, with its exact binding (deep-frozen). */
export interface ValidatedActionProposal {
  readonly proposal: Readonly<ActionProposal>;
  readonly binding: Readonly<ProposalBinding>;
}

/**
 * Learning-lifecycle transitions are deferred to later milestones, and the v1
 * recording format carries no generic mutation of learned state. Reads of
 * learned state are allowed. This is a format restriction of this package,
 * not a Root decision.
 */
const LIFECYCLE_OPERATIONS: ReadonlySet<string> = new Set([
  'promote_learning',
  'revoke_learning',
  'rollback_learning',
]);

const fail = (code: ActionProposalErrorCode): never => {
  throw new ActionProposalError(code);
};

/** Every string, keys included, in an inert copy is well-formed UTF-16. */
function wellFormedThroughout(value: unknown): boolean {
  if (typeof value === 'string') return isWellFormed(value);
  if (Array.isArray(value)) return value.every(wellFormedThroughout);
  if (value !== null && typeof value === 'object')
    return Object.keys(value).every(
      (key) =>
        isWellFormed(key) &&
        wellFormedThroughout((value as Record<string, unknown>)[key]),
    );
  return true;
}

function copied(value: unknown): unknown {
  const inert = inertCopy(value, ACTION_PROPOSALS_CONFIG.limits);
  if (inert === undefined || !wellFormedThroughout(inert.copy))
    return fail('invalid_request');
  return inert.copy;
}

function parseProposal(candidate: unknown): ActionProposal {
  const parsed = ActionProposalSchema.safeParse(copied(candidate));
  return parsed.success ? parsed.data : fail('invalid_request');
}

/** Exactly the v1 creation stamp, with no runtime stamp. */
function hasV1Stamp(proposal: ActionProposal): boolean {
  const creation = proposal.metadata.creation;
  return (
    Object.keys(creation).length === 2 &&
    creation.component === ACTION_PROPOSAL_CREATION_COMPONENT &&
    creation.version === AVEN_011_ACTION_PROPOSALS_VERSION
  );
}

function digestOf(proposal: ActionProposal): ProposalDigest {
  const text = canonicalText(proposal);
  if (text === undefined) return fail('internal_error');
  return { algorithm: 'sha256', value: digestOfCanonicalText(text) };
}

function rethrow(error: unknown): never {
  if (error instanceof ActionProposalError) throw error;
  throw new ActionProposalError('internal_error');
}

/**
 * The protocol-v1 digest of a proposal carrying the v1 creation stamp. It
 * checks only what the digest needs (the frozen contract, the stamp and
 * well-formed Unicode), not the binding or operation rules.
 */
export function computeActionProposalDigest(proposal: unknown): ProposalDigest {
  try {
    const parsed = parseProposal(proposal);
    if (!hasV1Stamp(parsed)) fail('unsupported_proposal');
    return deepFreeze(digestOf(parsed));
  } catch (error) {
    return rethrow(error);
  }
}

/**
 * Checks a complete proposal against the v1 rules for an explicit owner,
 * session and task, and derives its binding. Nothing in the result is a
 * permission, an approval or a Root decision.
 */
export function validateActionProposal(
  candidate: unknown,
  context: unknown,
): ValidatedActionProposal {
  try {
    const binding = ContextSchema.safeParse(copied(context));
    if (!binding.success) return fail('invalid_request');
    const proposal = parseProposal(candidate);
    if (!hasV1Stamp(proposal) || proposal.metadata.recordVersion !== 1)
      fail('unsupported_proposal');
    if (
      proposal.ownerId !== binding.data.ownerId ||
      proposal.task.sessionId !== binding.data.sessionId ||
      proposal.task.taskId !== binding.data.taskId
    )
      fail('binding_mismatch');
    if (
      proposal.requestedAuthority.some(
        (entry) =>
          LIFECYCLE_OPERATIONS.has(entry.operation) ||
          (entry.resource.kind === 'learned_state' &&
            entry.operation !== 'read'),
      )
    )
      fail('operation_not_in_v1_format');
    const parametersDigest = proposal.parameters.artifact.digest;
    return deepFreeze({
      proposal,
      binding: ProposalBindingSchema.parse({
        proposalId: proposal.id,
        proposalVersion: proposal.metadata.recordVersion,
        proposalDigest: digestOf(proposal),
        parametersDigest: {
          algorithm: parametersDigest.algorithm,
          value: parametersDigest.value,
        },
      }),
    });
  } catch (error) {
    return rethrow(error);
  }
}

/**
 * Builds a version-1 proposal from caller-supplied values, including its
 * identifier and creation time, and validates it. Deterministic: the same
 * draft always yields the same proposal and binding.
 */
export function constructActionProposal(
  draft: unknown,
): ValidatedActionProposal {
  try {
    const parsed = DraftSchema.safeParse(copied(draft));
    if (!parsed.success) return fail('invalid_request');
    const d = parsed.data;
    return validateActionProposal(
      {
        kind: 'action_proposal',
        ownerId: d.ownerId,
        metadata: {
          schemaVersion: 1,
          recordVersion: 1,
          createdAt: d.createdAt,
          creation: {
            component: ACTION_PROPOSAL_CREATION_COMPONENT,
            version: AVEN_011_ACTION_PROPOSALS_VERSION,
          },
        },
        id: d.proposalId,
        task: { sessionId: d.sessionId, taskId: d.taskId },
        toolId: d.toolId,
        action: d.action,
        parameters: d.parameters,
        target: d.target,
        consequences: d.consequences,
        requestedAuthority: d.requestedAuthority,
        priorApprovalIds: d.priorApprovalIds,
      },
      { ownerId: d.ownerId, sessionId: d.sessionId, taskId: d.taskId },
    );
  } catch (error) {
    return rethrow(error);
  }
}
