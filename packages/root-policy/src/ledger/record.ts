import { z } from 'zod';
import {
  EventIdSchema,
  EvidenceReferenceSchema,
  ExperienceEventSchema,
  PolicyDecisionSchema,
  TaskBindingSchema,
  type EvidenceReference,
  type PolicyDecision,
  type ProposalBinding,
} from '@aven/contracts';
import { createLedger, LedgerError, type EventInput } from '@aven/ledger';
import type { Storage } from '@aven/storage';
import { canonicalText, canonicallyEqual } from '../canonical.ts';
import {
  AVEN_012_ROOT_POLICY_VERSION,
  ROOT_POLICY_COMPONENT,
  ROOT_POLICY_CONFIG,
  deepFreeze,
} from '../config.ts';
import {
  RootPolicyError,
  fail,
  type RootPolicyErrorCode,
  type RootPolicyOutcome,
} from '../errors.ts';
import { approvalEvidence, type RootEvaluation } from '../evaluate.ts';
import { inertCopy } from '../inert.ts';
import { compareInstants, instantOf, shiftSeconds } from '../timestamps.ts';
import {
  gatewayInternals,
  producedBy,
  rootNow,
  type RootGateway,
} from './gateway.ts';
import {
  READ_SQL,
  approvalVersionStates,
  evidenceExists,
  ownerExists,
  readEvent,
  readRow,
  readSnapshot,
  taskSession,
} from './stored.ts';

/**
 * AVEN-012 Patch 3: recording a Root decision (the only AVEN-012 write) and
 * reconciling an uncertain recording.
 *
 * `recordRootDecision` records one evaluation that THIS gateway produced
 * from THIS storage (by identity: a decision object, a copy or an
 * evaluation from the pure engine is `untrusted_evaluation`) as exactly one
 * frozen AVEN-002 `policy_decision` experience event, through ONE call to the
 * frozen AVEN-004 `appendEvent`. The event's provenance is
 * `system_generated` by `@aven/root-policy`, derived from the evidence of
 * the approvals an approval-based ALLOW relied on. The Ledger owns the
 * transaction, the recording clock, the frozen `policy_decisions` projection
 * and every reference check at COMMIT (the decision must name a recorded
 * proposal with exactly its binding); this module writes no table itself.
 *
 * Recording is not execution: nothing here runs a tool, and a recorded
 * ALLOW is a claim about one evaluation, not a standing permission. There is
 * no exactly-once guarantee: identifiers are caller-allocated so that a
 * retry is safe, and reconciliation settles an `unknown` outcome.
 */

const RequestSchema = z.strictObject({ eventId: EventIdSchema });
export interface DecisionRecordingRequest {
  /** Caller-allocated `event_` identifier; reuse it on a retry. */
  readonly eventId: string;
}

/** Recording succeeded. It does not mean anything was executed. */
export interface DecisionRecordingReceipt {
  readonly outcome: 'recorded';
  readonly ownerId: string;
  readonly eventId: string;
  readonly sequence: number;
  readonly decisionId: string;
  readonly decision: PolicyDecision['decision'];
  readonly binding: Readonly<ProposalBinding>;
  readonly evaluatedAt: string;
  readonly recordedAt: string;
}

export type DecisionReconciliation =
  | {
      readonly status: 'recorded';
      readonly sequence: number;
      readonly recordedAt: string;
    }
  | { readonly status: 'not_recorded' }
  | { readonly status: 'conflict' }
  | { readonly status: 'unresolved'; readonly code: RootPolicyErrorCode };

/** The parts of an evaluation that determine the recorded event. */
const RecordedShape = z.object({
  decision: PolicyDecisionSchema,
  task: TaskBindingSchema,
});

interface Prepared {
  readonly ownerId: string;
  readonly eventId: string;
  readonly decision: PolicyDecision;
  readonly task: { readonly sessionId: string; readonly taskId: string };
  readonly derivedFrom: readonly EvidenceReference[];
  readonly event: EventInput;
  /** For an approval-based ALLOW: each relied-on approval's evaluated versions. */
  readonly reliedOn: ReadonlyMap<string, readonly number[]>;
}

/**
 * The exact event recorded for a decision (everything except the Ledger's
 * `recordedAt` and `sequence`). Pure.
 */
function expectedDecisionEvent(
  decision: PolicyDecision,
  task: { readonly sessionId: string; readonly taskId: string },
  derivedFrom: readonly EvidenceReference[],
  eventId: string,
  reliedOn: ReadonlyMap<string, readonly number[]> = new Map(),
): Prepared {
  const event = {
    kind: 'experience_event' as const,
    ownerId: decision.ownerId,
    metadata: {
      schemaVersion: 1 as const,
      recordVersion: 1 as const,
      createdAt: decision.evaluatedAt,
      creation: {
        component: ROOT_POLICY_COMPONENT,
        version: AVEN_012_ROOT_POLICY_VERSION,
      },
    },
    id: eventId,
    occurredAt: decision.evaluatedAt,
    task: { sessionId: task.sessionId, taskId: task.taskId },
    evidenceIds: [],
    eventType: 'policy_decision' as const,
    payload: JSON.parse(JSON.stringify(decision)) as PolicyDecision,
    provenance: {
      kind: 'system_generated' as const,
      component: ROOT_POLICY_COMPONENT,
      version: AVEN_012_ROOT_POLICY_VERSION,
      derivedFrom: derivedFrom.map((ref) => ({
        evidenceId: ref.evidenceId,
        eventId: ref.eventId,
      })),
    },
  };
  // Contract preflight with the occurrence time standing in for the
  // recording time: after it, only the Ledger's own clock can disagree.
  if (
    !ExperienceEventSchema.safeParse({ ...event, recordedAt: event.occurredAt })
      .success
  )
    fail('internal_error');
  return {
    ownerId: decision.ownerId,
    eventId,
    decision,
    task: event.task,
    derivedFrom: event.provenance.derivedFrom,
    event: event as unknown as EventInput,
    reliedOn,
  };
}

/**
 * Maps a failure of the frozen `appendEvent` to a code and an outcome, as
 * AVEN-011 does: a rollback is confirmed only for codes the Ledger raises
 * while its transaction is still open; its `storage_failure` is reported as
 * rolled back even when it did not execute ROLLBACK, so that is `unknown`.
 */
export function ledgerFailure(error: unknown): {
  readonly code: RootPolicyErrorCode;
  readonly outcome: RootPolicyOutcome;
} {
  if (!(error instanceof LedgerError))
    return { code: 'internal_error', outcome: 'unknown' };
  const code = error.code as string;
  const rollback = error.rollback as string;
  if (rollback === 'not_started') {
    if (code === 'transaction_active' || code === 'storage_failure')
      return { code: 'storage_failure', outcome: 'not_written' };
    if (code === 'invalid_event' || code === 'invalid_reference')
      return { code: 'ledger_rejected', outcome: 'not_written' };
    return { code: 'internal_error', outcome: 'not_written' };
  }
  if (rollback === 'rolled_back') {
    switch (code) {
      case 'duplicate_event':
        return { code: 'identifier_collision', outcome: 'rolled_back' };
      case 'invalid_reference':
      case 'invalid_event':
        return { code: 'ledger_rejected', outcome: 'rolled_back' };
      case 'unknown_owner':
      case 'unknown_session':
      case 'unknown_task':
        return { code: 'unknown_binding', outcome: 'rolled_back' };
      case 'integrity_failure':
        return { code: 'storage_failure', outcome: 'rolled_back' };
      case 'invalid_input':
      case 'cross_owner_reference':
        return { code: 'internal_error', outcome: 'rolled_back' };
      case 'storage_failure':
        return { code: 'storage_failure', outcome: 'unknown' };
      default:
        return { code: 'internal_error', outcome: 'unknown' };
    }
  }
  if (rollback === 'failed')
    return { code: 'storage_failure', outcome: 'unknown' };
  return { code: 'internal_error', outcome: 'unknown' };
}

/**
 * Owner-local, read-only prechecks giving each failure a fixed code, in one
 * read snapshot. The Ledger revalidates everything at COMMIT and remains
 * authoritative; the identifier checks are best-effort under concurrency.
 * For an approval-based ALLOW, every relied-on approval's COMPLETE current
 * version history is read again: more versions than the v1 bound is
 * `invalid_history` (never truncated); any version that is not `issued`,
 * or any version set other than exactly the one evaluated (history that
 * grew or changed after evaluation), is `stale_evaluation`. A revoked
 * approval visible at precheck is therefore never recorded as a basis.
 */
function precheck(storage: Storage, p: Prepared): void {
  readSnapshot(storage, () => {
    if (!ownerExists(storage, p.ownerId)) fail('unknown_binding');
    if (taskSession(storage, p.ownerId, p.task.taskId) !== p.task.sessionId)
      fail('unknown_binding');
    const binding = p.decision.proposal;
    const proposalRow = readRow(
      storage,
      READ_SQL.proposalProjection,
      p.ownerId,
      binding.proposalId,
      binding.proposalVersion,
    ) as { proposal_digest?: unknown } | undefined;
    if (proposalRow?.proposal_digest !== binding.proposalDigest.value)
      fail('unresolved_reference');
    for (const ref of p.derivedFrom)
      if (!evidenceExists(storage, p.ownerId, ref.evidenceId, ref.eventId))
        fail('unresolved_reference');
    const decision = p.decision;
    if (
      decision.decision === 'ALLOW' &&
      decision.basis.kind === 'owner_approval'
    )
      for (const id of decision.basis.approvalIds) {
        const states = approvalVersionStates(storage, p.ownerId, id);
        if (states.length === 0) fail('unresolved_reference');
        if (states.some((state) => state.status !== 'issued'))
          fail('stale_evaluation');
        const evaluated = p.reliedOn.get(id);
        if (
          evaluated === undefined ||
          evaluated.length !== states.length ||
          states.some((state, i) => state.version !== evaluated[i])
        )
          fail('stale_evaluation');
      }
    if (
      readRow(storage, READ_SQL.eventInUse, p.ownerId, p.eventId) !==
        undefined ||
      readRow(storage, READ_SQL.decisionInUse, p.ownerId, decision.id) !==
        undefined
    )
      fail('identifier_collision');
  });
}

/**
 * Records one gateway evaluation. Returns a frozen receipt only after the
 * Ledger COMMIT succeeded. Every failure is a `RootPolicyError` whose
 * `outcome` says whether nothing was written (`not_written`), the Ledger
 * reported a completed rollback (`rolled_back`) or the result is `unknown`;
 * after `unknown`, close the connection and reconcile before any retry. On
 * entry, the Root clock is read once and must lie between the evaluation time
 * and the evaluation time plus the gateway's recording window
 * (`stale_evaluation` otherwise). That is an entry-time age check only: it
 * does not bound how long the prechecks and the append then take, and it does
 * not close the race with a revocation committed after the precheck.
 */
export function recordRootDecision(
  gateway: RootGateway,
  storage: Storage,
  evaluation: RootEvaluation,
  request: DecisionRecordingRequest,
): DecisionRecordingReceipt {
  let prepared: Prepared;
  try {
    const internals = gatewayInternals(gateway);
    const origin = producedBy(evaluation);
    if (
      origin === undefined ||
      origin.gateway !== gateway ||
      origin.storage !== storage
    )
      fail('untrusted_evaluation');
    const inert = inertCopy(request, ROOT_POLICY_CONFIG.limits.proposal);
    const parsed = RequestSchema.safeParse(inert?.copy);
    if (!parsed.success) return fail('invalid_request');
    const decision = evaluation.decision;
    const evaluatedAt =
      instantOf(decision.evaluatedAt) ?? fail('internal_error');
    const now = instantOf(rootNow(gateway)) ?? fail('internal_error');
    if (
      compareInstants(now, evaluatedAt) < 0 ||
      compareInstants(
        now,
        shiftSeconds(evaluatedAt, internals.recordingWindowSeconds),
      ) > 0
    )
      fail('stale_evaluation');
    prepared = expectedDecisionEvent(
      decision,
      evaluation.task,
      approvalEvidence(evaluation),
      parsed.data.eventId,
      new Map(
        evaluation.approvals.map((finding) => [
          finding.approvalId,
          [...finding.versions].sort((a, b) => a - b),
        ]),
      ),
    );
    precheck(storage, prepared);
  } catch (error) {
    if (error instanceof RootPolicyError) throw error;
    throw new RootPolicyError('internal_error');
  }
  let stored;
  try {
    stored = createLedger(storage, prepared.ownerId as never).appendEvent(
      prepared.event,
    );
  } catch (error) {
    const failure = ledgerFailure(error);
    throw new RootPolicyError(failure.code, failure.outcome);
  }
  // No storage access from here on; any failure is an unknown outcome.
  try {
    const event = stored.event;
    if (event.id !== prepared.eventId || event.eventType !== 'policy_decision')
      throw new RootPolicyError('internal_error', 'unknown');
    return deepFreeze({
      outcome: 'recorded' as const,
      ownerId: prepared.ownerId,
      eventId: event.id,
      sequence: stored.sequence,
      decisionId: prepared.decision.id,
      decision: prepared.decision.decision,
      binding: JSON.parse(
        JSON.stringify(prepared.decision.proposal),
      ) as ProposalBinding,
      evaluatedAt: prepared.decision.evaluatedAt,
      recordedAt: event.recordedAt,
    });
  } catch {
    throw new RootPolicyError('internal_error', 'unknown');
  }
}

const unresolved = (code: RootPolicyErrorCode): DecisionReconciliation =>
  deepFreeze({ status: 'unresolved' as const, code });

/**
 * Decides whether a decision event was recorded, by comparing the full
 * stored event (all fields except the Ledger's `recordedAt` and `sequence`)
 * with what `recordRootDecision` would have written for the evaluation. The
 * evaluation may be the original object or plain data copied from it; this
 * function only reads, so it confers nothing. A lookup failure is
 * `unresolved`, never `conflict`. A malformed request is `invalid_request`.
 */
export function reconcileRootDecisionRecording(
  storage: Storage,
  evaluation: unknown,
  request: DecisionRecordingRequest,
): DecisionReconciliation {
  let prepared: Prepared;
  try {
    const inert = inertCopy(evaluation, ROOT_POLICY_CONFIG.limits.request);
    const shape = RecordedShape.safeParse(inert?.copy);
    const parsed = RequestSchema.safeParse(
      inertCopy(request, ROOT_POLICY_CONFIG.limits.proposal)?.copy,
    );
    if (!shape.success || !parsed.success) return fail('invalid_request');
    const approvals = z
      .object({
        approvals: z.array(
          z.object({
            approvalId: z.string(),
            evidence: EvidenceReferenceSchema,
          }),
        ),
      })
      .safeParse(inert?.copy);
    if (!approvals.success) return fail('invalid_request');
    const decision = shape.data.decision;
    const ids =
      decision.decision === 'ALLOW' && decision.basis.kind === 'owner_approval'
        ? new Set<string>(decision.basis.approvalIds)
        : new Set<string>();
    prepared = expectedDecisionEvent(
      decision,
      shape.data.task,
      approvals.data.approvals
        .filter((finding) => ids.has(finding.approvalId))
        .map((finding) => finding.evidence),
      parsed.data.eventId,
    );
  } catch (error) {
    if (error instanceof RootPolicyError) throw error;
    throw new RootPolicyError('internal_error');
  }
  try {
    return readSnapshot(storage, () => {
      if (!ownerExists(storage, prepared.ownerId))
        return unresolved('unknown_binding');
      const found = readEvent(storage, prepared.ownerId, prepared.eventId);
      if (found === undefined)
        return deepFreeze(
          readRow(
            storage,
            READ_SQL.decisionInUse,
            prepared.ownerId,
            prepared.decision.id,
          ) !== undefined
            ? { status: 'conflict' as const }
            : { status: 'not_recorded' as const },
        );
      const { recordedAt, ...comparable } = found.event;
      const expected = canonicalText(prepared.event);
      if (
        expected === undefined ||
        !canonicallyEqual(comparable, prepared.event)
      )
        return deepFreeze({ status: 'conflict' as const });
      return deepFreeze({
        status: 'recorded' as const,
        sequence: found.sequence,
        recordedAt,
      });
    });
  } catch (error) {
    return unresolved(
      error instanceof RootPolicyError ? error.code : 'internal_error',
    );
  }
}
