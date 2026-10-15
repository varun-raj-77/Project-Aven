import { z } from 'zod';
import {
  OwnerIdSchema,
  SessionIdSchema,
  TaskIdSchema,
  type ActionProposal,
  type Provenance,
} from '@aven/contracts';
import { createLedger, LedgerError, type StoredEvent } from '@aven/ledger';
import { deserializeContract, type Storage } from '@aven/storage';
import {
  canonicalText,
  digestOfCanonicalText,
  isWellFormed,
} from '../canonical.ts';
import {
  ACTION_PROPOSAL_CREATION_COMPONENT,
  ACTION_PROPOSALS_CONFIG,
  AVEN_011_ACTION_PROPOSALS_VERSION,
  deepFreeze,
} from '../config.ts';
import {
  ActionProposalError,
  type ActionProposalErrorCode,
} from '../errors.ts';
import { inertCopy } from '../inert.ts';
import { compareTimestamps } from './record.ts';
import { READ_SQL, readRow } from './stored.ts';

/**
 * AVEN-011 Patch 4: the read-only historical reader.
 *
 * One call reads one page of an owner's `action_proposed` events through the
 * frozen Ledger `listEvents` (which revalidates every stored event) and maps
 * each event, one to one and in sequence order, to a record. For each event
 * it reads the frozen `action_proposals` projection with one pinned
 * owner-scoped SELECT and requires it to equal the event payload. It never
 * drops, merges, ranks, repairs or writes anything, so `throughSequence` and
 * `nextCursor` are the Ledger's own and the caller pages with the same
 * filter.
 *
 * Every record is classified independently: the creation-stamp protocol,
 * digest agreement, the proposal format and the event format. None of these
 * is authentication: the digest function and the v1 stamp are public, and any
 * code with storage access can append through the frozen Ledger, so a record
 * that conforms and agrees was not necessarily written by the recorder.
 * Every origin is `declared_unauthenticated`, prior-approval citations are
 * never evaluated, and nothing here allows, approves, executes or learns.
 */

/** The reader's page filter; the event type is always `action_proposed`. */
const sequence = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const FilterSchema = z.strictObject({
  sessionId: SessionIdSchema.optional(),
  taskId: TaskIdSchema.optional(),
  afterSequence: sequence.optional(),
  throughSequence: sequence.optional(),
  limit: z.number().int().min(1).max(1000).optional(),
});
export type ProposalHistoryFilter = z.input<typeof FilterSchema>;

export type ProposalFormatReason =
  | 'proposal_ill_formed_unicode'
  | 'proposal_limits_exceeded'
  | 'proposal_record_version_not_1'
  | 'proposal_operation_not_in_v1_format';
export type EventFormatReason =
  | 'event_task_missing'
  | 'event_origin_kind_unsupported'
  | 'event_provenance_ill_formed_unicode'
  | 'event_provenance_limits_exceeded'
  | 'event_evidence_present'
  | 'event_metadata_not_v1'
  | 'event_occurs_before_proposal_creation';

export interface FormatClassification<Reason extends string> {
  readonly status: 'conforming' | 'nonconforming' | 'not_evaluated';
  readonly reasons: readonly Reason[];
}

/** One recorded `action_proposed` event. Nothing in it is an authority. */
export interface ProposalEventRecord {
  readonly sequence: number;
  readonly eventId: string;
  readonly occurredAt: string;
  readonly recordedAt: string;
  readonly envelopeTask: {
    readonly sessionId: string;
    readonly taskId: string;
  } | null;
  readonly evidenceIds: readonly string[];
  /** This event's own declared origin, verbatim. */
  readonly provenance: Readonly<Provenance>;
  readonly origin: 'declared_unauthenticated';
  /** The stored payload, verbatim (checked equal to its projection). */
  readonly proposal: Readonly<ActionProposal>;
  /** The digest declared at append time (`action_proposals.proposal_digest`). */
  readonly declaredDigest: {
    readonly algorithm: 'sha256';
    readonly value: string;
  };
  readonly protocol: 'v1' | 'unsupported';
  readonly digest: 'agrees' | 'disagrees' | 'not_evaluated';
  readonly proposalFormat: FormatClassification<ProposalFormatReason>;
  readonly eventFormat: FormatClassification<EventFormatReason>;
  readonly priorApprovalCitations: readonly {
    readonly approvalId: string;
    readonly status: 'cited_unverified';
  }[];
}

export interface ProposalEventPage {
  readonly records: readonly ProposalEventRecord[];
  readonly throughSequence: number;
  readonly nextCursor: {
    readonly afterSequence: number;
    readonly throughSequence: number;
  } | null;
}

const fail = (code: ActionProposalErrorCode): never => {
  throw new ActionProposalError(code);
};

/** Learning-lifecycle operations are outside the v1 recording format. */
const LIFECYCLE_OPERATIONS: ReadonlySet<string> = new Set([
  'promote_learning',
  'revoke_learning',
  'rollback_learning',
]);
const V1_ORIGINS: ReadonlySet<string> = new Set([
  'model_inference',
  'system_generated',
]);

/** Every string, keys included, is well-formed UTF-16. */
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

/** Structural equality of parsed JSON values; key order is irrelevant. */
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a))
    return (
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, i) => sameJson(item, b[i]))
    );
  if (
    a === null ||
    b === null ||
    typeof a !== 'object' ||
    typeof b !== 'object' ||
    Array.isArray(b)
  )
    return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  return (
    keysA.length === keysB.length &&
    keysA.every(
      (key) =>
        Object.hasOwn(b, key) &&
        sameJson(
          (a as Record<string, unknown>)[key],
          (b as Record<string, unknown>)[key],
        ),
    )
  );
}

/** Exactly the v1 creation stamp, with no runtime stamp. */
function isV1Stamp(creation: Record<string, unknown>): boolean {
  return (
    Object.keys(creation).length === 2 &&
    creation.component === ACTION_PROPOSAL_CREATION_COMPONENT &&
    creation.version === AVEN_011_ACTION_PROPOSALS_VERSION
  );
}

const withinLimits = (value: unknown): boolean =>
  inertCopy(value, ACTION_PROPOSALS_CONFIG.limits) !== undefined;

function classification<Reason extends string>(
  reasons: Reason[],
): FormatClassification<Reason> {
  return {
    status: reasons.length === 0 ? 'conforming' : 'nonconforming',
    reasons,
  };
}

const NOT_EVALUATED = { status: 'not_evaluated' as const, reasons: [] };

/** The stored projection and declared digest for one event's payload. */
function projectionOf(
  storage: Storage,
  owner: string,
  proposal: ActionProposal,
): { readonly projection: ActionProposal; readonly declared: string } {
  const row = readRow(
    storage,
    READ_SQL.projection,
    owner,
    proposal.id,
    proposal.metadata.recordVersion,
  ) as { record_json?: unknown; proposal_digest?: unknown } | undefined;
  if (
    row === undefined ||
    typeof row.record_json !== 'string' ||
    typeof row.proposal_digest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(row.proposal_digest)
  )
    return fail('invalid_history');
  try {
    return {
      projection: deserializeContract('action_proposals', row.record_json),
      declared: row.proposal_digest,
    };
  } catch {
    return fail('invalid_history');
  }
}

function classify(storage: Storage, owner: string, stored: StoredEvent) {
  const event = stored.event;
  if (event.eventType !== 'action_proposed') return fail('invalid_history');
  const proposal = event.payload;
  const { projection, declared } = projectionOf(storage, owner, proposal);
  if (!sameJson(projection, proposal)) fail('invalid_history');

  const protocol = isV1Stamp(proposal.metadata.creation) ? 'v1' : 'unsupported';
  const proposalWellFormed = wellFormedThroughout(proposal);
  let digest: ProposalEventRecord['digest'] = 'not_evaluated';
  let proposalFormat: FormatClassification<ProposalFormatReason> =
    NOT_EVALUATED;
  let eventFormat: FormatClassification<EventFormatReason> = NOT_EVALUATED;

  if (protocol === 'v1') {
    const text = proposalWellFormed ? canonicalText(proposal) : undefined;
    if (text !== undefined)
      digest =
        digestOfCanonicalText(text) === declared ? 'agrees' : 'disagrees';

    const p: ProposalFormatReason[] = [];
    if (!proposalWellFormed) p.push('proposal_ill_formed_unicode');
    if (!withinLimits(proposal)) p.push('proposal_limits_exceeded');
    if (proposal.metadata.recordVersion !== 1)
      p.push('proposal_record_version_not_1');
    if (
      proposal.requestedAuthority.some(
        (entry) =>
          LIFECYCLE_OPERATIONS.has(entry.operation) ||
          (entry.resource.kind === 'learned_state' &&
            entry.operation !== 'read'),
      )
    )
      p.push('proposal_operation_not_in_v1_format');
    proposalFormat = classification(p);

    const e: EventFormatReason[] = [];
    if (event.task === undefined) e.push('event_task_missing');
    if (!V1_ORIGINS.has(event.provenance.kind))
      e.push('event_origin_kind_unsupported');
    if (!wellFormedThroughout(event.provenance))
      e.push('event_provenance_ill_formed_unicode');
    if (!withinLimits(event.provenance))
      e.push('event_provenance_limits_exceeded');
    if (event.evidenceIds.length > 0 || stored.evidence.length > 0)
      e.push('event_evidence_present');
    const metadata = event.metadata;
    if (
      metadata.schemaVersion !== 1 ||
      metadata.recordVersion !== 1 ||
      metadata.createdAt !== event.occurredAt ||
      !isV1Stamp(metadata.creation)
    )
      e.push('event_metadata_not_v1');
    // Exact instant order (every accepted fraction digit and offset).
    const order = compareTimestamps(
      proposal.metadata.createdAt,
      event.occurredAt,
    );
    if (order === undefined) return fail('internal_error');
    if (order > 0) e.push('event_occurs_before_proposal_creation');
    eventFormat = classification(e);
  }

  return {
    sequence: stored.sequence,
    eventId: event.id,
    occurredAt: event.occurredAt,
    recordedAt: event.recordedAt,
    envelopeTask:
      event.task === undefined
        ? null
        : { sessionId: event.task.sessionId, taskId: event.task.taskId },
    evidenceIds: [...event.evidenceIds],
    provenance: event.provenance,
    origin: 'declared_unauthenticated' as const,
    proposal,
    declaredDigest: { algorithm: 'sha256' as const, value: declared },
    protocol,
    digest,
    proposalFormat,
    eventFormat,
    priorApprovalCitations: proposal.priorApprovalIds.map((approvalId) => ({
      approvalId,
      status: 'cited_unverified' as const,
    })),
  } satisfies ProposalEventRecord;
}

/** Frozen-Ledger read failures, mapped without guessing. */
function fromLedgerRead(error: unknown): never {
  if (error instanceof LedgerError) {
    if (error.code === 'unknown_owner') fail('unknown_binding');
    if (error.code === 'integrity_failure') fail('invalid_history');
    if (error.code === 'invalid_input') fail('invalid_request');
    if (error.code === 'transaction_active' || error.code === 'storage_failure')
      fail('storage_failure');
  }
  return fail('internal_error');
}

/**
 * Reads one page of the owner's recorded proposal events, oldest first.
 * The whole call fails closed with a fixed `ActionProposalError` (outcome
 * `not_written`) and returns no partial page: `invalid_request`,
 * `unknown_binding`, `invalid_history` (an event, projection or digest row
 * that fails validation or disagrees), `storage_failure` or
 * `internal_error`. It writes nothing and works on a `query_only`
 * connection.
 */
export function readProposalEvents(
  storage: Storage,
  ownerId: unknown,
  filter: unknown = {},
): ProposalEventPage {
  try {
    const owner = OwnerIdSchema.safeParse(ownerId);
    const copy = inertCopy(filter, ACTION_PROPOSALS_CONFIG.limits);
    if (!owner.success || copy === undefined) return fail('invalid_request');
    const f = FilterSchema.safeParse(copy.copy);
    if (!f.success) return fail('invalid_request');
    let page;
    try {
      page = createLedger(storage, owner.data).listEvents({
        ...f.data,
        eventType: 'action_proposed',
      });
    } catch (error) {
      return fromLedgerRead(error);
    }
    return deepFreeze({
      records: page.events.map((stored) =>
        classify(storage, owner.data, stored),
      ),
      throughSequence: page.throughSequence,
      nextCursor:
        page.nextCursor === null
          ? null
          : {
              afterSequence: page.nextCursor.afterSequence,
              throughSequence: page.nextCursor.throughSequence,
            },
    });
  } catch (error) {
    if (error instanceof ActionProposalError) throw error;
    throw new ActionProposalError('internal_error');
  }
}
