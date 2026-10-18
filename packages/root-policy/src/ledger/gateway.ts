import { z } from 'zod';
import {
  EventIdSchema,
  OwnerIdSchema,
  PolicyDecisionIdSchema,
  TimestampSchema,
} from '@aven/contracts';
import type { Storage } from '@aven/storage';
import { deepFreeze, ROOT_POLICY_CONFIG } from '../config.ts';
import { fail, rethrow } from '../errors.ts';
import { evaluateActionProposal, type RootEvaluation } from '../evaluate.ts';
import { inertCopy } from '../inert.ts';
import { policyInternals, type RootPolicy } from '../policy.ts';
import { revalidateProposal } from '../proposal.ts';
import {
  ownerExists,
  readApprovalVersions,
  readRecordedProposal,
  readSnapshot,
} from './stored.ts';

/**
 * AVEN-012 Patch 3: the Root gateway over recorded proposals (read-only
 * evaluation).
 *
 * A gateway is Root host configuration: a registered Root policy, the Root
 * clock (the only source of evaluation time; a request can never choose it)
 * and the recording window. `evaluateRecordedProposal` reads one recorded
 * AVEN-011 proposal and the approvals bound to it, owner-scoped and inside
 * one read snapshot, verifies the stored projection and declared digest
 * against Root's own revalidation, and evaluates it with the pure engine. It
 * writes nothing; recording the decision is the separate `recordRootDecision`
 * step, and nothing here executes anything.
 *
 * The request names only the owner, the proposal event and a
 * caller-allocated decision identifier. It cannot supply a proposal,
 * approvals, grants, a policy, a time, a risk or an outcome.
 */
export interface RootGateway {
  readonly kind: 'root_gateway';
  readonly policyVersion: string;
  readonly policyDigest: {
    readonly algorithm: 'sha256';
    readonly value: string;
  };
  readonly recordingWindowSeconds: number;
}

interface GatewayInternals {
  readonly policy: RootPolicy;
  readonly clock: () => unknown;
  readonly recordingWindowSeconds: number;
}

const GATEWAYS = new WeakMap<object, GatewayInternals>();
/** Evaluations this module produced: gateway and storage they came from. */
const PRODUCED = new WeakMap<
  object,
  { readonly gateway: RootGateway; readonly storage: Storage }
>();

const RequestSchema = z.strictObject({
  ownerId: OwnerIdSchema,
  proposalEventId: EventIdSchema,
  decisionId: PolicyDecisionIdSchema,
});
export interface RecordedProposalRequest {
  readonly ownerId: string;
  /** The `action_proposed` event that recorded the proposal. */
  readonly proposalEventId: string;
  /** Caller-allocated `decision_` identifier; reuse it on a retry. */
  readonly decisionId: string;
}

export interface RootGatewayOptions {
  /** A policy registered by `createRootPolicy`. */
  readonly policy: RootPolicy;
  /** The Root clock: returns the current time as an RFC 3339 timestamp. */
  readonly clock: () => string;
  /** Maximum seconds from evaluation to recording (default 60, max 3600). */
  readonly recordingWindowSeconds?: number;
}

/**
 * Creates a gateway from Root host configuration. The options object must
 * be a plain object with exactly these fields; the policy must be registered
 * and the clock must be a function.
 */
export function createRootGateway(options: RootGatewayOptions): RootGateway {
  try {
    if (
      options === null ||
      typeof options !== 'object' ||
      Object.getPrototypeOf(options) !== Object.prototype
    )
      fail('invalid_request');
    const keys = Object.keys(options);
    if (
      keys.some(
        (key) =>
          key !== 'policy' &&
          key !== 'clock' &&
          key !== 'recordingWindowSeconds',
      )
    )
      fail('invalid_request');
    const { policy, clock } = options;
    const window = options.recordingWindowSeconds ?? 60;
    const internals = policyInternals(policy);
    if (typeof clock !== 'function') fail('invalid_request');
    if (!Number.isSafeInteger(window) || window < 1 || window > 3600)
      fail('invalid_request');
    const gateway: RootGateway = deepFreeze({
      kind: 'root_gateway' as const,
      policyVersion: internals.policy.policyVersion,
      policyDigest: { ...internals.policy.policyDigest },
      recordingWindowSeconds: window,
    });
    GATEWAYS.set(gateway, {
      policy: internals.policy,
      clock,
      recordingWindowSeconds: window,
    });
    return gateway;
  } catch (error) {
    return rethrow(error);
  }
}

/** The internals of a registered gateway, or `untrusted_capability`. */
export function gatewayInternals(gateway: unknown): GatewayInternals {
  const internals =
    typeof gateway === 'object' && gateway !== null
      ? GATEWAYS.get(gateway)
      : undefined;
  return internals ?? fail('untrusted_capability');
}

/** Reads the Root clock; a value that is not a timestamp fails closed. */
export function rootNow(gateway: unknown): string {
  const internals = gatewayInternals(gateway);
  let now: unknown;
  try {
    now = internals.clock();
  } catch {
    return fail('internal_error');
  }
  const parsed = TimestampSchema.safeParse(now);
  return parsed.success ? parsed.data : fail('internal_error');
}

/** Where an evaluation came from, if this module produced it. */
export function producedBy(
  evaluation: unknown,
): { readonly gateway: RootGateway; readonly storage: Storage } | undefined {
  return typeof evaluation === 'object' && evaluation !== null
    ? PRODUCED.get(evaluation)
    : undefined;
}

/**
 * Evaluates one recorded proposal under the gateway's policy at the Root
 * clock's current time. Returns a frozen evaluation (not recorded). Fails
 * closed with a `RootPolicyError` (`not_written`): `invalid_request`,
 * `untrusted_capability`, `unknown_binding` (owner or proposal event absent,
 * or not an `action_proposed` event), `invalid_history` (projection, digest
 * or approval history inconsistent), `invalid_proposal`, `storage_failure`
 * or `internal_error`.
 */
export function evaluateRecordedProposal(
  gateway: RootGateway,
  storage: Storage,
  request: RecordedProposalRequest,
): RootEvaluation {
  try {
    const internals = gatewayInternals(gateway);
    const inert = inertCopy(request, ROOT_POLICY_CONFIG.limits.proposal);
    const parsed = RequestSchema.safeParse(inert?.copy);
    if (!parsed.success) return fail('invalid_request');
    const r = parsed.data;
    const read = readSnapshot(storage, () => {
      if (!ownerExists(storage, r.ownerId)) fail('unknown_binding');
      const recorded = readRecordedProposal(
        storage,
        r.ownerId,
        r.proposalEventId,
      );
      const payload = recorded.event.payload;
      const { binding } = revalidateProposal(payload, {
        ownerId: r.ownerId,
        sessionId: payload.task.sessionId,
        taskId: payload.task.taskId,
      });
      // The stored digest is a declaration; Root's recomputation decides.
      if (binding.proposalDigest.value !== recorded.declaredDigest)
        fail('invalid_history');
      return {
        proposal: payload,
        approvals: readApprovalVersions(
          storage,
          r.ownerId,
          binding.proposalId,
          binding.proposalVersion,
        ),
      };
    });
    const evaluation = evaluateActionProposal(internals.policy, {
      ownerId: r.ownerId,
      sessionId: read.proposal.task.sessionId,
      taskId: read.proposal.task.taskId,
      proposal: read.proposal,
      decisionId: r.decisionId,
      evaluatedAt: rootNow(gateway),
      approvals: read.approvals,
    });
    PRODUCED.set(evaluation, { gateway, storage });
    return evaluation;
  } catch (error) {
    return rethrow(error);
  }
}
