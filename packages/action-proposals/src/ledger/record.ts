import { z } from 'zod';
import {
  EventIdSchema,
  ExperienceEventSchema,
  ModelInferenceProvenanceSchema,
  OwnerIdSchema,
  ProvenanceSchema,
  SessionIdSchema,
  SystemGeneratedProvenanceSchema,
  TaskIdSchema,
  TimestampSchema,
  type ProposalBinding,
} from '@aven/contracts';
import { createLedger, LedgerError, type EventInput } from '@aven/ledger';
import type { Storage } from '@aven/storage';
import { canonicalText, isWellFormed } from '../canonical.ts';
import {
  ACTION_PROPOSAL_CREATION_COMPONENT,
  ACTION_PROPOSALS_CONFIG,
  AVEN_011_ACTION_PROPOSALS_VERSION,
  deepFreeze,
} from '../config.ts';
import {
  ActionProposalError,
  type ActionProposalErrorCode,
  type ActionProposalOutcome,
} from '../errors.ts';
import { inertCopy } from '../inert.ts';
import { validateActionProposal } from '../proposal.ts';
import {
  ownerExists,
  proposalIdInUse,
  readRow,
  readStoredProposalEvent,
} from './stored.ts';

/**
 * AVEN-011 Patch 3: the proposal recorder (the only AVEN-011 write) and
 * reconciliation of an uncertain outcome.
 *
 * One call records one validated v1 proposal as exactly one frozen AVEN-002
 * `action_proposed` experience event, through ONE call to the frozen AVEN-004
 * `appendEvent`, with the computed protocol-v1 digest and no evidence record.
 * The Ledger owns the transaction, the recording clock, the frozen
 * `action_proposals` projection and every reference check at COMMIT; this
 * module writes no table itself and starts no transaction.
 *
 * Identifiers and the occurrence time are supplied by the caller, so a retry
 * of the identical request is safe and reconciliation can compare the exact
 * expected event. The success receipt is built only from values computed
 * before the append and the event the Ledger returns: there is no storage read
 * after the commit. Recording is not authorization: nothing here allows,
 * denies, approves, executes or decides anything. The declared origin
 * (provenance) belongs to the event and is never authenticated.
 */

const RequestSchema = z.strictObject({
  ownerId: OwnerIdSchema,
  sessionId: SessionIdSchema,
  taskId: TaskIdSchema,
  proposal: z.unknown(),
  eventId: EventIdSchema,
  occurredAt: TimestampSchema,
  provenance: z.unknown(),
});
/** The v1 recording format accepts only these declared origins. */
const OriginSchema = z.discriminatedUnion('kind', [
  ModelInferenceProvenanceSchema,
  SystemGeneratedProvenanceSchema,
]);

export interface ProposalRecordingRequest {
  readonly ownerId: string;
  readonly sessionId: string;
  readonly taskId: string;
  /** A constructed proposal; it is revalidated, never trusted. */
  readonly proposal: unknown;
  /** Caller-allocated `event_` identifier; reuse it on a retry. */
  readonly eventId: string;
  /** Caller-supplied; must not precede `proposal.metadata.createdAt`. */
  readonly occurredAt: string;
  /** Declared event origin: `model_inference` or `system_generated`. */
  readonly provenance:
    | z.input<typeof ModelInferenceProvenanceSchema>
    | z.input<typeof SystemGeneratedProvenanceSchema>;
}

/** Recording succeeded. It does not mean anything was allowed or approved. */
export interface ProposalRecordingReceipt {
  readonly outcome: 'recorded';
  readonly ownerId: string;
  readonly eventId: string;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly recordedAt: string;
  readonly binding: Readonly<ProposalBinding>;
}

export type ProposalReconciliation =
  | {
      readonly status: 'recorded';
      readonly sequence: number;
      readonly recordedAt: string;
      readonly binding: Readonly<ProposalBinding>;
    }
  | { readonly status: 'not_recorded' }
  | { readonly status: 'conflict' }
  | { readonly status: 'unresolved'; readonly code: ActionProposalErrorCode };

const fail = (code: ActionProposalErrorCode): never => {
  throw new ActionProposalError(code);
};

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

/**
 * The request envelope is copied with one extra level and room for the
 * declared origin beside a proposal of the maximum v1 size; the proposal
 * itself is then held to the exact v1 limits by `validateActionProposal`.
 */
const REQUEST_LIMITS = Object.freeze({
  ...ACTION_PROPOSALS_CONFIG.limits,
  maxDepth: ACTION_PROPOSALS_CONFIG.limits.maxDepth + 1,
  maxNodes: 2 * ACTION_PROPOSALS_CONFIG.limits.maxNodes,
});

/**
 * The fields of an RFC 3339 timestamp in the form the frozen AVEN-002
 * `TimestampSchema` (`z.iso.datetime({ offset: true })`) accepts: seconds
 * always present, a fraction of any length, `Z` or a `+hh:mm`/`-hh:mm`
 * offset. Structurally no narrower than that grammar; calendar validity is
 * left to the frozen schema, which has checked both values before any
 * comparison.
 */
const TIMESTAMP_FIELDS =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:Z|([+-])(\d{2}):(\d{2}))$/;

/** Days from 1970-01-01 to a proleptic Gregorian date (exact integers). */
function daysFromCivil(year: bigint, month: bigint, day: bigint): bigint {
  const y = month <= 2n ? year - 1n : year;
  const era = (y >= 0n ? y : y - 399n) / 400n;
  const yearOfEra = y - era * 400n;
  const dayOfYear = (153n * (month > 2n ? month - 3n : month + 9n) + 2n) / 5n;
  const dayOfEra =
    yearOfEra * 365n + yearOfEra / 4n - yearOfEra / 100n + dayOfYear + day - 1n;
  return era * 146097n + dayOfEra - 719468n;
}

/** Whole UTC seconds since the epoch and the significant fraction digits. */
function instantOf(
  timestamp: string,
): { readonly seconds: bigint; readonly fraction: string } | undefined {
  const m = timestamp.match(TIMESTAMP_FIELDS);
  if (m === null) return undefined;
  const [, year, month, day, hour, minute, second] = m;
  const fraction = m[7] ?? '';
  // Trailing zeros carry no precision; a linear scan, not a backtracking regex.
  let significant = fraction.length;
  while (significant > 0 && fraction[significant - 1] === '0') significant -= 1;
  const offsetMinutes =
    m[8] === undefined
      ? 0n
      : (m[8] === '-' ? -1n : 1n) *
        (BigInt(m[9] ?? '0') * 60n + BigInt(m[10] ?? '0'));
  const local =
    daysFromCivil(BigInt(year!), BigInt(month!), BigInt(day!)) * 86400n +
    BigInt(hour!) * 3600n +
    BigInt(minute!) * 60n +
    BigInt(second!);
  return {
    seconds: local - offsetMinutes * 60n,
    fraction: fraction.slice(0, significant),
  };
}

/**
 * Orders two timestamps by the instant they denote, exactly: integer
 * arithmetic for the date, time and offset, and a digit-by-digit comparison
 * of the full fraction, so no accepted precision is discarded. Returns -1, 0
 * or 1, or `undefined` for a string outside the timestamp form. The strings
 * themselves are never rewritten.
 */
export function compareTimestamps(
  a: string,
  b: string,
): -1 | 0 | 1 | undefined {
  const x = instantOf(a);
  const y = instantOf(b);
  if (x === undefined || y === undefined) return undefined;
  if (x.seconds !== y.seconds) return x.seconds < y.seconds ? -1 : 1;
  // Without trailing zeros, the order of the digit strings is the numeric
  // order of the fractions: the first differing digit decides, and a proper
  // prefix is smaller because the longer fraction ends in a non-zero digit.
  if (x.fraction === y.fraction) return 0;
  return x.fraction < y.fraction ? -1 : 1;
}

interface Prepared {
  readonly ownerId: string;
  readonly sessionId: string;
  readonly taskId: string;
  readonly eventId: string;
  readonly proposalId: string;
  readonly event: EventInput;
  readonly binding: ProposalBinding;
  readonly derivedFrom: readonly { evidenceId: string; eventId: string }[];
  readonly priorApprovalIds: readonly string[];
}

/**
 * Validates the request and builds the exact event the recorder appends
 * (everything except the Ledger's `recordedAt` and `sequence`). Pure.
 */
export function expectedRecordingEvent(request: unknown): Prepared {
  const inert = inertCopy(request, REQUEST_LIMITS);
  if (inert === undefined || !wellFormedThroughout(inert.copy))
    return fail('invalid_request');
  const parsed = RequestSchema.safeParse(inert.copy);
  if (!parsed.success) return fail('invalid_request');
  const r = parsed.data;
  const { proposal, binding } = validateActionProposal(r.proposal, {
    ownerId: r.ownerId,
    sessionId: r.sessionId,
    taskId: r.taskId,
  });
  if (!ProvenanceSchema.safeParse(r.provenance).success)
    fail('invalid_request');
  const origin = OriginSchema.safeParse(r.provenance);
  if (!origin.success) return fail('unsupported_origin');
  const order = compareTimestamps(proposal.metadata.createdAt, r.occurredAt);
  if (order === undefined) return fail('internal_error');
  if (order > 0) fail('timestamp_order');
  const event = {
    kind: 'experience_event' as const,
    ownerId: r.ownerId,
    metadata: {
      schemaVersion: 1 as const,
      recordVersion: 1 as const,
      createdAt: r.occurredAt,
      creation: {
        component: ACTION_PROPOSAL_CREATION_COMPONENT,
        version: AVEN_011_ACTION_PROPOSALS_VERSION,
      },
    },
    id: r.eventId,
    occurredAt: r.occurredAt,
    task: { sessionId: r.sessionId, taskId: r.taskId },
    evidenceIds: [],
    eventType: 'action_proposed' as const,
    payload: JSON.parse(JSON.stringify(proposal)) as typeof proposal,
    provenance: origin.data,
  };
  // Contract preflight with the occurrence time standing in for the
  // recording time: after it, only the Ledger's own clock can disagree.
  const preflight = ExperienceEventSchema.safeParse({
    ...event,
    recordedAt: r.occurredAt,
  });
  if (!preflight.success) return fail('internal_error');
  return {
    ownerId: r.ownerId,
    sessionId: r.sessionId,
    taskId: r.taskId,
    eventId: r.eventId,
    proposalId: proposal.id,
    event: event as unknown as EventInput,
    binding: JSON.parse(JSON.stringify(binding)) as ProposalBinding,
    derivedFrom: origin.data.derivedFrom,
    priorApprovalIds: proposal.priorApprovalIds,
  };
}

/** Pinned owner-scoped, read-only precheck statements. */
export const PRECHECK_SQL = Object.freeze({
  task: 'SELECT session_id FROM tasks WHERE owner_id = ? AND task_id = ?',
  evidence:
    'SELECT 1 AS found FROM evidence WHERE owner_id = ? AND record_id = ? AND event_id = ?',
  approval:
    'SELECT 1 AS found FROM owner_approvals WHERE owner_id = ? AND record_id = ?',
  event:
    'SELECT 1 AS found FROM experience_events WHERE owner_id = ? AND record_id = ?',
});

function notInTransaction(storage: Storage): boolean {
  try {
    return storage.sqlite.inTransaction === false;
  } catch {
    return false;
  }
}

/**
 * Owner-local, read-only prechecks giving each failure a fixed code. The
 * Ledger revalidates everything at COMMIT and remains authoritative; the
 * identifier checks are best-effort and can race with another connection.
 */
function precheck(storage: Storage, p: Prepared): void {
  // The frozen Ledger appends only outside another transaction.
  if (!notInTransaction(storage)) fail('storage_failure');
  if (!ownerExists(storage, p.ownerId)) fail('unknown_binding');
  const task = readRow(storage, PRECHECK_SQL.task, p.ownerId, p.taskId) as
    { session_id?: unknown } | undefined;
  if (task === undefined || task.session_id !== p.sessionId)
    fail('unknown_binding');
  for (const ref of p.derivedFrom)
    if (
      readRow(
        storage,
        PRECHECK_SQL.evidence,
        p.ownerId,
        ref.evidenceId,
        ref.eventId,
      ) === undefined
    )
      fail('unresolved_reference');
  for (const approvalId of p.priorApprovalIds)
    if (
      readRow(storage, PRECHECK_SQL.approval, p.ownerId, approvalId) ===
      undefined
    )
      fail('unresolved_reference');
  if (
    readRow(storage, PRECHECK_SQL.event, p.ownerId, p.eventId) !== undefined ||
    proposalIdInUse(storage, p.ownerId, p.proposalId)
  )
    fail('identifier_collision');
}

/**
 * Maps a failure of the frozen `appendEvent` to a code and an outcome. A
 * rollback is reported as confirmed only for codes the Ledger raises while
 * its transaction is still open (its own checks, or foreign-key failures at
 * COMMIT), where it executes ROLLBACK itself. For `storage_failure` the
 * Ledger reports `rolled_back` even when it did not execute ROLLBACK, so the
 * outcome is `unknown`. Anything unrecognized is `unknown`.
 */
export function ledgerFailure(error: unknown): {
  readonly code: ActionProposalErrorCode;
  readonly outcome: ActionProposalOutcome;
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
 * Records one validated proposal. Returns a frozen receipt only after the
 * Ledger COMMIT succeeded. Every failure is an `ActionProposalError` whose
 * `outcome` says whether nothing was written (`not_written`), the Ledger
 * reported a completed rollback (`rolled_back`) or the result is `unknown`;
 * after `unknown`, close the connection and reconcile before any retry.
 */
export function recordActionProposal(
  storage: Storage,
  request: unknown,
): ProposalRecordingReceipt {
  let prepared: Prepared;
  try {
    prepared = expectedRecordingEvent(request);
    precheck(storage, prepared);
  } catch (error) {
    if (error instanceof ActionProposalError) throw error;
    throw new ActionProposalError('internal_error');
  }
  let stored;
  try {
    stored = createLedger(storage, prepared.ownerId as never).appendEvent(
      prepared.event,
      { proposalDigest: prepared.binding.proposalDigest },
    );
  } catch (error) {
    const failure = ledgerFailure(error);
    throw new ActionProposalError(failure.code, failure.outcome);
  }
  // No storage access from here on; any failure is an unknown outcome.
  try {
    const event = stored.event;
    if (event.id !== prepared.eventId || event.eventType !== 'action_proposed')
      throw new ActionProposalError('internal_error', 'unknown');
    return deepFreeze({
      outcome: 'recorded' as const,
      ownerId: prepared.ownerId,
      eventId: event.id,
      sequence: stored.sequence,
      occurredAt: event.occurredAt,
      recordedAt: event.recordedAt,
      binding: prepared.binding,
    });
  } catch {
    throw new ActionProposalError('internal_error', 'unknown');
  }
}

const unresolved = (code: ActionProposalErrorCode): ProposalReconciliation =>
  deepFreeze({ status: 'unresolved' as const, code });

/**
 * Decides whether the identical request was recorded, by comparing the full
 * stored event (all fields except the Ledger's `recordedAt` and `sequence`),
 * its stored projection and its declared digest with what the recorder would
 * have written. Call it on a fresh connection after an `unknown` outcome. A
 * lookup failure is `unresolved`, never `conflict`. A malformed request
 * throws the same error recording would.
 */
export function reconcileActionProposalRecording(
  storage: Storage,
  request: unknown,
): ProposalReconciliation {
  let prepared: Prepared;
  try {
    prepared = expectedRecordingEvent(request);
  } catch (error) {
    if (error instanceof ActionProposalError) throw error;
    throw new ActionProposalError('internal_error');
  }
  try {
    if (!notInTransaction(storage)) return unresolved('storage_failure');
    if (!ownerExists(storage, prepared.ownerId))
      return unresolved('unknown_binding');
    const found = readStoredProposalEvent(
      storage,
      prepared.ownerId,
      prepared.eventId,
    );
    if (found.status === 'absent')
      return deepFreeze(
        proposalIdInUse(storage, prepared.ownerId, prepared.proposalId)
          ? { status: 'conflict' as const }
          : { status: 'not_recorded' as const },
      );
    if (found.status === 'other_event_type')
      return deepFreeze({ status: 'conflict' as const });
    const { recordedAt, ...comparable } = found.stored.event;
    const expected = canonicalText(prepared.event);
    if (
      expected === undefined ||
      canonicalText(comparable) !== expected ||
      found.stored.evidence.length !== 0 ||
      found.declaredDigest !== prepared.binding.proposalDigest.value
    )
      return deepFreeze({ status: 'conflict' as const });
    return deepFreeze({
      status: 'recorded' as const,
      sequence: found.stored.sequence,
      recordedAt,
      binding: prepared.binding,
    });
  } catch (error) {
    return unresolved(
      error instanceof ActionProposalError ? error.code : 'internal_error',
    );
  }
}
