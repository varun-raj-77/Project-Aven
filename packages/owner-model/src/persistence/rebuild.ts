import {
  OwnerIdSchema,
  type ActiveTaskState,
  type DurableOwnerState,
  type LearningTransition,
  type OwnerId,
} from '@aven/contracts';
import { createLedger, type StoredEvent } from '@aven/ledger';
import { deserializeContract, type Storage } from '@aven/storage';
import {
  verifyLifecycleClaims,
  type VerifiedDurableLineage,
} from '../claims.ts';
import { OwnerModelError } from '../errors.ts';
import { intakeOwnerState, type OwnerStateIntake } from '../intake.ts';
import { buildDurableLineage } from '../lineage.ts';

/**
 * AVEN-009 patch 7: READ-ONLY owner-model rebuild over persisted snapshots
 * and owner-bound Ledger history (`@aven/owner-model/persistence`).
 *
 * "Rebuild" here means: the immutable durable and active-task snapshots
 * already stored for one owner, plus that owner's recorded Ledger history,
 * run through the accepted deterministic pipeline. It does NOT reconstruct
 * snapshots from events: no state is synthesized, written or applied.
 *
 *   ownerId (frozen OwnerIdSchema; anything else is `invalid_input`)
 *   -> owner-scoped snapshot reads (`WHERE owner_id = ?`, ordered by record
 *      ID and version, in one read transaction; frozen storage
 *      deserialization, no second parser)
 *   -> intakeOwnerState (Patch 2) -> buildDurableLineage (Patch 3)
 *   -> owner-bound Ledger: createLedger(storage, ownerId).replayEvents()
 *   -> owner-origin checks against that replay (below)
 *   -> verifyLifecycleClaims (Patch 4) with every recorded
 *      learning_promoted / _rejected / _superseded / _revoked /
 *      _rolled_back payload (claims are checked, never applied; candidate
 *      events are not transitions; the lifecycle_records projection is not
 *      read)
 *   -> { ownerId, intake, verified }.
 *
 * Owner-origin integrity (closes the frozen storage gap where a pointer must
 * only exist): every durable and active-task snapshot whose provenance is
 * explicit_owner_statement / explicit_owner_correction / owner_approval must
 * name a `sourceEventId` that this owner's Ledger records as owner_request /
 * owner_correction / owner_approval respectively. A durable snapshot whose
 * owner confirmation is `confirmed` / `disputed` must cite an owner_request /
 * owner_correction event of this owner whose recorded evidence contains that
 * exact evidence ID for that event. Nothing else (supporting evidence,
 * counterexamples, derivations, tool or external provenance) is checked.
 *
 * Errors: a malformed owner ID is `invalid_input`. Any storage, Ledger,
 * deserialization, unknown-owner or owner-origin failure, and any persisted
 * record intake rejects as input, is the fixed
 * `invalid_persisted_owner_model`. Fixed, sanitized Patch-2/3/4 owner-model
 * errors (identity, version order, lineage, lifecycle claims) keep their own
 * code. No error carries an ID, table, SQL, event type or cause.
 *
 * Read-only: SELECT statements only (each checked as read-only by SQLite),
 * Ledger reads only, no migration, append or transaction that writes. Only
 * this owner's rows are ever selected. Snapshot reads and Ledger replay are
 * separate read transactions (the Ledger refuses to run inside another), so
 * a consistent rebuild needs storage that is not being written concurrently.
 *
 * Root authority is not authenticated (transition `authority` remains
 * recorded data), and nothing selects trusted versions, takes a reference
 * time or task binding, or builds Context Broker candidates.
 */

export interface RebuiltOwnerModel {
  readonly ownerId: OwnerId;
  readonly intake: OwnerStateIntake;
  readonly verified: VerifiedDurableLineage;
}

const PRODUCED = new WeakSet<object>();

/** Whether `value` was produced by `rebuildOwnerModel` (internal). */
export function isRebuiltOwnerModel(
  value: unknown,
): value is RebuiltOwnerModel {
  return value !== null && typeof value === 'object' && PRODUCED.has(value);
}

/* Internal failure token, compared by identity only. */
const PERSISTED = Object.freeze({ token: 'persisted' });

const DURABLE_SNAPSHOTS =
  'SELECT record_json FROM learned_owner_state WHERE owner_id = ? ORDER BY record_id, record_version';
const ACTIVE_TASK_SNAPSHOTS =
  'SELECT record_json FROM active_task_state WHERE owner_id = ? ORDER BY record_id, record_version';

/** Ledger event types whose payloads are recorded learning transitions. */
const TRANSITION_EVENTS: ReadonlySet<string> = new Set([
  'learning_promoted',
  'learning_rejected',
  'learning_superseded',
  'learning_revoked',
  'learning_rolled_back',
]);

/** Owner-origin provenance kind -> the event type that must record it. */
const ORIGIN_EVENTS: ReadonlyMap<string, string> = new Map([
  ['explicit_owner_statement', 'owner_request'],
  ['explicit_owner_correction', 'owner_correction'],
  ['owner_approval', 'owner_approval'],
]);

/** Owner confirmation status -> the event type that must record it. */
const CONFIRMATION_EVENTS: ReadonlyMap<string, string> = new Map([
  ['confirmed', 'owner_request'],
  ['disputed', 'owner_correction'],
]);

/** Raw JSON of this owner's rows from one snapshot table (read-only). */
function snapshotRows(storage: Storage, sql: string, owner: OwnerId) {
  const statement = storage.sqlite.prepare(sql);
  if (!statement.readonly) throw PERSISTED;
  const rows = statement.all(owner) as { record_json: unknown }[];
  return rows.map((row) => {
    if (typeof row.record_json !== 'string') throw PERSISTED;
    return row.record_json;
  });
}

function readSnapshots(storage: Storage, owner: OwnerId): unknown[] {
  const [durable, active] = storage.sqlite
    .transaction(() => [
      snapshotRows(storage, DURABLE_SNAPSHOTS, owner),
      snapshotRows(storage, ACTIVE_TASK_SNAPSHOTS, owner),
    ])
    .deferred();
  const records: unknown[] = [];
  for (const json of durable!)
    records.push(deserializeContract('learned_owner_state', json));
  for (const json of active!)
    records.push(deserializeContract('active_task_state', json));
  return records;
}

/** This owner's recorded events by ID, and its recorded transitions. */
function replayHistory(storage: Storage, owner: OwnerId) {
  const ledger = createLedger(storage, owner);
  const events = new Map<string, StoredEvent>();
  const transitions: LearningTransition[] = [];
  for (const stored of ledger.replayEvents()) {
    const event = stored.event;
    if (event.ownerId !== owner || events.has(event.id)) throw PERSISTED;
    events.set(event.id, stored);
    if (TRANSITION_EVENTS.has(event.eventType))
      transitions.push(event.payload as LearningTransition);
  }
  return { events, transitions };
}

/** A snapshot's owner-origin provenance must be recorded as such. */
function checkOrigin(
  record: DurableOwnerState | ActiveTaskState,
  events: ReadonlyMap<string, StoredEvent>,
): void {
  const provenance = record.provenance;
  const expected = ORIGIN_EVENTS.get(provenance.kind);
  if (expected === undefined) return;
  if (!('sourceEventId' in provenance)) throw PERSISTED;
  const stored = events.get(provenance.sourceEventId);
  if (stored === undefined || stored.event.eventType !== expected)
    throw PERSISTED;
}

/** A durable snapshot's owner confirmation must cite recorded evidence. */
function checkConfirmation(
  record: DurableOwnerState,
  events: ReadonlyMap<string, StoredEvent>,
): void {
  const confirmation = record.evidence.ownerConfirmation;
  const expected = CONFIRMATION_EVENTS.get(confirmation.status);
  if (expected === undefined) return;
  if (!('evidence' in confirmation)) throw PERSISTED;
  const cited = confirmation.evidence;
  const stored = events.get(cited.eventId);
  if (
    stored === undefined ||
    stored.event.eventType !== expected ||
    !stored.evidence.some(
      (e) => e.id === cited.evidenceId && e.eventId === cited.eventId,
    )
  )
    throw PERSISTED;
}

/**
 * Read-only rebuild of one owner's model from persisted snapshots and that
 * owner's Ledger history. Throws `OwnerModelError` with a fixed code.
 */
export function rebuildOwnerModel(
  storage: Storage,
  ownerId: OwnerId,
): RebuiltOwnerModel {
  if (
    storage === null ||
    typeof storage !== 'object' ||
    typeof ownerId !== 'string' ||
    !OwnerIdSchema.safeParse(ownerId).success
  )
    throw new OwnerModelError('invalid_input');
  const owner = ownerId;
  try {
    const intake = intakeOwnerState({
      ownerId: owner,
      records: readSnapshots(storage, owner),
    });
    const lineage = buildDurableLineage(intake);
    const { events, transitions } = replayHistory(storage, owner);
    for (const record of intake.durable) {
      checkOrigin(record, events);
      checkConfirmation(record, events);
    }
    for (const record of intake.activeTasks) checkOrigin(record, events);
    const verified = verifyLifecycleClaims(lineage, transitions);

    const rebuilt = Object.create(null) as {
      ownerId: OwnerId;
      intake: OwnerStateIntake;
      verified: VerifiedDurableLineage;
    };
    rebuilt.ownerId = owner;
    rebuilt.intake = intake;
    rebuilt.verified = verified;
    PRODUCED.add(Object.freeze(rebuilt));
    return rebuilt;
  } catch (thrown) {
    // Fixed owner-model errors keep their code; persisted records rejected
    // as input and every storage or Ledger failure become the one fixed
    // persisted-integrity error. Nothing of the thrown value is kept.
    if (thrown instanceof OwnerModelError && thrown.code !== 'invalid_input')
      throw new OwnerModelError(thrown.code);
    throw new OwnerModelError('invalid_persisted_owner_model');
  }
}
